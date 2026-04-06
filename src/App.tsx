import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import packageJson from "../package.json";
import "./App.css";

const GITHUB_REPO = "HEIMLICH-TECHNIK/HMLH_GifMaker";
const GITHUB_RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases/latest`;

type OutputFormat = "gif" | "mp4" | "webm";
type MainPanel = "convert" | "download" | "preview";

interface EncodeJobRequest {
  inputPath: string;
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

interface DownloadVideoResult {
  url: string;
  title: string;
  outputPath: string;
  isTrimmed?: boolean;
  originalOutputPath?: string;
  originalTitle?: string;
}

interface DownloadUpdatePayload {
  url: string;
  status: "starting" | "progress" | "completed" | "failed" | string;
  progress: number | null;
  message: string | null;
}

interface VideoProbeResult {
  url: string;
  title: string;
  thumbnailUrl: string | null;
  duration: string | null;
}

interface PlayerModalAction {
  id: string;
  label: string;
  pendingLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  primary?: boolean;
  onClick: () => void;
}

interface FormState {
  nameSuffix: string;
  format: OutputFormat;
  fps: number;
  width: number;
  quality: number;
  includeAudio: boolean;
  queueLimit: number;
}

const SETTINGS_KEY = "hmlh-converter-ui-settings-v4";
const TRIM_MIN_DURATION_SECONDS = 0.2;
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
  nameSuffix: "",
  format: "gif",
  fps: 12,
  width: 540,
  quality: 80,
  includeAudio: false,
  queueLimit: 1,
};

const statusLabels: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  progress: "Encoding",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  cancelling: "Cancelling",
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
  const [savedNotice, setSavedNotice] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isSavingOutputs, setIsSavingOutputs] = useState<boolean>(false);
  const [isDropActive, setIsDropActive] = useState<boolean>(false);
  const [activePanel, setActivePanel] = useState<MainPanel>("convert");
  const [previewIndex, setPreviewIndex] = useState<number>(0);
  const [downloadUrl, setDownloadUrl] = useState<string>("");
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [isProbingLink, setIsProbingLink] = useState<boolean>(false);
  const [linkPreview, setLinkPreview] = useState<VideoProbeResult | null>(null);
  const [isSavingDownloaded, setIsSavingDownloaded] = useState<boolean>(false);
  const [isTrimmingDownloaded, setIsTrimmingDownloaded] = useState<boolean>(false);
  const [downloadedItems, setDownloadedItems] = useState<DownloadVideoResult[]>([]);
  const [activeDownloaded, setActiveDownloaded] = useState<DownloadVideoResult | null>(null);
  const [isPlayerModalOpen, setIsPlayerModalOpen] = useState<boolean>(false);
  const [isTrimMode, setIsTrimMode] = useState<boolean>(false);
  const [trimDurationSeconds, setTrimDurationSeconds] = useState<number>(0);
  const [trimStartSeconds, setTrimStartSeconds] = useState<number>(0);
  const [trimEndSeconds, setTrimEndSeconds] = useState<number>(0);
  const [trimSeekSeconds, setTrimSeekSeconds] = useState<number>(0);
  const playerVideoRef = useRef<HTMLVideoElement | null>(null);
  const [appVersion, setAppVersion] = useState<string>(packageJson.version);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [updateCheckBusy, setUpdateCheckBusy] = useState<boolean>(false);
  const [updateCheckMessage, setUpdateCheckMessage] = useState<string>("");
  const [updateReleaseUrl, setUpdateReleaseUrl] = useState<string | null>(null);

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
  const dropGridItems = useMemo(() => inputs.slice(0, 18), [inputs]);
  const extraDropItemsCount = Math.max(0, inputs.length - dropGridItems.length);
  const completedJobs = useMemo(
    () => allJobs.filter((job) => job.status === "completed" && job.outputPath),
    [allJobs],
  );

  const hasActiveJobs =
    queueSnapshot.runningJobIds.length > 0 || queueSnapshot.queuedJobIds.length > 0;
  const canSaveOutputs = completedJobs.length > 0 && !hasActiveJobs;

  const previewJob = completedJobs[previewIndex] ?? null;
  const previewOutputPath = previewJob?.outputPath ?? "";
  const previewSource = useMemo(() => toPreviewSource(previewOutputPath), [previewOutputPath]);
  const previewType = getPreviewType(previewOutputPath);
  const previewReady = previewOutputPath.length > 0 && previewSource.length > 0;
  const activeDownloadedSource = useMemo(
    () => toPreviewSource(activeDownloaded?.outputPath ?? ""),
    [activeDownloaded?.outputPath],
  );
  const activeDownloadedType = getPreviewType(activeDownloaded?.outputPath ?? "");
  const hasDownloadedItems = downloadedItems.length > 0;
  const canUseTrimEditor =
    activeDownloadedType === "mp4" || activeDownloadedType === "webm";
  const isShowingTrimmedVersion = Boolean(
    activeDownloaded?.isTrimmed && activeDownloaded.originalOutputPath,
  );
  const trimSelectionDuration = Math.max(0, trimEndSeconds - trimStartSeconds);
  const trimSelectionReady =
    trimDurationSeconds > 0 && trimSelectionDuration >= TRIM_MIN_DURATION_SECONDS;
  const trimSelectionLeftPercent =
    trimDurationSeconds > 0 ? (trimStartSeconds / trimDurationSeconds) * 100 : 0;
  const trimSelectionWidthPercent =
    trimDurationSeconds > 0
      ? ((trimEndSeconds - trimStartSeconds) / trimDurationSeconds) * 100
      : 0;

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(form));
  }, [form]);

  useEffect(() => {
    const loadVersion = async () => {
      if (!isTauri()) {
        return;
      }
      try {
        const v = await getVersion();
        setAppVersion(v);
      } catch {
        setAppVersion(packageJson.version);
      }
    };
    void loadVersion();
  }, []);

  useEffect(() => {
    if (!settingsOpen && !isPlayerModalOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (isPlayerModalOpen) {
        setIsPlayerModalOpen(false);
        return;
      }
      if (settingsOpen) {
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [settingsOpen, isPlayerModalOpen]);

  useEffect(() => {
    if (!error) {
      return;
    }
    const timer = window.setTimeout(() => {
      setError("");
    }, 3200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [error]);

  useEffect(() => {
    const trimmed = downloadUrl.trim();
    if (!isValidHttpUrl(trimmed)) {
      setIsProbingLink(false);
      setLinkPreview(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setIsProbingLink(true);
      try {
        const preview = await invoke<VideoProbeResult>("probe_video_url", { url: trimmed });
        if (!cancelled && downloadUrl.trim() === trimmed) {
          setLinkPreview(preview);
        }
      } catch {
        if (!cancelled && downloadUrl.trim() === trimmed) {
          setLinkPreview(null);
        }
      } finally {
        if (!cancelled && downloadUrl.trim() === trimmed) {
          setIsProbingLink(false);
        }
      }
    }, 420);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [downloadUrl]);

  useEffect(() => {
    setIsTrimMode(false);
    setTrimDurationSeconds(0);
    setTrimStartSeconds(0);
    setTrimEndSeconds(0);
    setTrimSeekSeconds(0);
  }, [activeDownloaded?.outputPath]);

  useEffect(() => {
    if (isPlayerModalOpen) {
      return;
    }
    const video = playerVideoRef.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
    setIsTrimMode(false);
    setTrimSeekSeconds(0);
  }, [isPlayerModalOpen]);

  useEffect(() => {
    if (!isTrimMode || !isPlayerModalOpen || !canUseTrimEditor || trimDurationSeconds <= 0) {
      return;
    }
    const video = playerVideoRef.current;
    if (!video) {
      return;
    }
    const start = clampNumber(trimStartSeconds, 0, trimDurationSeconds);
    video.currentTime = start;
    const playPromise = video.play();
    if (playPromise && typeof playPromise.then === "function") {
      void playPromise.catch(() => undefined);
    }
  }, [
    isTrimMode,
    isPlayerModalOpen,
    canUseTrimEditor,
    trimDurationSeconds,
    trimStartSeconds,
    activeDownloaded?.outputPath,
  ]);

  useEffect(() => {
    setPreviewIndex((prev) => {
      if (completedJobs.length === 0) {
        return 0;
      }
      return Math.min(prev, completedJobs.length - 1);
    });
  }, [completedJobs.length]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      void invoke<number>("clear_staging_outputs");
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  useEffect(() => {
    let unlistenJobs: UnlistenFn | null = null;
    let unlistenQueue: UnlistenFn | null = null;
    let unlistenDrop: UnlistenFn | null = null;
    let unlistenDownload: UnlistenFn | null = null;

    const bootstrap = async () => {
      try {
        await invoke<number>("clear_staging_outputs").catch(() => 0);
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
          setActivePanel("preview");
          setPreviewIndex(0);
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

      unlistenDownload = await listen<DownloadUpdatePayload>("download-update", (event) => {
        const payload = event.payload;
        if (payload.status === "starting") {
          setIsDownloading(true);
          setDownloadProgress(payload.progress ?? 0);
          return;
        }
        if (payload.status === "progress") {
          if (payload.progress !== null) {
            setDownloadProgress(payload.progress);
          }
          return;
        }
        if (payload.status === "completed") {
          setIsDownloading(false);
          setDownloadProgress(100);
          return;
        }
        if (payload.status === "failed") {
          setIsDownloading(false);
          setDownloadProgress(null);
          if (payload.message) {
            setError(payload.message);
          }
        }
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
      if (unlistenDownload) {
        void unlistenDownload();
      }
    };
  }, []);

  const pickInputs = async () => {
    const selected = await open({
      title: "Select input videos",
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
    setSavedNotice("");
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
    const name = window.prompt("Preset name");
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
      setError("Select at least one input file first.");
      return;
    }

    setError("");
    setSavedNotice("");
    setIsSubmitting(true);

    try {
      for (const inputPath of inputs) {
        const request: EncodeJobRequest = {
          inputPath,
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
            message: "Queued",
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

  const selectPreviewByJobId = (jobId: string) => {
    const index = completedJobs.findIndex((job) => job.jobId === jobId);
    if (index === -1) {
      return;
    }
    setPreviewIndex(index);
    setActivePanel("preview");
  };

  const showPreviousPreview = () => {
    if (completedJobs.length <= 1) {
      return;
    }
    setPreviewIndex((prev) => {
      if (prev === 0) {
        return completedJobs.length - 1;
      }
      return prev - 1;
    });
  };

  const showNextPreview = () => {
    if (completedJobs.length <= 1) {
      return;
    }
    setPreviewIndex((prev) => (prev + 1) % completedJobs.length);
  };

  const saveAllOutputs = async () => {
    if (!canSaveOutputs || isSavingOutputs) {
      return;
    }

    const selected = await open({
      title: "Choose save folder",
      directory: true,
      multiple: false,
    });

    if (typeof selected !== "string") {
      return;
    }

    setIsSavingOutputs(true);
    setError("");
    setSavedNotice("");

    try {
      const stagedPaths = completedJobs.map((job) => job.outputPath);
      const saved = await invoke<string[]>("save_outputs", {
        destinationDir: selected,
        stagedPaths,
      });
      setSavedNotice(`Saved ${saved.length} file(s) to ${selected}`);
    } catch (saveError) {
      setError(stringifyError(saveError));
    } finally {
      setIsSavingOutputs(false);
    }
  };

  const resetTrimEditor = () => {
    const video = playerVideoRef.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
    setIsTrimMode(false);
    setTrimStartSeconds(0);
    setTrimSeekSeconds(0);
    setTrimEndSeconds(trimDurationSeconds > 0 ? trimDurationSeconds : 0);
  };

  const closePlayerModal = () => {
    resetTrimEditor();
    setIsPlayerModalOpen(false);
  };

  const clearWorkspaceSelections = async () => {
    const unsavedCount = completedJobs.length + downloadedItems.length;
    if (unsavedCount > 0) {
      const confirmed = window.confirm(
        `Unsaved ${unsavedCount} file(s) will be removed if you clear now. Continue?`,
      );
      if (!confirmed) {
        return;
      }
    }

    try {
      await invoke<number>("clear_staging_outputs");
    } catch (cleanupError) {
      setError(`Failed to clear staged files: ${stringifyError(cleanupError)}`);
    }

    setInputs([]);
    setJobs({});
    setPreviewIndex(0);
    setIsDropActive(false);
    setDownloadUrl("");
    setDownloadProgress(null);
    setLinkPreview(null);
    setIsProbingLink(false);
    setDownloadedItems([]);
    setActiveDownloaded(null);
    setIsPlayerModalOpen(false);
    setIsTrimMode(false);
    setTrimDurationSeconds(0);
    setTrimStartSeconds(0);
    setTrimEndSeconds(0);
    setTrimSeekSeconds(0);
    setSavedNotice("");
    setError("");
    setActivePanel("convert");
  };

  const startDownloadFromUrl = async () => {
    const trimmed = downloadUrl.trim();
    if (!trimmed) {
      setError("Enter a link first.");
      return;
    }

    if (!isValidHttpUrl(trimmed)) {
      setError("Use a valid URL starting with http:// or https://.");
      return;
    }

    const previewForCurrentUrl =
      linkPreview && linkPreview.url.trim() === trimmed ? linkPreview : null;

    setIsDownloading(true);
    setDownloadProgress(0);
    setError("");
    setSavedNotice("");

    try {
      const downloaded = await invoke<DownloadVideoResult>("download_video_from_url", {
        url: trimmed,
      });
      const titleFromPreview = previewForCurrentUrl?.title?.trim();
      const nextItem: DownloadVideoResult = {
        ...downloaded,
        title: titleFromPreview && titleFromPreview.length > 0 ? titleFromPreview : downloaded.title,
      };
      setDownloadedItems((prev) => {
        const withoutSamePath = prev.filter((item) => item.outputPath !== nextItem.outputPath);
        return [nextItem, ...withoutSamePath];
      });
      setActiveDownloaded(nextItem);
      setIsPlayerModalOpen(true);
      setDownloadUrl("");
      setSavedNotice(`Download complete: ${nextItem.title}`);
    } catch (downloadError) {
      setError(stringifyError(downloadError));
    } finally {
      setIsDownloading(false);
    }
  };

  const clearDownloadState = () => {
    setIsDownloading(false);
    setDownloadProgress(null);
    setDownloadUrl("");
    setLinkPreview(null);
    setIsProbingLink(false);
    setDownloadedItems([]);
    setActiveDownloaded(null);
    setIsPlayerModalOpen(false);
    setIsTrimMode(false);
    setTrimDurationSeconds(0);
    setTrimStartSeconds(0);
    setTrimEndSeconds(0);
    setTrimSeekSeconds(0);
  };

  const selectDownloadedItem = (item: DownloadVideoResult) => {
    setActiveDownloaded(item);
    setIsPlayerModalOpen(true);
  };

  const removeDownloadedItem = (outputPath: string) => {
    setDownloadedItems((prev) => prev.filter((item) => item.outputPath !== outputPath));
    if (activeDownloaded?.outputPath === outputPath) {
      setIsPlayerModalOpen(false);
    }
    setActiveDownloaded((prev) => (prev?.outputPath === outputPath ? null : prev));
  };

  const saveActiveDownloaded = async () => {
    if (!activeDownloaded || isSavingDownloaded) {
      return;
    }

    const selected = await open({
      title: "Choose save folder",
      directory: true,
      multiple: false,
    });

    if (typeof selected !== "string") {
      return;
    }

    setIsSavingDownloaded(true);
    setError("");
    setSavedNotice("");
    try {
      const saved = await invoke<string[]>("save_outputs", {
        destinationDir: selected,
        stagedPaths: [activeDownloaded.outputPath],
      });
      setSavedNotice(`Saved ${saved.length} file(s) to ${selected}`);
    } catch (saveError) {
      setError(stringifyError(saveError));
    } finally {
      setIsSavingDownloaded(false);
    }
  };

  const sendDownloadedToConvert = () => {
    if (!activeDownloaded) {
      return;
    }
    appendInputPaths([activeDownloaded.outputPath], setInputs, setError);
    closePlayerModal();
    setActivePanel("convert");
    setSavedNotice("Downloaded video added to Convert.");
  };

  const enterTrimMode = () => {
    if (!activeDownloaded) {
      return;
    }
    if (!canUseTrimEditor) {
      setError("Trim tool is available for MP4/WebM preview.");
      return;
    }

    const video = playerVideoRef.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
    if (trimDurationSeconds > 0) {
      setTrimStartSeconds(0);
      setTrimEndSeconds(trimDurationSeconds);
      setTrimSeekSeconds(0);
    }
    setIsTrimMode(true);
    setError("");
    setSavedNotice("");
  };

  const cancelTrimMode = () => {
    resetTrimEditor();
  };

  const seekPlayerTo = (seconds: number) => {
    const min = isTrimMode ? trimStartSeconds : 0;
    const max = isTrimMode && trimDurationSeconds > 0 ? trimEndSeconds : trimDurationSeconds || Number.MAX_SAFE_INTEGER;
    const next = clampNumber(Number.isFinite(seconds) ? seconds : 0, min, max);
    setTrimSeekSeconds(next);
    const video = playerVideoRef.current;
    if (video) {
      video.currentTime = next;
    }
  };

  const updateTrimStart = (nextStart: number) => {
    if (trimDurationSeconds <= 0) {
      return;
    }
    const upper = Math.max(0, trimEndSeconds - TRIM_MIN_DURATION_SECONDS);
    const normalized = clampNumber(nextStart, 0, upper);
    setTrimStartSeconds(normalized);
    if (trimSeekSeconds < normalized) {
      seekPlayerTo(normalized);
    }
  };

  const updateTrimEnd = (nextEnd: number) => {
    if (trimDurationSeconds <= 0) {
      return;
    }
    const lower = trimStartSeconds + TRIM_MIN_DURATION_SECONDS;
    const normalized = clampNumber(nextEnd, lower, trimDurationSeconds);
    setTrimEndSeconds(normalized);
    if (trimSeekSeconds > normalized) {
      seekPlayerTo(normalized);
    }
  };

  const onPlayerMetadataLoaded = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const duration = event.currentTarget.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }
    setTrimDurationSeconds(duration);
    setTrimStartSeconds(0);
    setTrimEndSeconds(duration);
    setTrimSeekSeconds(0);
  };

  const onPlayerTimeUpdate = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const current = event.currentTarget.currentTime;
    setTrimSeekSeconds(current);

    if (!isTrimMode || trimDurationSeconds <= 0) {
      return;
    }
    if (current < trimStartSeconds) {
      event.currentTarget.currentTime = trimStartSeconds;
      return;
    }
    if (current >= trimEndSeconds) {
      event.currentTarget.currentTime = trimStartSeconds;
      if (!event.currentTarget.paused) {
        const playPromise = event.currentTarget.play();
        if (playPromise && typeof playPromise.then === "function") {
          void playPromise.catch(() => undefined);
        }
      }
    }
  };

  const applyTrimSelection = async () => {
    if (!activeDownloaded || !trimSelectionReady || isTrimmingDownloaded) {
      return;
    }

    const baseOriginalPath = activeDownloaded.originalOutputPath ?? activeDownloaded.outputPath;
    const baseOriginalTitle =
      activeDownloaded.originalTitle ?? stripTrimSuffix(activeDownloaded.title);
    const previousTrimPath =
      activeDownloaded.isTrimmed && activeDownloaded.outputPath !== baseOriginalPath
        ? activeDownloaded.outputPath
        : null;

    setIsTrimmingDownloaded(true);
    setError("");
    setSavedNotice("");
    try {
      const outputPath = await invoke<string>("trim_downloaded_video", {
        inputPath: activeDownloaded.outputPath,
        startSeconds: trimStartSeconds,
        endSeconds: trimEndSeconds,
      });

      const trimmedItem: DownloadVideoResult = {
        url: activeDownloaded.url,
        title: `${baseOriginalTitle} (Trim)`,
        outputPath,
        isTrimmed: true,
        originalOutputPath: baseOriginalPath,
        originalTitle: baseOriginalTitle,
      };

      if (previousTrimPath) {
        await invoke("remove_staged_file", { stagedPath: previousTrimPath }).catch(() => undefined);
      }

      setDownloadedItems((prev) => {
        const filtered = prev.filter(
          (item) =>
            item.outputPath !== outputPath &&
            item.outputPath !== (previousTrimPath ?? "__none__"),
        );
        if (!filtered.some((item) => item.outputPath === baseOriginalPath)) {
          filtered.unshift({
            url: activeDownloaded.url,
            title: baseOriginalTitle,
            outputPath: baseOriginalPath,
          });
        }
        return [trimmedItem, ...filtered];
      });
      setActiveDownloaded(trimmedItem);
      setIsTrimMode(false);
      setSavedNotice("Trim complete.");
    } catch (trimError) {
      setError(stringifyError(trimError));
    } finally {
      setIsTrimmingDownloaded(false);
    }
  };

  const backToOriginalDownloaded = async () => {
    if (!activeDownloaded?.isTrimmed || !activeDownloaded.originalOutputPath) {
      return;
    }

    const trimPath = activeDownloaded.outputPath;
    const originalPath = activeDownloaded.originalOutputPath;
    const originalTitle =
      activeDownloaded.originalTitle ?? stripTrimSuffix(activeDownloaded.title);

    setError("");
    setSavedNotice("");
    try {
      await invoke("remove_staged_file", { stagedPath: trimPath });

      setDownloadedItems((prev) => {
        const filtered = prev.filter((item) => item.outputPath !== trimPath);
        if (!filtered.some((item) => item.outputPath === originalPath)) {
          filtered.unshift({
            url: activeDownloaded.url,
            title: originalTitle,
            outputPath: originalPath,
          });
        }
        return filtered;
      });

      setActiveDownloaded({
        url: activeDownloaded.url,
        title: originalTitle,
        outputPath: originalPath,
      });
      setIsTrimMode(false);
      setSavedNotice("Returned to original video.");
    } catch (revertError) {
      setError(stringifyError(revertError));
    }
  };

  const openSettings = () => {
    setUpdateCheckMessage("");
    setUpdateReleaseUrl(null);
    setSettingsOpen(true);
  };

  const checkForUpdates = async () => {
    setUpdateCheckBusy(true);
    setUpdateCheckMessage("");
    setUpdateReleaseUrl(null);
    try {
      const response = await fetch(GITHUB_RELEASES_API, {
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      });
      if (!response.ok) {
        setUpdateCheckMessage("업데이트 정보를 가져올 수 없습니다. 저장소에 릴리즈가 없을 수 있습니다.");
        return;
      }
      const data = (await response.json()) as { tag_name?: string; html_url?: string };
      const tagRaw = data.tag_name?.replace(/^v/i, "").trim() ?? "";
      if (!tagRaw) {
        setUpdateCheckMessage("릴리즈 태그를 읽을 수 없습니다.");
        return;
      }
      const hasNewer = isNewerSemver(tagRaw, appVersion);
      if (hasNewer) {
        setUpdateCheckMessage(`새 버전이 있습니다: v${tagRaw} (현재 v${appVersion})`);
        setUpdateReleaseUrl(data.html_url ?? GITHUB_RELEASES_PAGE);
      } else {
        setUpdateCheckMessage(`현재 v${appVersion}이(가) 최신입니다.`);
      }
    } catch {
      setUpdateCheckMessage("네트워크 오류로 업데이트를 확인하지 못했습니다.");
    } finally {
      setUpdateCheckBusy(false);
    }
  };

  const openReleasePage = async () => {
    const target = updateReleaseUrl ?? GITHUB_RELEASES_PAGE;
    try {
      if (isTauri()) {
        await openUrl(target);
      } else {
        window.open(target, "_blank", "noopener,noreferrer");
      }
    } catch {
      setError("브라우저에서 릴리즈 페이지를 열지 못했습니다.");
    }
  };

  const onHtmlDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropActive(false);
    const droppedPaths = getDroppedPaths(event.dataTransfer);
    if (droppedPaths.length > 0) {
      appendInputPaths(droppedPaths, setInputs, setError);
      setSavedNotice("");
    }
  };

  const downloadPlayerActions: PlayerModalAction[] = isTrimMode
    ? [
        {
          id: "cancel-trim",
          label: "Cancel",
          disabled: isTrimmingDownloaded,
          onClick: cancelTrimMode,
        },
        {
          id: "save-trim",
          label: "Save",
          pendingLabel: "Saving...",
          pending: isTrimmingDownloaded,
          disabled: !activeDownloaded || !trimSelectionReady,
          primary: true,
          onClick: () => {
            void applyTrimSelection();
          },
        },
      ]
    : [
        {
          id: "save",
          label: "Save",
          pendingLabel: "Saving...",
          pending: isSavingDownloaded,
          disabled: !activeDownloaded,
          onClick: () => {
            void saveActiveDownloaded();
          },
        },
        {
          id: "convert",
          label: "Convert",
          disabled: !activeDownloaded,
          onClick: sendDownloadedToConvert,
        },
        ...(isShowingTrimmedVersion
          ? [
              {
                id: "back-to-original",
                label: "Back to Original",
                disabled: !activeDownloaded,
                onClick: () => {
                  void backToOriginalDownloaded();
                },
              },
            ]
          : []),
        {
          id: "trim",
          label: "Trim",
          disabled: !activeDownloaded || !canUseTrimEditor,
          primary: true,
          onClick: enterTrimMode,
        },
      ];

  const trimToolBody =
    isTrimMode && canUseTrimEditor ? (
      <section className="trim-tool">
        <div className="trim-tool-stats">
          <span>Start {formatSecondsClock(trimStartSeconds)}</span>
          <span>Seek {formatSecondsClock(trimSeekSeconds)}</span>
          <span>End {formatSecondsClock(trimEndSeconds)}</span>
          <strong>Length {formatSecondsClock(trimSelectionDuration)}</strong>
        </div>

        <div className="trim-range-stack">
          <div className="trim-range-track">
            <div
              className="trim-range-selected"
              style={{
                left: `${Math.max(0, Math.min(100, trimSelectionLeftPercent))}%`,
                width: `${Math.max(0, Math.min(100, trimSelectionWidthPercent))}%`,
              }}
            />
            <div
              className="trim-range-seek"
              style={{
                left: `${Math.max(
                  0,
                  Math.min(
                    100,
                    trimDurationSeconds > 0 ? (trimSeekSeconds / trimDurationSeconds) * 100 : 0,
                  ),
                )}%`,
              }}
            />
          </div>
          <label className="trim-slider-label">
            Start
          </label>
          <input
            type="range"
            min={0}
            max={trimDurationSeconds || 0}
            step={0.01}
            value={trimStartSeconds}
            disabled={trimDurationSeconds <= 0 || isTrimmingDownloaded}
            onChange={(event) => updateTrimStart(Number(event.target.value))}
            className="trim-handle trim-handle-start"
          />
          <label className="trim-slider-label">
            End
          </label>
          <input
            type="range"
            min={0}
            max={trimDurationSeconds || 0}
            step={0.01}
            value={trimEndSeconds}
            disabled={trimDurationSeconds <= 0 || isTrimmingDownloaded}
            onChange={(event) => updateTrimEnd(Number(event.target.value))}
            className="trim-handle trim-handle-end"
          />
        </div>

        <label className="trim-seek-label">
          Timeline Seek
          <input
            type="range"
            min={trimStartSeconds}
            max={trimEndSeconds}
            step={0.01}
            value={clampNumber(trimSeekSeconds, trimStartSeconds, trimEndSeconds)}
            disabled={trimDurationSeconds <= 0 || trimEndSeconds <= trimStartSeconds}
            onChange={(event) => seekPlayerTo(Number(event.target.value))}
          />
        </label>
      </section>
    ) : null;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <h1>HMLH Converter</h1>
          <p>Encode Workbench</p>
        </div>

        <section className="side-block">
          <div className="line-row">
            <strong>System</strong>
            <span className={`pill ${ffmpegStatus?.available ? "good" : "bad"}`}>
              FFmpeg {ffmpegStatus?.available ? "Ready" : "Missing"}
            </span>
          </div>
          <p className="muted line-clamp">
            {ffmpegStatus?.version ?? ffmpegStatus?.message ?? "Checking FFmpeg status..."}
          </p>
          <div className="line-row">
            <button type="button" onClick={refreshFfmpegStatus}>
              Refresh
            </button>
          </div>
        </section>

        <section className="side-block side-block-fill">
          <div className="line-row">
            <strong>Jobs</strong>
            <span className="muted">
              Run {queueSnapshot.runningJobIds.length} / Queue {queueSnapshot.queuedJobIds.length}
            </span>
          </div>

          {recentJobs.length === 0 && <p className="muted">No jobs yet.</p>}

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
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => selectPreviewByJobId(job.jobId)}
                      disabled={job.status !== "completed" || !job.outputPath}
                    >
                      View
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {extraJobsCount > 0 && <p className="muted">+{extraJobsCount} more jobs</p>}
        </section>

        <footer className="sidebar-footer">
          <span className="sidebar-version muted" title={`HMLH Converter v${appVersion}`}>
            v{appVersion}
          </span>
          <button type="button" className="sidebar-settings-btn" onClick={openSettings}>
            설정
          </button>
        </footer>
      </aside>

      <section className={`workspace ${activePanel === "preview" ? "workspace-preview" : ""}`}>
        <header className="workspace-head">
          <div className="mode-switch">
            <button
              type="button"
              className={activePanel === "convert" ? "active" : ""}
              onClick={() => setActivePanel("convert")}
            >
              Convert
            </button>
            <button
              type="button"
              className={activePanel === "download" ? "active" : ""}
              onClick={() => setActivePanel("download")}
            >
              Download
            </button>
            <button
              type="button"
              className={activePanel === "preview" ? "active" : ""}
              onClick={() => setActivePanel("preview")}
            >
              Preview
            </button>
          </div>
        </header>

        {activePanel === "convert" && (
          <div
            className={`drop-screen ${isDropActive ? "active" : ""} ${inputs.length > 0 ? "has-items" : ""}`}
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
            {inputs.length === 0 ? (
              <>
                <button type="button" className="drop-circle" onClick={pickInputs}>
                  <span className="center-mark">+</span>
                </button>
                <p className="drop-title">Drag & Drop</p>
                <p className="muted">Drop files or click the circle</p>
              </>
            ) : (
              <>
                <div className="drop-grid">
                  {dropGridItems.map((path, index) => (
                    <button
                      type="button"
                      className="drop-grid-item"
                      key={path}
                      title={path}
                      onClick={() => setInputs((prev) => prev.filter((current) => current !== path))}
                    >
                      <div className="drop-grid-thumb">
                        {getInputPreviewKind(path) === "image" ? (
                          <img src={toPreviewSource(path)} alt={getFileName(path)} />
                        ) : (
                          <video
                            src={toPreviewSource(path)}
                            muted
                            playsInline
                            preload="auto"
                            onLoadedData={(event) => {
                              event.currentTarget.currentTime = 0;
                            }}
                          />
                        )}
                      </div>
                      <div className="drop-grid-meta">
                        <span>{index + 1}</span>
                        <strong>{getFileName(path)}</strong>
                      </div>
                    </button>
                  ))}
                  <button type="button" className="drop-grid-item drop-grid-add" onClick={pickInputs}>
                    <div className="drop-grid-thumb drop-grid-thumb-add">+</div>
                    <div className="drop-grid-meta">
                      <span>Quick action</span>
                      <strong>Add</strong>
                    </div>
                  </button>
                </div>
                {extraDropItemsCount > 0 && (
                  <p className="muted">+{extraDropItemsCount} more files selected</p>
                )}
                {isDropActive && <div className="drop-grid-dnd-hint">Add more files</div>}
              </>
            )}
          </div>
        )}

        {activePanel === "download" && (
          <section className="download-screen">
            <div className="line-row">
              <strong>Downloader</strong>
              <span className="muted">
                {isDownloading
                  ? downloadProgress !== null
                    ? `Downloading ${Math.round(downloadProgress)}%`
                    : "Downloading..."
                  : `${downloadedItems.length} file(s)`}
              </span>
            </div>

            {(isProbingLink || linkPreview) && (
              <div className="download-link-preview">
                {linkPreview?.thumbnailUrl ? (
                  <img src={linkPreview.thumbnailUrl} alt={linkPreview.title} />
                ) : (
                  <div className="download-link-thumb-fallback">No Thumb</div>
                )}
                <div className="download-link-meta">
                  <strong>{linkPreview?.title ?? "Fetching video info..."}</strong>
                  <span className="muted">
                    {linkPreview?.duration
                      ? `Duration ${linkPreview.duration}`
                      : isProbingLink
                        ? "Loading metadata..."
                        : "Metadata unavailable"}
                  </span>
                </div>
              </div>
            )}

            <label>
              Video link
              <input
                value={downloadUrl}
                placeholder="https://www.youtube.com/watch?v=..."
                onChange={(event) => setDownloadUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void startDownloadFromUrl();
                  }
                }}
              />
            </label>

            <div className="line-row action-row">
              <button
                type="button"
                className="primary"
                onClick={() => void startDownloadFromUrl()}
                disabled={isDownloading}
              >
                {isDownloading
                  ? downloadProgress !== null
                    ? `Downloading ${Math.round(downloadProgress)}%`
                    : "Downloading..."
                  : "Download"}
              </button>
              <button
                type="button"
                onClick={clearDownloadState}
                disabled={!downloadUrl.trim() && !hasDownloadedItems}
              >
                Clear
              </button>
            </div>

            {isDownloading && (
              <div className="download-progress-wrap" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(downloadProgress ?? 0)}>
                <div
                  className="download-progress-bar"
                  style={{ width: `${Math.max(0, Math.min(100, downloadProgress ?? 0))}%` }}
                />
              </div>
            )}

            {!activeDownloaded && (
              <p className="muted">Download complete video opens in a reusable player modal.</p>
            )}

            {activeDownloaded && (
              <div className="line-row action-row">
                <button
                  type="button"
                  className="primary"
                  onClick={() => setIsPlayerModalOpen(true)}
                >
                  Open Player
                </button>
              </div>
            )}

            {downloadedItems.length > 0 && (
              <ul className="download-list">
                {downloadedItems.map((item) => (
                  <li
                    key={item.outputPath}
                    className={`download-item ${activeDownloaded?.outputPath === item.outputPath ? "active" : ""}`}
                  >
                    <button type="button" className="download-item-open" onClick={() => selectDownloadedItem(item)}>
                      <span>{item.title}</span>
                      <span className="muted line-clamp">{item.outputPath}</span>
                    </button>
                    <button type="button" onClick={() => removeDownloadedItem(item.outputPath)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {activePanel === "preview" && (
          <div className="preview-screen">
            {!previewReady && <p className="muted">Completed output will appear here.</p>}

            {previewReady && (
              <>
                <div className="preview-nav">
                  <button
                    type="button"
                    onClick={showPreviousPreview}
                    disabled={completedJobs.length <= 1}
                  >
                    {"<"}
                  </button>
                  <span className="muted">
                    {previewIndex + 1} / {completedJobs.length}
                  </span>
                  <button
                    type="button"
                    onClick={showNextPreview}
                    disabled={completedJobs.length <= 1}
                  >
                    {">"}
                  </button>
                </div>
                <div className="preview-frame">
                  {previewType === "gif" && (
                    <img className="preview-media" src={previewSource} alt="output preview" />
                  )}
                  {(previewType === "mp4" || previewType === "webm") && (
                    <video className="preview-media" src={previewSource} controls />
                  )}
                  {previewType === null && <p className="muted">Unsupported preview format.</p>}
                </div>
                <p className="muted line-clamp">{previewOutputPath}</p>
              </>
            )}
          </div>
        )}

        {activePanel === "convert" && (
          <section className="selection-panel control-panel">
            <div className="line-row">
              <strong>Encoding Options</strong>
              <span className="muted">Selected files {inputs.length}</span>
            </div>

            <div className="control-grid">
              <label>
                Preset
                <select
                  value={selectedPresetId}
                  onChange={(event) => applyPreset(event.target.value)}
                >
                  <option value="">None</option>
                  {allPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Format
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
                Quality
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
                Concurrent
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
              Filename suffix
              <input
                value={form.nameSuffix}
                placeholder="example: sns"
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
                Keep audio
              </label>
              <span className="muted">
                Run {queueSnapshot.runningJobIds.length} / Queue {queueSnapshot.queuedJobIds.length}
              </span>
            </div>

            <p className="muted">
              Converted files stay in app staging memory until you press Save.
            </p>

            <div className="line-row action-row">
              <button type="button" onClick={saveCurrentPreset}>
                Save Preset
              </button>
              <button
                type="button"
                className="primary"
                onClick={submitBatch}
                disabled={isSubmitting || inputs.length === 0}
              >
                {isSubmitting ? "Queueing..." : `Start Convert (${inputs.length})`}
              </button>
            </div>
          </section>
        )}

        {activePanel === "preview" && (
          <section className="preview-action-dock">
            <div className="line-row preview-actions">
              <button
                type="button"
                onClick={clearWorkspaceSelections}
                disabled={
                  hasActiveJobs ||
                  (inputs.length === 0 && allJobs.length === 0 && downloadedItems.length === 0)
                }
              >
                Clear
              </button>
              {completedJobs.length > 0 && (
                <button
                  type="button"
                  className="primary"
                  onClick={saveAllOutputs}
                  disabled={!canSaveOutputs || isSavingOutputs}
                >
                  {isSavingOutputs ? "Saving..." : `Save (${completedJobs.length})`}
                </button>
              )}
            </div>
          </section>
        )}
      </section>

      {savedNotice && <p className="notice-banner">{savedNotice}</p>}
      {error && <p className="error-banner">{error}</p>}

      <ReusablePlayerModal
        isOpen={isPlayerModalOpen}
        title={activeDownloaded?.title ?? "Downloaded Video"}
        outputPath={activeDownloaded?.outputPath ?? ""}
        mediaType={activeDownloadedType}
        source={activeDownloadedSource}
        isTrimMode={isTrimMode}
        actions={downloadPlayerActions}
        videoRef={playerVideoRef}
        onVideoLoadedMetadata={onPlayerMetadataLoaded}
        onVideoTimeUpdate={onPlayerTimeUpdate}
        onClose={closePlayerModal}
        extraBody={trimToolBody}
      />

      {settingsOpen && (
        <div
          className="settings-modal-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSettingsOpen(false);
            }
          }}
        >
          <div
            className="settings-modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-head">
              <h2 id="settings-modal-title">설정</h2>
              <button
                type="button"
                className="settings-modal-close"
                onClick={() => setSettingsOpen(false)}
                aria-label="닫기"
              >
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <p className="settings-about">
                <strong>HMLH Converter</strong>는 FFmpeg 기반 데스크톱 인코더입니다. 비디오를 GIF·MP4·WebM으로
                변환하고, 드래그 앤 드롭으로 여러 파일을 한 번에 큐에 넣어 인코딩할 수 있습니다. 프리셋·동시
                작업 수·품질 옵션으로 워크플로를 조절할 수 있습니다.
              </p>
              <p className="muted settings-version-line">이 기기에서 실행 중인 버전: v{appVersion}</p>
              <div className="settings-actions">
                <button type="button" onClick={checkForUpdates} disabled={updateCheckBusy}>
                  {updateCheckBusy ? "확인 중…" : "업데이트 확인"}
                </button>
                {updateReleaseUrl && (
                  <button type="button" className="primary" onClick={() => void openReleasePage()}>
                    릴리즈 페이지 열기
                  </button>
                )}
              </div>
              {updateCheckMessage && <p className="settings-update-msg">{updateCheckMessage}</p>}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

interface ReusablePlayerModalProps {
  isOpen: boolean;
  title: string;
  outputPath: string;
  source: string;
  mediaType: OutputFormat | null;
  isTrimMode: boolean;
  actions: PlayerModalAction[];
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  onVideoLoadedMetadata?: (event: React.SyntheticEvent<HTMLVideoElement>) => void;
  onVideoTimeUpdate?: (event: React.SyntheticEvent<HTMLVideoElement>) => void;
  onClose: () => void;
  extraBody?: ReactNode;
}

function ReusablePlayerModal({
  isOpen,
  title,
  outputPath,
  source,
  mediaType,
  isTrimMode,
  actions,
  videoRef,
  onVideoLoadedMetadata,
  onVideoTimeUpdate,
  onClose,
  extraBody,
}: ReusablePlayerModalProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="player-modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="player-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="player-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="player-modal-head">
          <h2 id="player-modal-title">{title}</h2>
          <button
            type="button"
            className="player-modal-close"
            onClick={onClose}
            aria-label="Close player"
          >
            x
          </button>
        </div>

        <div className="player-modal-body">
          <div className="preview-frame player-modal-frame">
            {mediaType === "mp4" || mediaType === "webm" ? (
              <video
                ref={videoRef}
                className="preview-media"
                src={source}
                controls={!isTrimMode}
                muted={isTrimMode}
                playsInline
                onLoadedMetadata={onVideoLoadedMetadata}
                onTimeUpdate={onVideoTimeUpdate}
              />
            ) : mediaType === "gif" ? (
              <img className="preview-media" src={source} alt="download preview" />
            ) : (
              <p className="muted">Preview is not available for this format.</p>
            )}
          </div>

          {outputPath && <p className="muted line-clamp">{outputPath}</p>}

          <div className="line-row action-row player-modal-actions">
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                className={action.primary ? "primary" : ""}
                onClick={action.onClick}
                disabled={action.pending || action.disabled}
              >
                {action.pending ? action.pendingLabel ?? action.label : action.label}
              </button>
            ))}
          </div>

          {extraBody}
        </div>
      </div>
    </div>
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
    setError("Only supported video files can be added.");
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

function formatSecondsClock(totalSeconds: number): string {
  const safe = Math.max(0, Number.isFinite(totalSeconds) ? totalSeconds : 0);
  const minutes = Math.floor(safe / 60);
  const seconds = safe - minutes * 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toFixed(2).padStart(5, "0")}`;
}

