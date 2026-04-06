use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

const JOB_EVENT: &str = "job-update";
const QUEUE_EVENT: &str = "queue-update";
const DOWNLOAD_EVENT: &str = "download-update";
const CANCELLED_SENTINEL: &str = "__cancelled__";
const YTDLP_NIGHTLY_WINDOWS_URL: &str =
    "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe";
const YTDLP_STABLE_WINDOWS_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const YTDLP_REFRESH_INTERVAL_SECONDS: u64 = 60 * 60 * 24;
static JOB_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum OutputFormat {
    Gif,
    Mp4,
    Webm,
}

impl OutputFormat {
    fn extension(&self) -> &'static str {
        match self {
            Self::Gif => "gif",
            Self::Mp4 => "mp4",
            Self::Webm => "webm",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncodeJobRequest {
    input_path: String,
    output_dir: Option<String>,
    output_name: Option<String>,
    format: OutputFormat,
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
    fps: u32,
    width: u32,
    quality: u8,
    include_audio: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncodingPreset {
    id: String,
    name: String,
    format: OutputFormat,
    fps: u32,
    width: u32,
    quality: u8,
    include_audio: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobUpdatePayload {
    job_id: String,
    status: String,
    progress: Option<f64>,
    eta_seconds: Option<f64>,
    speed: Option<String>,
    message: Option<String>,
    input_path: String,
    output_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QueueSnapshot {
    queued_job_ids: Vec<String>,
    running_job_ids: Vec<String>,
    max_concurrent: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegStatus {
    available: bool,
    ffmpeg_path: String,
    ffprobe_path: String,
    version: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadVideoResult {
    url: String,
    title: String,
    output_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadUpdatePayload {
    url: String,
    status: String,
    progress: Option<f64>,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoProbeResult {
    url: String,
    title: String,
    thumbnail_url: Option<String>,
    duration: Option<String>,
}

#[derive(Debug, Clone)]
struct EncodeJob {
    id: String,
    request: EncodeJobRequest,
    output_path: String,
}

#[derive(Clone)]
struct RunningJob {
    cancel_flag: Arc<AtomicBool>,
    input_path: String,
    output_path: String,
}

#[derive(Default)]
struct JobStore {
    queue: VecDeque<EncodeJob>,
    running: HashMap<String, RunningJob>,
    max_concurrent: usize,
}

struct AppState {
    jobs: Arc<Mutex<JobStore>>,
}

enum ProcessLine {
    Stdout(String),
    Stderr(String),
}

#[tauri::command]
fn get_default_presets() -> Vec<EncodingPreset> {
    default_presets()
}

#[tauri::command]
fn load_saved_presets(app: AppHandle) -> Result<Vec<EncodingPreset>, String> {
    let path = preset_file_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents =
        fs::read_to_string(&path).map_err(|err| format!("프리셋 파일을 읽지 못했습니다: {err}"))?;
    serde_json::from_str::<Vec<EncodingPreset>>(&contents)
        .map_err(|err| format!("프리셋 파일 형식이 잘못되었습니다: {err}"))
}

#[tauri::command]
fn save_presets(app: AppHandle, presets: Vec<EncodingPreset>) -> Result<(), String> {
    let path = preset_file_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("프리셋 디렉토리 생성 실패: {err}"))?;
    }

    let serialized =
        serde_json::to_string_pretty(&presets).map_err(|err| format!("프리셋 직렬화 실패: {err}"))?;
    fs::write(path, serialized).map_err(|err| format!("프리셋 저장 실패: {err}"))
}

#[tauri::command]
fn check_ffmpeg_status(app: AppHandle) -> FfmpegStatus {
    let ffmpeg_path = match resolve_bundled_binary_path(&app, "ffmpeg") {
        Ok(path) => path,
        Err(message) => {
            return FfmpegStatus {
                available: false,
                ffmpeg_path: "(missing)".to_string(),
                ffprobe_path: "(missing)".to_string(),
                version: None,
                message: Some(message),
            };
        }
    };

    let ffprobe_path = match resolve_bundled_binary_path(&app, "ffprobe") {
        Ok(path) => path,
        Err(message) => {
            return FfmpegStatus {
                available: false,
                ffmpeg_path,
                ffprobe_path: "(missing)".to_string(),
                version: None,
                message: Some(message),
            };
        }
    };

    match Command::new(&ffmpeg_path)
        .arg("-version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .map(str::to_owned);
                FfmpegStatus {
                    available: true,
                    ffmpeg_path,
                    ffprobe_path,
                    version,
                    message: None,
                }
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                FfmpegStatus {
                    available: false,
                    ffmpeg_path,
                    ffprobe_path,
                    version: None,
                    message: Some(if stderr.is_empty() {
                        "Bundled FFmpeg failed to execute.".to_string()
                    } else {
                        stderr
                    }),
                }
            }
        }
        Err(err) => FfmpegStatus {
            available: false,
            ffmpeg_path,
            ffprobe_path,
            version: None,
            message: Some(format!("Bundled FFmpeg is not executable: {err}")),
        },
    }
}

#[tauri::command]
async fn probe_video_url(app: AppHandle, url: String) -> Result<VideoProbeResult, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Enter a URL first.".to_string());
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("URL must start with http:// or https://.".to_string());
    }

    let url_owned = trimmed.to_string();
    let app_for_worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ytdlp_path = ensure_yt_dlp_binary(&app_for_worker, false)?;
        run_yt_dlp_probe(&ytdlp_path, &url_owned)
    })
    .await
    .map_err(|err| format!("Failed to run metadata probe task: {err}"))?
}

#[tauri::command]
async fn download_video_from_url(app: AppHandle, url: String) -> Result<DownloadVideoResult, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Enter a URL first.".to_string());
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("URL must start with http:// or https://.".to_string());
    }

    let output_dir = staging_output_dir(&app)?;
    fs::create_dir_all(&output_dir)
        .map_err(|err| format!("Failed to create download staging directory: {err}"))?;

    let ffmpeg_path = resolve_bundled_binary_path(&app, "ffmpeg").ok();
    emit_download_update(
        &app,
        DownloadUpdatePayload {
            url: trimmed.to_string(),
            status: "starting".to_string(),
            progress: Some(0.0),
            message: Some("Preparing download...".to_string()),
        },
    );

    let url_owned = trimmed.to_string();
    let first_attempt = {
        let app_for_worker = app.clone();
        let output_dir_for_worker = output_dir.clone();
        let ffmpeg_path_for_worker = ffmpeg_path.clone();
        let url_for_worker = url_owned.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let ytdlp_path = ensure_yt_dlp_binary(&app_for_worker, false)?;
            run_yt_dlp_download(
                &app_for_worker,
                &ytdlp_path,
                &url_for_worker,
                &output_dir_for_worker,
                ffmpeg_path_for_worker.as_deref(),
            )
        })
        .await
        .map_err(|err| format!("Failed to run download task: {err}"))?
    };

    match first_attempt {
        Ok(result) => {
            emit_download_update(
                &app,
                DownloadUpdatePayload {
                    url: url_owned.clone(),
                    status: "completed".to_string(),
                    progress: Some(100.0),
                    message: Some("Download complete.".to_string()),
                },
            );
            Ok(result)
        }
        Err(first_error) => {
            let retry_due_to_forbidden = first_error.contains("403")
                || first_error.contains("Forbidden")
                || first_error.contains("HTTP Error");

            if !retry_due_to_forbidden {
                emit_download_update(
                    &app,
                    DownloadUpdatePayload {
                        url: url_owned.clone(),
                        status: "failed".to_string(),
                        progress: None,
                        message: Some(first_error.clone()),
                    },
                );
                return Err(first_error);
            }

            let retry_attempt = {
                let app_for_worker = app.clone();
                let output_dir_for_worker = output_dir.clone();
                let ffmpeg_path_for_worker = ffmpeg_path.clone();
                let url_for_worker = url_owned.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let ytdlp_path = ensure_yt_dlp_binary(&app_for_worker, true)?;
                    run_yt_dlp_download(
                        &app_for_worker,
                        &ytdlp_path,
                        &url_for_worker,
                        &output_dir_for_worker,
                        ffmpeg_path_for_worker.as_deref(),
                    )
                })
                .await
                .map_err(|err| format!("Failed to run retry download task: {err}"))?
            };

            retry_attempt
            .map(|result| {
                emit_download_update(
                    &app,
                    DownloadUpdatePayload {
                        url: url_owned.clone(),
                        status: "completed".to_string(),
                        progress: Some(100.0),
                        message: Some("Download complete.".to_string()),
                    },
                );
                result
            })
            .map_err(|second_error| {
                let message = format!(
                    "Video download failed after yt-dlp refresh.\nFirst attempt: {first_error}\nSecond attempt: {second_error}"
                );
                emit_download_update(
                    &app,
                    DownloadUpdatePayload {
                        url: url_owned.clone(),
                        status: "failed".to_string(),
                        progress: None,
                        message: Some(message.clone()),
                    },
                );
                message
            })
        }
    }
}

