import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

type OutputFormat = "gif" | "mp4" | "webm";
type MainPanel = "drop" | "preview";

interface EncodeJobRequest {
  inputPath: string;
  outputDir: string | null;
  outputName: string | null;
  format: OutputFormat;
  startSeconds: number | null;
  endSeconds: number | null;
  fps: number;
  width: number;
  quality: number;
  includeAudio: boolean;
}

interface EncodingPreset {
  id: string;
  name: string;
  format: OutputFormat;
  fps: number;
  width: number;
  quality: number;
  includeAudio: boolean;
}

interface QueueSnapshot {
  queuedJobIds: string[];
  runningJobIds: string[];
  maxConcurrent: number;
}

interface FfmpegStatus {
  available: boolean;
  ffmpegPath: string;
  ffprobePath: string;
  version: string | null;
  message: string | null;
}

interface JobUpdatePayload {
  jobId: string;
  status: string;
  progress: number | null;
  etaSeconds: number | null;
  speed: string | null;
  message: string | null;
  inputPath: string;
  outputPath: string;
}

interface JobView extends JobUpdatePayload {
  createdAt: number;
}

interface FormState {
  outputDir: string;
  nameSuffix: string;
  format: OutputFormat;
  fps: number;
  width: number;
  quality: number;
  includeAudio: boolean;
  queueLimit: number;
}

const SETTINGS_KEY = "gifmaker-ui-settings-v2";
const SUPPORTED_EXTENSIONS = new Set([
  "mp4",
  "mov",
  "mkv",
  "avi",
  "webm",
  "m4v",
  "flv",
  "wmv",
]);

const defaultFormState: FormState = {
  outputDir: "",
  nameSuffix: "",
  format: "gif",
  fps: 12,
  width: 540,
  quality: 80,
  includeAudio: false,
  queueLimit: 1,
};

const statusLabels: Record<string, string> = {
  queued: "대기",
  running: "실행",
  progress: "인코딩",
  completed: "완료",
  failed: "실패",
  cancelled: "취소됨",
  cancelling: "취소중",
};