function stripTrimSuffix(title: string): string {
  return title.replace(/\s+\(Trim\)\s*$/i, "").trim() || "Downloaded video";
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

function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.substring(normalized.lastIndexOf("/") + 1);
}

function getInputPreviewKind(path: string): "video" | "image" {
  const extension = getFileExtension(path);
  if (!extension) {
    return "video";
  }

  if (["jpg", "jpeg", "png", "webp", "bmp", "gif"].includes(extension)) {
    return "image";
  }
  return "video";
}

function getDroppedPaths(dataTransfer: DataTransfer): string[] {
  const files = Array.from(dataTransfer.files);
  return files
    .map((file) => (file as File & { path?: string }).path)
    .filter((path): path is string => Boolean(path && path.trim()));
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeSemverParts(version: string): [number, number, number] {
  const cleaned = version.replace(/^v/i, "").trim();
  const parts = cleaned.split(/[.\-+]/).map((segment) => {
    const n = Number.parseInt(segment, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  const c = parts[2] ?? 0;
  return [a, b, c];
}

function isNewerSemver(latest: string, current: string): boolean {
  const L = normalizeSemverParts(latest);
  const C = normalizeSemverParts(current);
  for (let i = 0; i < 3; i += 1) {
    if (L[i] > C[i]) {
      return true;
    }
    if (L[i] < C[i]) {
      return false;
    }
  }
  return false;
}

export default App;