#[tauri::command]
fn trim_downloaded_video(
    app: AppHandle,
    input_path: String,
    start_seconds: f64,
    end_seconds: f64,
) -> Result<String, String> {
    let trimmed_input = input_path.trim();
    if trimmed_input.is_empty() {
        return Err("Input file path is required.".to_string());
    }
    if !start_seconds.is_finite() || !end_seconds.is_finite() {
        return Err("Start/end time must be valid numbers.".to_string());
    }
    if start_seconds < 0.0 {
        return Err("Start time must be 0 or greater.".to_string());
    }
    if end_seconds <= start_seconds {
        return Err("End time must be greater than start time.".to_string());
    }

    let source_path = PathBuf::from(trimmed_input);
    if !source_path.exists() || !source_path.is_file() {
        return Err("Input file does not exist.".to_string());
    }

    let staging_dir = staging_output_dir(&app)?;
    fs::create_dir_all(&staging_dir)
        .map_err(|err| format!("Failed to access staging directory: {err}"))?;
    let staging_root = fs::canonicalize(&staging_dir)
        .map_err(|err| format!("Failed to resolve staging directory: {err}"))?;
    let source_root = fs::canonicalize(&source_path)
        .map_err(|err| format!("Failed to resolve input file path: {err}"))?;
    if !source_root.starts_with(&staging_root) {
        return Err("Only files in the app staging area can be trimmed.".to_string());
    }

    let source_name = source_path
        .file_stem()
        .map(|value| sanitize_filename(&value.to_string_lossy()))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "output".to_string());
    let output_name = format!("{source_name}_trim.mp4");
    let output_path = ensure_unique_file_path(&staging_dir, &output_name)?;

    let ffmpeg_path = resolve_bundled_binary_path(&app, "ffmpeg")?;
    let output = Command::new(ffmpeg_path)
        .arg("-hide_banner")
        .arg("-y")
        .arg("-ss")
        .arg(format!("{start_seconds:.3}"))
        .arg("-to")
        .arg(format!("{end_seconds:.3}"))
        .arg("-i")
        .arg(trimmed_input)
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("medium")
        .arg("-crf")
        .arg("22")
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("128k")
        .arg("-movflags")
        .arg("+faststart")
        .arg(output_path.to_string_lossy().to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("Failed to run FFmpeg trim command: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "FFmpeg trim command failed.".to_string()
        } else {
            stderr
        });
    }

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
fn enqueue_encode_job(
    app: AppHandle,
    state: State<AppState>,
    request: EncodeJobRequest,
) -> Result<String, String> {
    validate_request(&request)?;

    let job_id = next_job_id();
    let output_path = build_staging_output_path(&app, &request)?;
    let job = EncodeJob {
        id: job_id.clone(),
        request,
        output_path: output_path.clone(),
    };

    {
        let mut store = lock_jobs(&state.jobs);
        if store.max_concurrent == 0 {
            store.max_concurrent = 1;
        }
        store.queue.push_back(job.clone());
    }

    emit_job_update(
        &app,
        JobUpdatePayload {
            job_id: job_id.clone(),
            status: "queued".to_string(),
            progress: Some(0.0),
            eta_seconds: None,
            speed: None,
            message: Some("작업이 큐에 등록되었습니다.".to_string()),
            input_path: job.request.input_path.clone(),
            output_path,
        },
    );

    emit_queue_snapshot(&app, &state.jobs);
    schedule_jobs(app, state.jobs.clone());

    Ok(job_id)
}