function App() {
  const [inputs, setInputs] = useState<string[]>([]);
  const [jobs, setJobs] = useState<Record<string, JobView>>({});
  const [defaultPresets, setDefaultPresets] = useState<EncodingPreset[]>([]);
  const [customPresets, setCustomPresets] = useState<EncodingPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [ffmpegStatus, setFfmpegStatus] = useState<FfmpegStatus | null>(null);
  const [queueSnapshot, setQueueSnapshot] = useState<QueueSnapshot>({
    queuedJobIds: [],
    runningJobIds: [],
    maxConcurrent: 1,
  });
  const [form, setForm] = useState<FormState>(() => {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return defaultFormState;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<FormState>;
      return { ...defaultFormState, ...parsed };
    } catch {
      return defaultFormState;
    }
  });

  const [error, setError] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isDropActive, setIsDropActive] = useState<boolean>(false);
  const [activePanel, setActivePanel] = useState<MainPanel>("drop");
  const [previewOutputPath, setPreviewOutputPath] = useState<string>("");
  const [previewSource, setPreviewSource] = useState<string>("");

  const allPresets = useMemo(
    () => [...defaultPresets, ...customPresets],
    [defaultPresets, customPresets],
  );

  const allJobs = useMemo(
    () =>
      Object.values(jobs).sort((a, b) => {
        if (a.createdAt === b.createdAt) {
          return a.jobId.localeCompare(b.jobId);
        }
        return b.createdAt - a.createdAt;
      }),
    [jobs],
  );

  const recentJobs = useMemo(() => allJobs.slice(0, 5), [allJobs]);
  const extraJobsCount = Math.max(0, allJobs.length - recentJobs.length);
  const visibleInputs = useMemo(() => inputs.slice(0, 8), [inputs]);
  const extraInputsCount = Math.max(0, inputs.length - visibleInputs.length);
  const completedJobs = useMemo(
    () => allJobs.filter((job) => job.status === "completed" && job.outputPath).slice(0, 5),
    [allJobs],
  );

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(form));
  }, [form]);

  useEffect(() => {
    let unlistenJobs: UnlistenFn | null = null;
    let unlistenQueue: UnlistenFn | null = null;
    let unlistenDrop: UnlistenFn | null = null;

    const bootstrap = async () => {
      try {
        const [defaults, saved, status, snapshot] = await Promise.all([
          invoke<EncodingPreset[]>("get_default_presets"),
          invoke<EncodingPreset[]>("load_saved_presets").catch(() => []),
          invoke<FfmpegStatus>("check_ffmpeg_status"),
          invoke<QueueSnapshot>("get_queue_snapshot"),
        ]);
        setDefaultPresets(defaults);
        setCustomPresets(saved);
        setFfmpegStatus(status);
        setQueueSnapshot(snapshot);
      } catch (bootstrapError) {
        setError(stringifyError(bootstrapError));
      }

      unlistenJobs = await listen<JobUpdatePayload>("job-update", (event) => {
        const payload = event.payload;

        if (payload.status === "completed" && payload.outputPath) {
          setPreviewFromOutputPath(payload.outputPath, setPreviewOutputPath, setPreviewSource);
          setActivePanel("preview");
        }

        setJobs((prev) => {
          const existing = prev[payload.jobId];
          const createdAt = existing?.createdAt ?? Date.now();
          return {
            ...prev,
            [payload.jobId]: {
              ...(existing ?? {}),
              ...payload,
              createdAt,
            },
          };
        });
      });

      unlistenQueue = await listen<QueueSnapshot>("queue-update", (event) => {
        setQueueSnapshot(event.payload);
      });

      if (isTauri()) {
        unlistenDrop = await getCurrentWebviewWindow().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setIsDropActive(true);
            return;
          }
          if (payload.type === "leave") {
            setIsDropActive(false);
            return;
          }
          if (payload.type === "drop") {
            setIsDropActive(false);
            appendInputPaths(payload.paths, setInputs, setError);
          }
        });
      }
    };

    void bootstrap();

    return () => {
      if (unlistenJobs) {
        void unlistenJobs();
      }
      if (unlistenQueue) {
        void unlistenQueue();
      }
      if (unlistenDrop) {
        void unlistenDrop();
      }
    };
  }, []);

  const pickInputs = async () => {
    const selected = await open({
      title: "변환할 영상 선택",
      multiple: true,
      filters: [
        {
          name: "Video Files",
          extensions: [...SUPPORTED_EXTENSIONS],
        },
      ],
    });

    if (selected === null) {
      return;
    }

    const values = Array.isArray(selected) ? selected : [selected];
    appendInputPaths(values, setInputs, setError);
  };

  const pickOutputDir = async () => {
    const selected = await open({
      title: "출력 폴더 선택",
      directory: true,
      multiple: false,
    });

    if (typeof selected === "string") {
      setForm((prev) => ({ ...prev, outputDir: selected }));
    }
  };

  const refreshFfmpegStatus = async () => {
    try {
      const next = await invoke<FfmpegStatus>("check_ffmpeg_status");
      setFfmpegStatus(next);
    } catch (statusError) {
      setError(stringifyError(statusError));
    }
  };

  const applyPreset = (presetId: string) => {
    setSelectedPresetId(presetId);
    const found = allPresets.find((preset) => preset.id === presetId);
    if (!found) {
      return;
    }
    setForm((prev) => ({
      ...prev,
      format: found.format,
      fps: found.fps,
      width: found.width,
      quality: found.quality,
      includeAudio: found.includeAudio,
    }));
  };

  const saveCurrentPreset = async () => {
    const name = window.prompt("프리셋 이름을 입력하세요.");
    if (!name) {
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    const nextPreset: EncodingPreset = {
      id: `custom-${Date.now()}`,
      name: trimmed,
      format: form.format,
      fps: form.fps,
      width: form.width,
      quality: form.quality,
      includeAudio: form.includeAudio,
    };
    const next = [...customPresets, nextPreset];
    setCustomPresets(next);
    await invoke("save_presets", { presets: next });
    setSelectedPresetId(nextPreset.id);
  };

  const changeQueueLimit = async (limit: number) => {
    setForm((prev) => ({ ...prev, queueLimit: limit }));
    try {
      const snapshot = await invoke<QueueSnapshot>("set_queue_limit", { limit });
      setQueueSnapshot(snapshot);
    } catch (queueError) {
      setError(stringifyError(queueError));
    }
  };

  const submitBatch = async () => {
    if (inputs.length === 0) {
      setError("입력 파일을 먼저 선택해주세요.");
      return;
    }

    setError("");
    setIsSubmitting(true);

    try {
      for (const inputPath of inputs) {
        const request: EncodeJobRequest = {
          inputPath,
          outputDir: form.outputDir.trim() ? form.outputDir.trim() : null,
          outputName: form.nameSuffix.trim()
            ? `${getFilenameStem(inputPath)}_${form.nameSuffix.trim()}`
            : null,
          format: form.format,
          startSeconds: null,
          endSeconds: null,
          fps: form.fps,
          width: form.width,
          quality: form.quality,
          includeAudio: form.format === "gif" ? false : form.includeAudio,
        };

        const jobId = await invoke<string>("enqueue_encode_job", { request });
        setJobs((prev) => ({
          ...prev,
          [jobId]: {
            jobId,
            status: "queued",
            progress: 0,
            etaSeconds: null,
            speed: null,
            message: "큐 등록",
            inputPath,
            outputPath: "",
            createdAt: Date.now(),
          },
        }));
      }
    } catch (submitError) {
      setError(stringifyError(submitError));
    } finally {
      setIsSubmitting(false);
    }
  };

  const cancelJob = async (jobId: string) => {
    try {
      await invoke("cancel_encode_job", { jobId });
    } catch (cancelError) {
      setError(stringifyError(cancelError));
    }
  };

  const selectPreview = (outputPath: string) => {
    setPreviewFromOutputPath(outputPath, setPreviewOutputPath, setPreviewSource);
    setActivePanel("preview");
  };

  const onHtmlDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropActive(false);
    const droppedPaths = getDroppedPaths(event.dataTransfer);
    if (droppedPaths.length > 0) {
      appendInputPaths(droppedPaths, setInputs, setError);
    }
  };

  const previewType = getPreviewType(previewOutputPath);
  const previewReady = previewOutputPath.length > 0 && previewSource.length > 0;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>HMLH GifMaker</h1>
          <p>Simple desktop converter</p>
        </div>

        <section className="side-block">
          <div className="line-row">
            <strong>영상 리스트 {inputs.length}개</strong>
            <span className={`pill ${ffmpegStatus?.available ? "good" : "bad"}`}>
              FFmpeg {ffmpegStatus?.available ? "연결됨" : "미연결"}
            </span>
          </div>
          <p className="muted line-clamp">
            {ffmpegStatus?.version ?? ffmpegStatus?.message ?? "FFmpeg 상태 확인 중..."}
          </p>
          <div className="line-row">
            <button type="button" onClick={pickInputs}>
              파일 추가
            </button>
            <button type="button" onClick={() => setInputs([])} disabled={inputs.length === 0}>
              비우기
            </button>
            <button type="button" onClick={refreshFfmpegStatus}>
              상태 확인
            </button>
          </div>

          {inputs.length === 0 && <p className="muted">선택된 영상이 없습니다.</p>}

          {inputs.length > 0 && (
            <ul className="input-list input-list-fixed">
              {visibleInputs.map((path, index) => (
                <li key={path}>
                  <span>
                    {index + 1}. {shortPath(path, 48)}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setInputs((prev) => prev.filter((current) => current !== path))
                    }
                  >
                    제거
                  </button>
                </li>
              ))}
            </ul>
          )}

          {extraInputsCount > 0 && <p className="muted">+{extraInputsCount}개 파일 더 선택됨</p>}
        </section>

        <section className="side-block side-block-fill">
          <div className="line-row">
            <strong>작업</strong>
            <span className="muted">
              Run {queueSnapshot.runningJobIds.length} / Queue {queueSnapshot.queuedJobIds.length}
            </span>
          </div>

          {recentJobs.length === 0 && <p className="muted">아직 작업이 없습니다.</p>}

          <ul className="job-list">
            {recentJobs.map((job) => {
              const status = statusLabels[job.status] ?? job.status;
              const progress =
                job.progress !== null ? `${Math.round(job.progress * 100)}%` : "--";
              const canCancel =
                job.status === "queued" ||
                job.status === "running" ||
                job.status === "progress";

              return (
                <li key={job.jobId} className="job-item">
                  <div className="line-row">
                    <span>{status}</span>
                    <span className="muted">{progress}</span>
                  </div>
                  <p className="line-clamp muted">{shortPath(job.inputPath, 44)}</p>
                  <div className="line-row">
                    <button type="button" onClick={() => cancelJob(job.jobId)} disabled={!canCancel}>
                      취소
                    </button>
                    <button
                      type="button"
                      onClick={() => selectPreview(job.outputPath)}
                      disabled={job.status !== "completed" || !job.outputPath}
                    >
                      보기
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {extraJobsCount > 0 && <p className="muted">+{extraJobsCount}개 작업 더 있음</p>}
        </section>
      </aside>

      <section className="workspace">
        <header className="workspace-head">
          <div className="segment">
            <button
              type="button"
              className={activePanel === "drop" ? "active" : ""}
              onClick={() => setActivePanel("drop")}
            >
              DnD
            </button>
            <button
              type="button"
              className={activePanel === "preview" ? "active" : ""}
              onClick={() => setActivePanel("preview")}
              disabled={!previewReady}
            >
              Preview
            </button>
          </div>
        </header>

        {activePanel === "drop" ? (
          <div
            className={`drop-screen ${isDropActive ? "active" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDropActive(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              event.preventDefault();
              if (event.currentTarget === event.target) {
                setIsDropActive(false);
              }
            }}
            onDrop={onHtmlDrop}
          >
            <button type="button" className="drop-circle" onClick={pickInputs}>
              <span className="ring ring-outer" />
              <span className="ring ring-inner" />
              <span className="center-mark">+</span>
            </button>
            <p className="drop-title">Drag & Drop</p>
            <p className="muted">파일을 놓거나 원을 눌러 선택</p>
          </div>
        ) : (
          <div className="preview-screen">
            {!previewReady && <p className="muted">완료된 작업을 선택하면 여기에서 미리보기를 볼 수 있습니다.</p>}

            {previewReady && (
              <>
                <div className="preview-frame">
                  {previewType === "gif" && (
                    <img className="preview-media" src={previewSource} alt="output preview" />
                  )}
                  {(previewType === "mp4" || previewType === "webm") && (
                    <video className="preview-media" src={previewSource} controls />
                  )}
                  {previewType === null && <p className="muted">미리보기를 지원하지 않는 형식입니다.</p>}
                </div>
                <p className="muted line-clamp">{previewOutputPath}</p>
              </>
            )}
          </div>
        )}

        <section className="selection-panel control-panel">
          <div className="line-row">
            <strong>인코딩 옵션</strong>
            <span className="muted">선택 파일 {inputs.length}개</span>
          </div>

          <div className="control-grid">
            <label>
              프리셋
              <select
                value={selectedPresetId}
                onChange={(event) => applyPreset(event.target.value)}
              >
                <option value="">선택 안 함</option>
                {allPresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              포맷
              <select
                value={form.format}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, format: event.target.value as OutputFormat }))
                }
              >
                <option value="gif">GIF</option>
                <option value="mp4">MP4</option>
                <option value="webm">WebM</option>
              </select>
            </label>

            <label>
              FPS
              <input
                type="number"
                min={1}
                max={60}
                value={form.fps}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    fps: clampNumber(Number(event.target.value), 1, 60),
                  }))
                }
              />
            </label>

            <label>
              Width
              <input
                type="number"
                min={64}
                max={3840}
                value={form.width}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    width: clampNumber(Number(event.target.value), 64, 3840),
                  }))
                }
              />
            </label>

            <label>
              품질
              <input
                type="number"
                min={1}
                max={100}
                value={form.quality}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    quality: clampNumber(Number(event.target.value), 1, 100),
                  }))
                }
              />
            </label>

            <label>
              동시 작업
              <select
                value={form.queueLimit}
                onChange={(event) => changeQueueLimit(Number(event.target.value))}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4</option>
              </select>
            </label>
          </div>

          <label>
            출력 폴더
            <div className="inline-field">
              <input
                value={form.outputDir}
                placeholder="비우면 원본 폴더"
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, outputDir: event.target.value }))
                }
              />
              <button type="button" onClick={pickOutputDir}>
                선택
              </button>
            </div>
          </label>

          <label>
            파일명 접미사
            <input
              value={form.nameSuffix}
              placeholder="예: sns"
              onChange={(event) =>
                setForm((prev) => ({ ...prev, nameSuffix: event.target.value }))
              }
            />
          </label>

          <div className="line-row">
            <label className="inline-checkbox">
              <input
                type="checkbox"
                checked={form.includeAudio}
                disabled={form.format === "gif"}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, includeAudio: event.target.checked }))
                }
              />
              오디오 유지
            </label>
            <span className="muted">
              Run {queueSnapshot.runningJobIds.length} / Queue {queueSnapshot.queuedJobIds.length}
            </span>
          </div>

          <div className="line-row">
            <button type="button" onClick={saveCurrentPreset}>
              현재값 저장
            </button>
            <button
              type="button"
              className="primary"
              onClick={submitBatch}
              disabled={isSubmitting || inputs.length === 0}
            >
              {isSubmitting ? "등록 중..." : `변환 시작 (${inputs.length})`}
            </button>
          </div>
        </section>

        {activePanel === "preview" && completedJobs.length > 1 && (
          <section className="preview-list">
            <strong>완료 파일</strong>
            <div className="preview-list-buttons">
              {completedJobs.map((job) => (
                <button
                  type="button"
                  key={job.jobId}
                  onClick={() => selectPreview(job.outputPath)}
                >
                  {shortPath(job.outputPath, 38)}
                </button>
              ))}
            </div>
          </section>
        )}
      </section>

      {error && <p className="error-banner">{error}</p>}
    </main>
  );
}

function appendInputPaths(
  incomingPaths: string[],
  setInputs: Dispatch<SetStateAction<string[]>>,
  setError: Dispatch<SetStateAction<string>>,
): void {
  const normalized = incomingPaths
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .filter((path) => isSupportedVideo(path));

  if (normalized.length === 0) {
    setError("지원되는 영상 파일만 추가할 수 있습니다.");
    return;
  }

  setInputs((prev) => {
    const merged = [...prev];
    for (const path of normalized) {
      if (!merged.includes(path)) {
        merged.push(path);
      }
    }
    return merged;
  });
  setError("");
}

function isSupportedVideo(path: string): boolean {
  const extension = getFileExtension(path);
  if (!extension) {
    return false;
  }
  return SUPPORTED_EXTENSIONS.has(extension);
}

function setPreviewFromOutputPath(
  outputPath: string,
  setOutputPath: Dispatch<SetStateAction<string>>,
  setSource: Dispatch<SetStateAction<string>>,
): void {
  setOutputPath(outputPath);
  setSource(toPreviewSource(outputPath));
}

function toPreviewSource(path: string): string {
  if (!path) {
    return "";
  }

  if (isTauri()) {
    try {
      return convertFileSrc(path);
    } catch {
      return encodeURI(`file://${path.replace(/\\/g, "/")}`);
    }
  }
  return path;
}

function getPreviewType(path: string): OutputFormat | null {
  const extension = getFileExtension(path);
  if (!extension) {
    return null;
  }
  if (extension === "gif" || extension === "mp4" || extension === "webm") {
    return extension;
  }
  return null;
}

function getFileExtension(path: string): string | null {
  const dotIndex = path.lastIndexOf(".");
  if (dotIndex === -1) {
    return null;
  }

  return path.substring(dotIndex + 1).toLowerCase();
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function stringifyError(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return JSON.stringify(err);
}

function shortPath(path: string, maxLength: number): string {
  if (path.length <= maxLength) {
    return path;
  }
  const head = path.slice(0, Math.floor(maxLength * 0.4));
  const tail = path.slice(-Math.floor(maxLength * 0.45));
  return `${head}...${tail}`;
}

function getFilenameStem(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const fileName = normalized.substring(normalized.lastIndexOf("/") + 1);
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1) {
    return fileName;
  }
  return fileName.substring(0, dotIndex);
}

function getDroppedPaths(dataTransfer: DataTransfer): string[] {
  const files = Array.from(dataTransfer.files);
  return files
    .map((file) => (file as File & { path?: string }).path)
    .filter((path): path is string => Boolean(path && path.trim()));
}

export default App;