#[tauri::command]
fn save_outputs(
    app: AppHandle,
    destination_dir: String,
    staged_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let trimmed_destination = destination_dir.trim();
    if trimmed_destination.is_empty() {
        return Err("저장할 폴더를 선택해주세요.".to_string());
    }
    if staged_paths.is_empty() {
        return Err("저장할 결과 파일이 없습니다.".to_string());
    }

    let destination_path = PathBuf::from(trimmed_destination);
    fs::create_dir_all(&destination_path)
        .map_err(|err| format!("저장 폴더 생성 실패: {err}"))?;

    if !destination_path.is_dir() {
        return Err("선택한 저장 경로가 폴더가 아닙니다.".to_string());
    }

    let staging_dir = staging_output_dir(&app)?;
    fs::create_dir_all(&staging_dir).map_err(|err| format!("임시 폴더 생성 실패: {err}"))?;
    let staging_root = fs::canonicalize(&staging_dir)
        .map_err(|err| format!("임시 폴더 확인 실패: {err}"))?;

    let mut saved_paths: Vec<String> = Vec::with_capacity(staged_paths.len());
    for source in staged_paths {
        let source_trimmed = source.trim();
        if source_trimmed.is_empty() {
            continue;
        }

        let source_path = PathBuf::from(source_trimmed);
        if !source_path.exists() {
            return Err(format!("임시 파일을 찾을 수 없습니다: {source_trimmed}"));
        }

        let source_canonical = fs::canonicalize(&source_path)
            .map_err(|err| format!("임시 파일 경로 확인 실패: {err}"))?;
        if !source_canonical.starts_with(&staging_root) {
            return Err(format!(
                "앱 임시 저장소 외부 파일은 저장할 수 없습니다: {}",
                source_path.to_string_lossy()
            ));
        }

        let file_name = source_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .ok_or_else(|| "임시 파일 이름을 확인할 수 없습니다.".to_string())?;

        let target_path = ensure_unique_file_path(&destination_path, &file_name)?;
        fs::copy(&source_path, &target_path).map_err(|err| {
            format!(
                "파일 저장 실패 ({}): {err}",
                source_path.to_string_lossy()
            )
        })?;

        saved_paths.push(target_path.to_string_lossy().to_string());
    }

    if saved_paths.is_empty() {
        return Err("저장할 결과 파일이 없습니다.".to_string());
    }

    Ok(saved_paths)
}

#[tauri::command]
fn clear_staging_outputs(app: AppHandle) -> Result<u32, String> {
    let staging_dir = staging_output_dir(&app)?;
    if !staging_dir.exists() {
        return Ok(0);
    }

    let entries = fs::read_dir(&staging_dir)
        .map_err(|err| format!("Failed to read staging directory: {err}"))?;

    let mut removed_count: u32 = 0;
    for entry in entries {
        let entry = entry.map_err(|err| format!("Failed to read staging entry: {err}"))?;
        let path = entry.path();

        if path.is_dir() {
            fs::remove_dir_all(&path)
                .map_err(|err| format!("Failed to remove staged directory: {err}"))?;
        } else if path.exists() {
            fs::remove_file(&path).map_err(|err| format!("Failed to remove staged file: {err}"))?;
        }

        removed_count = removed_count.saturating_add(1);
    }

    Ok(removed_count)
}

#[tauri::command]
fn remove_staged_file(app: AppHandle, staged_path: String) -> Result<(), String> {
    let trimmed = staged_path.trim();
    if trimmed.is_empty() {
        return Err("Staged file path is required.".to_string());
    }

    let staging_dir = staging_output_dir(&app)?;
    fs::create_dir_all(&staging_dir)
        .map_err(|err| format!("Failed to access staging directory: {err}"))?;
    let staging_root = fs::canonicalize(&staging_dir)
        .map_err(|err| format!("Failed to resolve staging directory: {err}"))?;

    let source_path = PathBuf::from(trimmed);
    if !source_path.exists() {
        return Ok(());
    }
    if source_path.is_dir() {
        return Err("Directory removal is not allowed for staged file deletion.".to_string());
    }

    let source_root = fs::canonicalize(&source_path)
        .map_err(|err| format!("Failed to resolve staged file path: {err}"))?;
    if !source_root.starts_with(&staging_root) {
        return Err("Only files in the app staging area can be deleted.".to_string());
    }

    fs::remove_file(&source_root).map_err(|err| format!("Failed to remove staged file: {err}"))?;
    Ok(())
}

#[tauri::command]
fn cancel_encode_job(app: AppHandle, state: State<AppState>, job_id: String) -> Result<(), String> {
    let mut queued_job: Option<EncodeJob> = None;
    let mut running_job: Option<RunningJob> = None;

    {
        let mut store = lock_jobs(&state.jobs);

        if let Some(index) = store.queue.iter().position(|job| job.id == job_id) {
            queued_job = store.queue.remove(index);
        } else if let Some(running) = store.running.get(&job_id) {
            running.cancel_flag.store(true, Ordering::Relaxed);
            running_job = Some(running.clone());
        } else {
            return Err("해당 작업 ID를 찾을 수 없습니다.".to_string());
        }
    }

    if let Some(job) = queued_job {
        emit_job_update(
            &app,
            JobUpdatePayload {
                job_id,
                status: "cancelled".to_string(),
                progress: None,
                eta_seconds: None,
                speed: None,
                message: Some("대기 중인 작업을 취소했습니다.".to_string()),
                input_path: job.request.input_path,
                output_path: job.output_path,
            },
        );
    } else if let Some(job) = running_job {
        emit_job_update(
            &app,
            JobUpdatePayload {
                job_id,
                status: "cancelling".to_string(),
                progress: None,
                eta_seconds: None,
                speed: None,
                message: Some("실행 중 작업 취소를 요청했습니다.".to_string()),
                input_path: job.input_path,
                output_path: job.output_path,
            },
        );
    }

    emit_queue_snapshot(&app, &state.jobs);
    Ok(())
}

#[tauri::command]
fn get_queue_snapshot(state: State<AppState>) -> QueueSnapshot {
    let store = lock_jobs(&state.jobs);
    snapshot_from_store(&store)
}

#[tauri::command]
fn set_queue_limit(
    app: AppHandle,
    state: State<AppState>,
    limit: usize,
) -> Result<QueueSnapshot, String> {
    if !(1..=4).contains(&limit) {
        return Err("동시 작업 수는 1~4 사이로 설정해주세요.".to_string());
    }

    {
        let mut store = lock_jobs(&state.jobs);
        store.max_concurrent = limit;
    }

    schedule_jobs(app.clone(), state.jobs.clone());
    let snapshot = {
        let store = lock_jobs(&state.jobs);
        snapshot_from_store(&store)
    };
    emit_queue_snapshot(&app, &state.jobs);
    Ok(snapshot)
}

fn schedule_jobs(app: AppHandle, jobs: Arc<Mutex<JobStore>>) {
    loop {
        let maybe_start = {
            let mut store = lock_jobs(&jobs);
            if store.running.len() >= store.max_concurrent {
                None
            } else {
                store.queue.pop_front().map(|job| {
                    let cancel_flag = Arc::new(AtomicBool::new(false));
                    store.running.insert(
                        job.id.clone(),
                        RunningJob {
                            cancel_flag: cancel_flag.clone(),
                            input_path: job.request.input_path.clone(),
                            output_path: job.output_path.clone(),
                        },
                    );
                    (job, cancel_flag)
                })
            }
        };

        match maybe_start {
            Some((job, cancel_flag)) => {
                let app_for_task = app.clone();
                let jobs_for_task = jobs.clone();
                tauri::async_runtime::spawn(async move {
                    run_job(app_for_task.clone(), job.clone(), cancel_flag).await;
                    {
                        let mut store = lock_jobs(&jobs_for_task);
                        store.running.remove(&job.id);
                    }
                    emit_queue_snapshot(&app_for_task, &jobs_for_task);
                    schedule_jobs(app_for_task, jobs_for_task);
                });
            }
            None => break,
        }
    }

    emit_queue_snapshot(&app, &jobs);
}

async fn run_job(app: AppHandle, job: EncodeJob, cancel_flag: Arc<AtomicBool>) {
    emit_job_update(
        &app,
        JobUpdatePayload {
            job_id: job.id.clone(),
            status: "running".to_string(),
            progress: Some(0.0),
            eta_seconds: None,
            speed: None,
            message: Some("인코딩을 시작합니다.".to_string()),
            input_path: job.request.input_path.clone(),
            output_path: job.output_path.clone(),
        },
    );

    let ffmpeg_path = match resolve_bundled_binary_path(&app, "ffmpeg") {
        Ok(path) => path,
        Err(message) => {
            emit_job_update(
                &app,
                JobUpdatePayload {
                    job_id: job.id.clone(),
                    status: "failed".to_string(),
                    progress: None,
                    eta_seconds: None,
                    speed: None,
                    message: Some(message),
                    input_path: job.request.input_path.clone(),
                    output_path: job.output_path.clone(),
                },
            );
            return;
        }
    };
    let ffprobe_path = match resolve_bundled_binary_path(&app, "ffprobe") {
        Ok(path) => path,
        Err(message) => {
            emit_job_update(
                &app,
                JobUpdatePayload {
                    job_id: job.id.clone(),
                    status: "failed".to_string(),
                    progress: None,
                    eta_seconds: None,
                    speed: None,
                    message: Some(message),
                    input_path: job.request.input_path.clone(),
                    output_path: job.output_path.clone(),
                },
            );
            return;
        }
    };
    let clip_duration = compute_clip_duration(&ffprobe_path, &job.request);

    let app_for_worker = app.clone();
    let job_for_worker = job.clone();
    let cancel_for_worker = cancel_flag.clone();
    let ffmpeg_for_worker = ffmpeg_path.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        execute_ffmpeg(
            app_for_worker,
            job_for_worker,
            ffmpeg_for_worker,
            clip_duration,
            cancel_for_worker,
        )
    })
    .await
    .unwrap_or_else(|err| Err(format!("작업 스레드 오류: {err}")));

    match result {
        Ok(()) => emit_job_update(
            &app,
            JobUpdatePayload {
                job_id: job.id,
                status: "completed".to_string(),
                progress: Some(1.0),
                eta_seconds: Some(0.0),
                speed: None,
                message: Some("변환이 완료되었습니다.".to_string()),
                input_path: job.request.input_path,
                output_path: job.output_path,
            },
        ),
        Err(err) if err == CANCELLED_SENTINEL => emit_job_update(
            &app,
            JobUpdatePayload {
                job_id: job.id,
                status: "cancelled".to_string(),
                progress: None,
                eta_seconds: None,
                speed: None,
                message: Some("작업이 취소되었습니다.".to_string()),
                input_path: job.request.input_path,
                output_path: job.output_path,
            },
        ),
        Err(err) => emit_job_update(
            &app,
            JobUpdatePayload {
                job_id: job.id,
                status: "failed".to_string(),
                progress: None,
                eta_seconds: None,
                speed: None,
                message: Some(err),
                input_path: job.request.input_path,
                output_path: job.output_path,
            },
        ),
    }
}

fn execute_ffmpeg(
    app: AppHandle,
    job: EncodeJob,
    ffmpeg_path: String,
    clip_duration: Option<f64>,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    let args = build_ffmpeg_args(&job);

    let mut command = Command::new(ffmpeg_path);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|err| format!("FFmpeg 실행 실패: {err}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "FFmpeg stdout 파이프를 열지 못했습니다.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "FFmpeg stderr 파이프를 열지 못했습니다.".to_string())?;

    let (tx, rx) = mpsc::channel::<ProcessLine>();

    let tx_stdout = tx.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = tx_stdout.send(ProcessLine::Stdout(line));
        }
    });

    let tx_stderr = tx.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = tx_stderr.send(ProcessLine::Stderr(line));
        }
    });

    drop(tx);

    let started_at = Instant::now();
    let mut out_time_ms: u64 = 0;
    let mut speed: Option<String> = None;
    let mut stderr_tail: VecDeque<String> = VecDeque::new();
    let mut pending_progress = false;

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CANCELLED_SENTINEL.to_string());
        }

        while let Ok(line) = rx.try_recv() {
            match line {
                ProcessLine::Stdout(data) => {
                    if let Some((key, value)) = data.split_once('=') {
                        match key.trim() {
                            "out_time_ms" => {
                                out_time_ms = value.trim().parse::<u64>().unwrap_or(out_time_ms);
                            }
                            "speed" => {
                                speed = Some(value.trim().to_string());
                            }
                            "progress" if value.trim() == "continue" => {
                                pending_progress = true;
                            }
                            "progress" if value.trim() == "end" => {
                                pending_progress = true;
                            }
                            _ => {}
                        }
                    }
                }
                ProcessLine::Stderr(data) => {
                    if stderr_tail.len() >= 12 {
                        stderr_tail.pop_front();
                    }
                    stderr_tail.push_back(data);
                }
            }
        }

        if pending_progress {
            let progress = clip_duration.map(|total| {
                let current = out_time_ms as f64 / 1_000_000.0;
                (current / total.max(0.001)).clamp(0.0, 0.99)
            });
            let eta_seconds = progress.and_then(|value| estimate_eta_seconds(value, started_at.elapsed()));
            emit_job_update(
                &app,
                JobUpdatePayload {
                    job_id: job.id.clone(),
                    status: "progress".to_string(),
                    progress,
                    eta_seconds,
                    speed: speed.clone(),
                    message: None,
                    input_path: job.request.input_path.clone(),
                    output_path: job.output_path.clone(),
                },
            );
            pending_progress = false;
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                let stderr_message = if stderr_tail.is_empty() {
                    format!("FFmpeg 종료 코드: {:?}", status.code())
                } else {
                    stderr_tail.into_iter().collect::<Vec<_>>().join("\n")
                };
                return Err(stderr_message);
            }
            Ok(None) => {
                thread::sleep(Duration::from_millis(160));
            }
            Err(err) => {
                return Err(format!("FFmpeg 상태 확인 실패: {err}"));
            }
        }
    }
}

fn build_ffmpeg_args(job: &EncodeJob) -> Vec<String> {
    let width = job.request.width.max(64);
    let fps = job.request.fps.clamp(1, 60);
    let quality = job.request.quality.clamp(1, 100);
    let mp4_crf = map_quality_to_crf(quality, 18, 48);
    let webm_crf = map_quality_to_crf(quality, 20, 50);
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-y".into()];

    if let Some(start) = job.request.start_seconds {
        if start > 0.0 {
            args.push("-ss".into());
            args.push(format!("{start:.3}"));
        }
    }

    args.push("-i".into());
    args.push(job.request.input_path.clone());

    if let Some(duration) = requested_duration(&job.request) {
        if duration > 0.0 {
            args.push("-t".into());
            args.push(format!("{duration:.3}"));
        }
    }

    match job.request.format {
        OutputFormat::Gif => {
            let filter = format!(
                "fps={fps},scale={width}:-1:flags=lanczos,split[v1][v2];[v1]palettegen=stats_mode=diff[p];[v2][p]paletteuse=dither=bayer:bayer_scale=5"
            );
            args.push("-filter_complex".into());
            args.push(filter);
            args.push("-loop".into());
            args.push("0".into());
            args.push("-an".into());
        }
        OutputFormat::Mp4 => {
            args.push("-vf".into());
            args.push(format!("fps={fps},scale={width}:-2:flags=lanczos"));
            args.push("-c:v".into());
            args.push("libx264".into());
            args.push("-preset".into());
            args.push("medium".into());
            args.push("-crf".into());
            args.push(mp4_crf.to_string());
            args.push("-pix_fmt".into());
            args.push("yuv420p".into());
            args.push("-movflags".into());
            args.push("+faststart".into());
            if job.request.include_audio {
                args.push("-c:a".into());
                args.push("aac".into());
                args.push("-b:a".into());
                args.push("128k".into());
            } else {
                args.push("-an".into());
            }
        }
        OutputFormat::Webm => {
            args.push("-vf".into());
            args.push(format!("fps={fps},scale={width}:-2:flags=lanczos"));
            args.push("-c:v".into());
            args.push("libvpx-vp9".into());
            args.push("-b:v".into());
            args.push("0".into());
            args.push("-crf".into());
            args.push(webm_crf.to_string());
            args.push("-row-mt".into());
            args.push("1".into());
            if job.request.include_audio {
                args.push("-c:a".into());
                args.push("libopus".into());
                args.push("-b:a".into());
                args.push("96k".into());
            } else {
                args.push("-an".into());
            }
        }
    }

    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(job.output_path.clone());

    args
}

fn run_yt_dlp_download(
    app: &AppHandle,
    ytdlp_path: &Path,
    url: &str,
    output_dir: &Path,
    ffmpeg_path: Option<&str>,
) -> Result<DownloadVideoResult, String> {
    let download_started_at = SystemTime::now();
    let mut command = Command::new(ytdlp_path);
    command
        .arg("--ignore-config")
        .arg("--encoding")
        .arg("utf-8")
        .arg("--no-playlist")
        .arg("--no-warnings")
        .arg("--no-simulate")
        .arg("--newline")
        .arg("--progress-template")
        .arg("download:%(progress._percent_str)s")
        .arg("--paths")
        .arg(output_dir.to_string_lossy().to_string())
        .arg("--output")
        .arg("%(title).180B [%(id)s].%(ext)s")
        .arg("--format")
        .arg("bv*+ba/b")
        .arg("--merge-output-format")
        .arg("mp4")
        .arg("--force-ipv4");

    if let Some(path) = ffmpeg_path {
        command.arg("--ffmpeg-location").arg(path);
    }

    command
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|err| format!("Failed to run yt-dlp: {err}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture yt-dlp stdout.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture yt-dlp stderr.".to_string())?;

    let (tx, rx) = mpsc::channel::<ProcessLine>();
    let tx_stdout = tx.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = tx_stdout.send(ProcessLine::Stdout(line));
        }
    });
    let tx_stderr = tx.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = tx_stderr.send(ProcessLine::Stderr(line));
        }
    });
    drop(tx);

    let mut stdout_lines: Vec<String> = Vec::new();
    let mut stderr_tail: VecDeque<String> = VecDeque::new();
    let mut observed_output_paths: Vec<String> = Vec::new();
    let mut last_emitted_progress: f64 = -1.0;
    let mut last_activity_at = Instant::now();

    loop {
        while let Ok(line) = rx.try_recv() {
            last_activity_at = Instant::now();
            match line {
                ProcessLine::Stdout(data) => {
                    if let Some(candidate) = extract_ytdlp_output_path_candidate(&data) {
                        observed_output_paths.push(candidate);
                    }
                    stdout_lines.push(data);
                }
                ProcessLine::Stderr(data) => {
                    if let Some(progress) = extract_ytdlp_progress(&data) {
                        if (progress - last_emitted_progress).abs() >= 0.5
                            || (100.0 - progress).abs() <= 0.01
                        {
                            emit_download_update(
                                app,
                                DownloadUpdatePayload {
                                    url: url.to_string(),
                                    status: "progress".to_string(),
                                    progress: Some(progress),
                                    message: None,
                                },
                            );
                            last_emitted_progress = progress;
                        }
                    }

                    if let Some(candidate) = extract_ytdlp_output_path_candidate(&data) {
                        observed_output_paths.push(candidate);
                    }

                    if stderr_tail.len() >= 20 {
                        stderr_tail.pop_front();
                    }
                    stderr_tail.push_back(data);
                }
            }
        }

        if last_activity_at.elapsed() > Duration::from_secs(120) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "Download timed out after 120 seconds with no progress. Please retry.".to_string(),
            );
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    if !stderr_tail.is_empty() {
                        return Err(stderr_tail.into_iter().collect::<Vec<_>>().join("\n"));
                    }
                    if !stdout_lines.is_empty() {
                        return Err(stdout_lines.join("\n"));
                    }
                    return Err(format!(
                        "yt-dlp exited with status code {:?}",
                        status.code()
                    ));
                }
                break;
            }
            Ok(None) => {
                thread::sleep(Duration::from_millis(120));
            }
            Err(err) => return Err(format!("Failed to check yt-dlp process status: {err}")),
        }
    }

    let output_path = resolve_download_output_path(
        output_dir,
        &observed_output_paths,
        download_started_at,
    )
    .ok_or_else(|| {
        if observed_output_paths.is_empty() {
            return "Download finished but no output file path was detected.".to_string();
        }
        format!(
            "Download finished but output file does not exist. Observed paths: {}",
            observed_output_paths.join(" | ")
        )
    })?;
    if !output_path.exists() {
        return Err(format!(
            "Download finished but output file does not exist: {}",
            output_path.to_string_lossy()
        ));
    }
    let title = derive_title_from_download_path(&output_path);

    Ok(DownloadVideoResult {
        url: url.to_string(),
        title,
        output_path: output_path.to_string_lossy().to_string(),
    })
}

fn derive_title_from_download_path(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Downloaded video".to_string());

    if let Some(index) = stem.rfind(" [") {
        if stem.ends_with(']') {
            let trimmed = stem[..index].trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }

    stem.trim().to_string()
}

fn resolve_download_output_path(
    output_dir: &Path,
    observed_paths: &[String],
    download_started_at: SystemTime,
) -> Option<PathBuf> {
    for candidate in observed_paths.iter().rev() {
        let raw = candidate.trim().trim_matches('"').trim_matches('\'').trim();
        if raw.is_empty() {
            continue;
        }

        let candidate_path = PathBuf::from(raw);
        let resolved = if candidate_path.is_absolute() {
            candidate_path
        } else {
            output_dir.join(candidate_path)
        };
        if resolved.exists() && resolved.is_file() {
            return Some(resolved);
        }
    }

    let mut fallback: Option<(SystemTime, PathBuf)> = None;
    let entries = fs::read_dir(output_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_supported_download_file(&path) {
            continue;
        }

        let modified = match entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
        {
            Some(value) => value,
            None => continue,
        };
        if let Ok(age) = download_started_at.duration_since(modified) {
            if age > Duration::from_secs(10) {
                continue;
            }
        }

        match &fallback {
            Some((existing_modified, _)) if modified <= *existing_modified => {}
            _ => fallback = Some((modified, path)),
        }
    }

    fallback.map(|(_, path)| path)
}

fn is_supported_download_file(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());

    matches!(
        extension.as_deref(),
        Some("mp4")
            | Some("webm")
            | Some("mkv")
            | Some("mov")
            | Some("m4v")
            | Some("avi")
            | Some("flv")
            | Some("wmv")
            | Some("gif")
    )
}

fn extract_ytdlp_output_path_candidate(line: &str) -> Option<String> {
    let cleaned = line.trim();
    if cleaned.is_empty() {
        return None;
    }

    if let Some(value) = cleaned.strip_prefix("[download] Destination:") {
        let candidate = value.trim();
        if !candidate.is_empty() {
            return Some(candidate.to_string());
        }
    }

    if let Some(value) = cleaned
        .strip_prefix("[download] ")
        .and_then(|data| data.strip_suffix(" has already been downloaded"))
    {
        let candidate = value.trim();
        if !candidate.is_empty() {
            return Some(candidate.to_string());
        }
    }

    if let Some(candidate) = extract_quoted_path(cleaned, "Merging formats into ") {
        return Some(candidate);
    }

    None
}

fn extract_quoted_path(input: &str, marker: &str) -> Option<String> {
    let marker_index = input.find(marker)?;
    let start = marker_index + marker.len();
    let remainder = input.get(start..)?.trim_start();
    let mut chars = remainder.chars();
    let quote = chars.next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }

    let content = chars.as_str();
    let end_index = content.find(quote)?;
    let value = content[..end_index].trim();
    if value.is_empty() {
        return None;
    }
    Some(value.to_string())
}

fn run_yt_dlp_probe(ytdlp_path: &Path, url: &str) -> Result<VideoProbeResult, String> {
    let output = Command::new(ytdlp_path)
        .arg("--ignore-config")
        .arg("--encoding")
        .arg("utf-8")
        .arg("--no-playlist")
        .arg("--no-warnings")
        .arg("--skip-download")
        .arg("--print")
        .arg("title")
        .arg("--print")
        .arg("thumbnail")
        .arg("--print")
        .arg("duration_string")
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("Failed to run yt-dlp probe: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !stderr.is_empty() {
            return Err(stderr);
        }
        return Err("Failed to read video metadata.".to_string());
    }

    let lines = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();

    let title = lines
        .first()
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Unknown title".to_string());
    let thumbnail_url = lines
        .get(1)
        .cloned()
        .filter(|value| value.starts_with("http://") || value.starts_with("https://"));
    let duration = lines
        .get(2)
        .cloned()
        .filter(|value| !value.trim().is_empty());

    Ok(VideoProbeResult {
        url: url.to_string(),
        title,
        thumbnail_url,
        duration,
    })
}

fn extract_ytdlp_progress(line: &str) -> Option<f64> {
    for token in line.split_whitespace() {
        let normalized = token.trim().trim_start_matches("download:");
        let number = normalized.strip_suffix('%')?.trim().trim_start_matches('~');
        if let Ok(value) = number.parse::<f64>() {
            if (0.0..=100.0).contains(&value) {
                return Some(value);
            }
        }
    }
    None
}

fn emit_download_update(app: &AppHandle, payload: DownloadUpdatePayload) {
    let _ = app.emit(DOWNLOAD_EVENT, payload);
}

fn ensure_yt_dlp_binary(app: &AppHandle, force_refresh: bool) -> Result<PathBuf, String> {
    let binary_path = ytdlp_binary_path(app)?;
    let needs_refresh =
        force_refresh || !binary_path.exists() || should_refresh_download_tool(&binary_path);

    if needs_refresh {
        refresh_yt_dlp_binary(&binary_path)?;
    }

    Ok(binary_path)
}

fn should_refresh_download_tool(binary_path: &Path) -> bool {
    let metadata = match fs::metadata(binary_path) {
        Ok(value) => value,
        Err(_) => return true,
    };
    let modified = match metadata.modified() {
        Ok(value) => value,
        Err(_) => return true,
    };
    let age = match SystemTime::now().duration_since(modified) {
        Ok(value) => value,
        Err(_) => return true,
    };
    age.as_secs() >= YTDLP_REFRESH_INTERVAL_SECONDS
}

fn refresh_yt_dlp_binary(binary_path: &Path) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("Automatic yt-dlp setup is currently supported on Windows only.".to_string());
    }

    if let Some(parent) = binary_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create yt-dlp directory: {err}"))?;
    }

    let temporary_path = binary_path.with_extension("download");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .user_agent("HMLH-Converter/0.1")
        .build()
        .map_err(|err| format!("Failed to initialize HTTP client: {err}"))?;

    let mut errors = Vec::new();
    for source_url in [YTDLP_NIGHTLY_WINDOWS_URL, YTDLP_STABLE_WINDOWS_URL] {
        match download_file_to_path(&client, source_url, &temporary_path) {
            Ok(()) => {
                if binary_path.exists() {
                    let _ = fs::remove_file(binary_path);
                }

                fs::copy(&temporary_path, binary_path)
                    .map_err(|err| format!("Failed to install yt-dlp binary: {err}"))?;
                let _ = fs::remove_file(&temporary_path);

                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(binary_path, fs::Permissions::from_mode(0o755))
                        .map_err(|err| format!("Failed to set yt-dlp executable permission: {err}"))?;
                }

                return Ok(());
            }
            Err(err) => {
                errors.push(format!("{source_url} ({err})"));
                let _ = fs::remove_file(&temporary_path);
            }
        }
    }

    Err(format!(
        "Failed to download yt-dlp binary. Tried sources: {}",
        errors.join(" | ")
    ))
}

fn download_file_to_path(
    client: &reqwest::blocking::Client,
    source_url: &str,
    destination_path: &Path,
) -> Result<(), String> {
    let mut response = client
        .get(source_url)
        .send()
        .map_err(|err| format!("Request failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let mut file = fs::File::create(destination_path)
        .map_err(|err| format!("Failed to create temporary file: {err}"))?;
    response
        .copy_to(&mut file)
        .map_err(|err| format!("Failed to write yt-dlp binary: {err}"))?;
    file.flush()
        .map_err(|err| format!("Failed to finalize yt-dlp binary: {err}"))?;
    Ok(())
}

fn ytdlp_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data directory: {err}"))?;

    let executable = if cfg!(target_os = "windows") {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    };

    Ok(app_data.join("tools").join("yt-dlp").join(executable))
}

fn resolve_bundled_binary_path(app: &AppHandle, binary: &str) -> Result<String, String> {
    let executable = if cfg!(target_os = "windows") {
        format!("{binary}.exe")
    } else {
        binary.to_string()
    };
    let platform = current_platform_segment();
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("ffmpeg").join(platform).join(&executable));
        candidates.push(
            resource_dir
                .join("resources")
                .join("ffmpeg")
                .join(platform)
                .join(&executable),
        );
        candidates.push(resource_dir.join("ffmpeg").join(&executable));
        candidates.push(resource_dir.join("resources").join("ffmpeg").join(&executable));
        candidates.push(resource_dir.join(&executable));
        candidates.push(resource_dir.join("resources").join(&executable));
    }

    if cfg!(debug_assertions) {
        if let Ok(project_dir) = std::env::current_dir() {
            candidates.push(
                project_dir
                    .join("src-tauri")
                    .join("resources")
                    .join("ffmpeg")
                    .join(platform)
                    .join(&executable),
            );
        }
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("ffmpeg")
                .join(platform)
                .join(&executable),
        );
    }

    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.to_string_lossy().to_string());
        }
    }

    let searched = candidates
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(" | ");

    Err(format!(
        "Bundled {binary} is missing. Place file at src-tauri/resources/ffmpeg/{platform}/{executable} before build. Searched: {searched}"
    ))
}

fn current_platform_segment() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn compute_clip_duration(ffprobe_path: &str, request: &EncodeJobRequest) -> Option<f64> {
    let source_duration = probe_duration(ffprobe_path, &request.input_path);
    match (request.start_seconds, request.end_seconds, source_duration) {
        (Some(start), Some(end), _) if end > start => Some(end - start),
        (Some(start), None, Some(total)) if total > start => Some(total - start),
        (None, Some(end), _) if end > 0.0 => Some(end),
        (None, None, Some(total)) if total > 0.0 => Some(total),
        _ => None,
    }
}

fn probe_duration(ffprobe_path: &str, input_path: &str) -> Option<f64> {
    let output = Command::new(ffprobe_path)
        .arg("-v")
        .arg("error")
        .arg("-show_entries")
        .arg("format=duration")
        .arg("-of")
        .arg("default=noprint_wrappers=1:nokey=1")
        .arg(input_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .ok()
}

fn requested_duration(request: &EncodeJobRequest) -> Option<f64> {
    match (request.start_seconds, request.end_seconds) {
        (Some(start), Some(end)) if end > start => Some(end - start),
        (None, Some(end)) if end > 0.0 => Some(end),
        _ => None,
    }
}

fn map_quality_to_crf(quality: u8, min_crf: u8, max_crf: u8) -> u8 {
    let span = max_crf.saturating_sub(min_crf);
    let normalized = (100_u8.saturating_sub(quality)) as f64 / 100.0;
    min_crf + (normalized * f64::from(span)).round() as u8
}

fn estimate_eta_seconds(progress: f64, elapsed: Duration) -> Option<f64> {
    if progress <= 0.01 {
        return None;
    }
    let elapsed_secs = elapsed.as_secs_f64();
    let total = elapsed_secs / progress;
    Some((total - elapsed_secs).max(0.0))
}

fn preset_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("앱 데이터 디렉토리 확인 실패: {err}"))?;
    Ok(app_data.join("presets.json"))
}

fn staging_output_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("App data directory lookup failed: {err}"))?;
    Ok(app_data.join("staging_outputs"))
}

fn default_presets() -> Vec<EncodingPreset> {
    vec![
        EncodingPreset {
            id: "hq-gif".to_string(),
            name: "고화질 GIF".to_string(),
            format: OutputFormat::Gif,
            fps: 15,
            width: 640,
            quality: 85,
            include_audio: false,
        },
        EncodingPreset {
            id: "small-gif".to_string(),
            name: "저용량 GIF".to_string(),
            format: OutputFormat::Gif,
            fps: 10,
            width: 420,
            quality: 65,
            include_audio: false,
        },
        EncodingPreset {
            id: "sns-mp4".to_string(),
            name: "SNS MP4".to_string(),
            format: OutputFormat::Mp4,
            fps: 30,
            width: 1080,
            quality: 78,
            include_audio: true,
        },
        EncodingPreset {
            id: "balanced-webm".to_string(),
            name: "밸런스 WebM".to_string(),
            format: OutputFormat::Webm,
            fps: 30,
            width: 960,
            quality: 72,
            include_audio: true,
        },
    ]
}

fn next_job_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("job-{timestamp}-{sequence}")
}

fn validate_request(request: &EncodeJobRequest) -> Result<(), String> {
    let input = Path::new(&request.input_path);
    if !input.exists() {
        return Err("입력 파일을 찾을 수 없습니다.".to_string());
    }
    if !input.is_file() {
        return Err("입력 경로가 파일이 아닙니다.".to_string());
    }
    if request.fps == 0 {
        return Err("FPS는 1 이상이어야 합니다.".to_string());
    }
    if request.width < 64 {
        return Err("너비는 64 이상으로 설정해주세요.".to_string());
    }
    if let Some(start) = request.start_seconds {
        if start < 0.0 {
            return Err("시작 시간은 0 이상이어야 합니다.".to_string());
        }
    }
    if let Some(end) = request.end_seconds {
        if end <= 0.0 {
            return Err("종료 시간은 0보다 커야 합니다.".to_string());
        }
    }
    if let (Some(start), Some(end)) = (request.start_seconds, request.end_seconds) {
        if end <= start {
            return Err("종료 시간은 시작 시간보다 커야 합니다.".to_string());
        }
    }
    Ok(())
}

fn build_staging_output_path(app: &AppHandle, request: &EncodeJobRequest) -> Result<String, String> {
    let output_dir = staging_output_dir(app)?;
    fs::create_dir_all(&output_dir).map_err(|err| format!("Failed to create staging directory: {err}"))?;

    let input = PathBuf::from(&request.input_path);
    let default_name = input
        .file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".to_string());

    let name_base = request
        .output_name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(sanitize_filename)
        .unwrap_or_else(|| sanitize_filename(&default_name));

    let file_name = format!("{name_base}.{}", request.format.extension());
    let candidate = ensure_unique_file_path(&output_dir, &file_name)?;
    Ok(candidate.to_string_lossy().to_string())
}

fn ensure_unique_file_path(parent: &Path, file_name: &str) -> Result<PathBuf, String> {
    let initial = parent.join(file_name);
    if !initial.exists() {
        return Ok(initial);
    }

    let file_path = Path::new(file_name);
    let stem = file_path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".to_string());
    let extension = file_path
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();

    for index in 1..=9_999 {
        let candidate = parent.join(format!("{stem}_{index}{extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("Failed to generate a unique output file name.".to_string())
}
fn sanitize_filename(input: &str) -> String {
    let mut sanitized = String::with_capacity(input.len());
    for ch in input.chars() {
        if "<>:\"/\\|?*".contains(ch) {
            sanitized.push('_');
        } else {
            sanitized.push(ch);
        }
    }

    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        "output".to_string()
    } else {
        trimmed.to_string()
    }
}

fn lock_jobs(jobs: &Arc<Mutex<JobStore>>) -> std::sync::MutexGuard<'_, JobStore> {
    jobs.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn snapshot_from_store(store: &JobStore) -> QueueSnapshot {
    let queued_job_ids = store.queue.iter().map(|job| job.id.clone()).collect::<Vec<_>>();
    let mut running_job_ids = store.running.keys().cloned().collect::<Vec<_>>();
    running_job_ids.sort_unstable();
    QueueSnapshot {
        queued_job_ids,
        running_job_ids,
        max_concurrent: store.max_concurrent.max(1),
    }
}

fn emit_queue_snapshot(app: &AppHandle, jobs: &Arc<Mutex<JobStore>>) {
    let snapshot = {
        let store = lock_jobs(jobs);
        snapshot_from_store(&store)
    };
    let _ = app.emit(QUEUE_EVENT, snapshot);
}

fn emit_job_update(app: &AppHandle, payload: JobUpdatePayload) {
    let _ = app.emit(JOB_EVENT, payload);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            jobs: Arc::new(Mutex::new(JobStore {
                queue: VecDeque::new(),
                running: HashMap::new(),
                max_concurrent: 1,
            })),
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_default_presets,
            load_saved_presets,
            save_presets,
            check_ffmpeg_status,
            probe_video_url,
            download_video_from_url,
            trim_downloaded_video,
            enqueue_encode_job,
            save_outputs,
            clear_staging_outputs,
            remove_staged_file,
            cancel_encode_job,
            get_queue_snapshot,
            set_queue_limit
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
