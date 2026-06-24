import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WifiOff } from "lucide-react";
import { AudioCapture } from "./lib/audioCapture";
import { PcmStreamPlayer } from "./lib/pcmPlayer";
import {
  createConversation,
  deleteConversation,
  fetchConversation,
  fetchConversationMessages,
  fetchConversations,
  fetchCurrentUser,
  loadStoredAuth,
  renameConversation,
  storeAuth,
  type AuthSession,
  type PersistedConversation,
  type PersistedMessage,
} from "./lib/api";
import { GatewayClient } from "./lib/wsClient";
import { AuthView } from "./features/auth/AuthView";
import { ChatView } from "./features/chat/ChatView";
import { HistoryRail } from "./features/conversations/HistoryRail";
import { ApiKeyManagementView } from "./features/settings/ApiKeyManagementView";
import { SettingsView } from "./features/settings/SettingsView";
import { UsageStatsView } from "./features/usage/UsageStatsView";
import type { ChatMessage, CostSnapshot, GatewayEvent, VadSnapshot } from "./types";

const visualKeywords = ["看", "看到", "这个", "那个", "画面", "颜色", "桌", "手里", "旁边", "前面", "物体", "摄像头"];
const SPEECH_AUTO_SEND_DELAY_MS = 2600;
const SPEECH_FINAL_SETTLE_DELAY_MS = 1800;
const DUPLICATE_SPEECH_WINDOW_MS = 1800;
const TTS_ASR_SUPPRESSION_MS = 900;
const NEW_SESSION_BUSY_ID = "__new_session__";
const BLUR_THRESHOLD = 80;
const MAX_REALTIME_IMAGE_BASE64_BYTES = 240 * 1024;
const MAX_OCR_IMAGE_BASE64_BYTES = 800 * 1024;
const MEDICATION_CAPTURE_DELAY_MS = 4500;
const CAPTURE_VIDEO_READY_TIMEOUT_MS = 3000;
const ELECTRONIC_TTS_ENABLED = false;
const VOICE_STORAGE_KEY = "ai-vision-realtime-voice";
const realtimeVoices = ["Cherry", "Serena", "Ethan", "Chelsie"] as const;
type RealtimeVoice = (typeof realtimeVoices)[number];

const emptyCost: CostSnapshot = {
  audioSeconds: 0,
  speechSeconds: 0,
  audioChunks: 0,
  visionFrames: 0,
  visionCacheHits: 0,
  llmInputTokens: 0,
  llmOutputTokens: 0,
  llmInputTokensEst: 0,
  llmOutputTokensEst: 0,
  ttsChars: 0,
  ttsAudioSeconds: 0,
  interruptions: 0,
  estimatedUnits: 0,
};

type AppView = "chat" | "settings" | "apiKeys" | "usage";
type AiState = "idle" | "listening" | "processing" | "speaking";
type MediaAction = "start" | "stop" | null;
type DeviceStatus = "idle" | "requesting" | "active" | "blocked" | "error";
type SessionMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};
type SessionListItem = SessionMeta;

function uid() {
  return crypto.randomUUID();
}

function containsVisualIntent(text: string) {
  return visualKeywords.some((keyword) => text.includes(keyword));
}

function containsMedicationInstructionIntent(text: string) {
  const clean = text.replace(/\s+/g, "");
  const strong = ["这个药怎么吃", "这药怎么吃", "药品说明书", "药盒上的用法用量", "药瓶上的用法用量"];
  if (strong.some((keyword) => clean.includes(keyword))) return true;
  const objectKeywords = ["药品", "药盒", "药瓶", "这个药", "用法用量", "禁忌", "副作用"];
  const actionKeywords = ["帮我看", "识别", "读一下", "怎么吃", "能不能吃", "一天几次", "吃几片", "饭前", "饭后"];
  return objectKeywords.some((keyword) => clean.includes(keyword)) && actionKeywords.some((keyword) => clean.includes(keyword));
}

function isNonBlockingRealtimeError(code: string, message: string) {
  const normalized = `${code} ${message}`.toLowerCase();
  return (
    code === "realtime_error" ||
    code === "realtime_image_failed" ||
    normalized.includes("append image before append audio") ||
    normalized.includes("none active response") ||
    normalized.includes("input_image_buffer") ||
    normalized.includes("response.cancel")
  );
}

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function timeLabel(timestamp = Date.now()) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function createStarterMessages(): ChatMessage[] {
  return [{ id: uid(), role: "system", text: "混合流式助手已就绪：音频全流式、文本流式、视觉关键帧准实时。" }];
}

function loadStoredVoice(): RealtimeVoice {
  const stored = localStorage.getItem(VOICE_STORAGE_KEY);
  return realtimeVoices.includes(stored as RealtimeVoice) ? (stored as RealtimeVoice) : "Cherry";
}

function imagePayloadSize(dataUrl: string) {
  return dataUrl.slice(dataUrl.indexOf(",") + 1).length;
}

function mediaErrorMessage(deviceName: "摄像头" | "麦克风", error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") return `${deviceName}权限被拒绝，请在浏览器地址栏权限设置中允许后重试。`;
    if (error.name === "NotFoundError") return `没有检测到可用的${deviceName}设备。`;
    if (error.name === "NotReadableError") return `${deviceName}被其他应用占用，请关闭占用后重试。`;
  }
  return error instanceof Error ? error.message : String(error);
}

function mediaStatusFromError(error: unknown): DeviceStatus {
  return error instanceof DOMException && error.name === "NotAllowedError" ? "blocked" : "error";
}

function gatewayUrlWithToken(url: string, token?: string, conversationId?: string) {
  if (!token) return url;
  const next = new URL(url);
  next.searchParams.set("token", token);
  if (conversationId) next.searchParams.set("conversationId", conversationId);
  return next.toString();
}

function conversationToSession(conversation: PersistedConversation): SessionMeta {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: timeLabel(conversation.createdAt),
    updatedAt: timeLabel(conversation.updatedAt),
    messageCount: conversation.messageCount,
  };
}

function persistedMessagesToChat(messages: PersistedMessage[]): ChatMessage[] {
  if (messages.length === 0) return createStarterMessages();
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
  }));
}

function isCostSnapshot(value: unknown): value is CostSnapshot {
  return Boolean(value && typeof value === "object" && "audioSeconds" in value && "estimatedUnits" in value);
}

export function App() {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
  const [authSession, setAuthSession] = useState<AuthSession | null>(() => loadStoredAuth());
  const gatewayUrl = import.meta.env.VITE_GATEWAY_URL ?? "ws://localhost:8000/ws";
  const initialSessionId = useMemo(() => uid(), []);
  const [currentSessionId, setCurrentSessionId] = useState<string>(initialSessionId);
  const authedGatewayUrl = useMemo(
    () => gatewayUrlWithToken(gatewayUrl, authSession?.accessToken, currentSessionId),
    [authSession?.accessToken, currentSessionId, gatewayUrl],
  );
  const client = useMemo(() => new GatewayClient(authedGatewayUrl), [authedGatewayUrl]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sampleRef = useRef<HTMLCanvasElement | null>(null);
  const audioCaptureRef = useRef<AudioCapture | null>(null);
  const audioPlayerRef = useRef<PcmStreamPlayer | null>(null);
  const recognitionRef = useRef<any>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const assistantMessageIdRef = useRef<string | null>(null);
  const assistantPlaceholderRef = useRef(false);
  const assistantTextRef = useRef("");
  const assistantTextFromTtsRef = useRef(false);
  const assistantAudioClipsRef = useRef<Record<string, Array<{ audio: string; sampleRate: number }>>>({});
  const ttsQueueRef = useRef<string[]>([]);
  const ttsPlayingRef = useRef(false);
  const ttsAsrSuppressedUntilRef = useRef(0);
  const ttsReleaseTimerRef = useRef(0);
  const medicationCaptureTimerRef = useRef(0);
  const recognitionPausedForTtsRef = useRef(false);
  const recognitionDisabledRef = useRef(false);
  const recognitionRestartTimerRef = useRef(0);
  const recognitionStarterRef = useRef<() => void>(() => {});
  const pendingSpeechRef = useRef("");
  const pendingSpeechTimerRef = useRef(0);
  const lastSubmittedSpeechRef = useRef<{ text: string; at: number } | null>(null);
  const lastSampleRef = useRef<Uint8ClampedArray | null>(null);
  const lastVisionAtRef = useRef(0);
  const audioReadyForVisionRef = useRef(false);
  const pendingSpeechFrameTimerRef = useRef(0);
  const speechFrameCountRef = useRef(0);
  const lastSpeechFrameAtRef = useRef(0);
  const lastRealtimeAsrAtRef = useRef(0);
  const realtimeAudioRef = useRef(false);
  const modelAudioPlayingRef = useRef(false);
  const runningRef = useRef(false);
  const aiStateRef = useRef<AiState>("idle");

  const [, setConnectionState] = useState("closed");
  const [, setSessionReady] = useState(false);
  const [, setMediaReady] = useState(false);
  const [mediaState, setMediaState] = useState("idle");
  const [mediaAction, setMediaAction] = useState<MediaAction>(null);
  const [cameraStatus, setCameraStatus] = useState<DeviceStatus>("idle");
  const [microphoneStatus, setMicrophoneStatus] = useState<DeviceStatus>("idle");
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState("");
  const [sessions, setSessions] = useState<SessionMeta[]>([
    { id: initialSessionId, title: "当前会话", createdAt: timeLabel(), updatedAt: timeLabel(), messageCount: 0 },
  ]);
  const [sessionMessages, setSessionMessages] = useState<Record<string, ChatMessage[]>>({
    [initialSessionId]: createStarterMessages(),
  });
  const [cost, setCost] = useState<CostSnapshot>(emptyCost);
  const [manualText, setManualText] = useState("");
  const [lastError, setLastError] = useState("");
  const [authError, setAuthError] = useState("");
  const [, setPermissionStatus] = useState("等待启动");
  const [, setAsrStatus] = useState("未启动");
  const [activeView, setActiveView] = useState<AppView>("chat");
  const [aiState, setAiState] = useState<AiState>("idle");
  const [selectedVoice, setSelectedVoice] = useState<RealtimeVoice>(() => loadStoredVoice());
  const [, setRealtimeAudio] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [videoPanePercent, setVideoPanePercent] = useState(57.14);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [historyBusySessionId, setHistoryBusySessionId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState("");

  const messages = sessionMessages[currentSessionId] ?? [];
  const setMessages = useCallback(
    (updater: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => {
      setSessionMessages((store) => {
        const current = store[currentSessionId] ?? createStarterMessages();
        const next = typeof updater === "function" ? updater(current) : updater;
        return { ...store, [currentSessionId]: next };
      });
    },
    [currentSessionId],
  );

  const isProcessing = Boolean(assistantMessageIdRef.current);
  const canSend = manualText.trim().length > 0;
  const historySessions = useMemo<SessionListItem[]>(
    () => sessions,
    [sessions],
  );

  useEffect(() => {
    aiStateRef.current = aiState;
  }, [aiState]);

  useEffect(() => {
    if (!authSession?.accessToken) return;
    let active = true;
    void fetchCurrentUser(apiBaseUrl, authSession.accessToken)
      .then((user) => {
        if (!active) return;
        const next = { ...authSession, user };
        setAuthSession(next);
        storeAuth(next);
      })
      .catch(() => {
        if (!active) return;
        setAuthSession(null);
        storeAuth(null);
      });
    return () => {
      active = false;
    };
  }, [apiBaseUrl, authSession?.accessToken]);

  const loadConversation = useCallback(
    async (conversationId: string, token = authSession?.accessToken) => {
      if (!token) return;
      const persistedMessages = await fetchConversationMessages(apiBaseUrl, token, conversationId);
      setSessionMessages((store) => ({
        ...store,
        [conversationId]: persistedMessagesToChat(persistedMessages),
      }));
    },
    [apiBaseUrl, authSession?.accessToken],
  );

  const refreshConversationMeta = useCallback(
    async (conversationId = currentSessionId, token = authSession?.accessToken, syncCost = conversationId === currentSessionId) => {
      if (!token || !conversationId) return;
      try {
        const conversation = await fetchConversation(apiBaseUrl, token, conversationId);
        const nextSession = conversationToSession(conversation);
        setSessions((current) =>
          current.some((session) => session.id === conversation.id)
            ? current.map((session) => (session.id === conversation.id ? nextSession : session))
            : [nextSession, ...current],
        );
        if (syncCost && isCostSnapshot(conversation.latestCost)) {
          setCost(conversation.latestCost);
        }
      } catch {
        // Keep the active conversation usable even if a background refresh fails.
      }
    },
    [apiBaseUrl, authSession?.accessToken, currentSessionId],
  );

  useEffect(() => {
    if (!authSession?.accessToken) return;
    let active = true;
    setConversationsLoaded(false);
    void (async () => {
      try {
        let persisted = await fetchConversations(apiBaseUrl, authSession.accessToken);
        if (persisted.length === 0) {
          persisted = [await createConversation(apiBaseUrl, authSession.accessToken, "新会话")];
        }
        if (!active) return;
        setSessions(persisted.map(conversationToSession));
        const first = persisted[0];
        setCurrentSessionId(first.id);
        setCost(isCostSnapshot(first.latestCost) ? first.latestCost : emptyCost);
        await loadConversation(first.id, authSession.accessToken);
        if (active) setConversationsLoaded(true);
      } catch (error) {
        if (!active) return;
        setLastError(error instanceof Error ? error.message : "加载会话失败");
        setConversationsLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [apiBaseUrl, authSession?.accessToken, loadConversation]);

  const appendMessage = useCallback((message: ChatMessage) => {
    setMessages((current) => [...current.slice(-40), message]);
  }, [setMessages]);

  const updateAssistantDelta = useCallback((delta: string, source: "llm" | "tts" = "llm") => {
    assistantTextRef.current = assistantPlaceholderRef.current ? delta : assistantTextRef.current + delta;
    assistantTextFromTtsRef.current = source === "tts";
    setMessages((current) => {
      let id = assistantMessageIdRef.current;
      if (!id) {
        id = uid();
        assistantMessageIdRef.current = id;
        assistantPlaceholderRef.current = false;
        return [...current, { id, role: "assistant", text: delta, streaming: true }];
      }
      return current.map((message) =>
        message.id === id
          ? { ...message, text: assistantPlaceholderRef.current ? delta : message.text + delta, streaming: true }
          : message,
      );
    });
    assistantPlaceholderRef.current = false;
  }, [setMessages]);

  const beginAssistantResponse = useCallback(() => {
    const id = uid();
    assistantMessageIdRef.current = id;
    assistantAudioClipsRef.current[id] = [];
    assistantPlaceholderRef.current = true;
    assistantTextRef.current = "";
    assistantTextFromTtsRef.current = false;
    setAiState("processing");
    setMessages((current) => [...current, { id, role: "assistant", text: "", streaming: true }]);
  }, [setMessages]);

  const finishAssistant = useCallback((cancelled: boolean) => {
    const id = assistantMessageIdRef.current;
    setMessages((current) =>
      current.map((message) =>
        message.id === id
          ? {
              ...message,
              text: cancelled && message.text.trim() ? `${message.text}\n[已中断]` : message.text,
              streaming: false,
            }
          : message,
      ),
    );
    assistantMessageIdRef.current = null;
    assistantPlaceholderRef.current = false;
    assistantTextRef.current = "";
    assistantTextFromTtsRef.current = false;
    if (!ttsPlayingRef.current && ttsQueueRef.current.length === 0 && !modelAudioPlayingRef.current) {
      setAiState(runningRef.current ? "listening" : "idle");
    }
  }, [setMessages]);

  const clearEmptyAssistantPlaceholder = useCallback(() => {
    const id = assistantMessageIdRef.current;
    if (!id || !assistantPlaceholderRef.current || assistantTextRef.current.trim()) return;
    setMessages((current) => current.filter((message) => message.id !== id));
    assistantMessageIdRef.current = null;
    assistantPlaceholderRef.current = false;
    assistantTextRef.current = "";
    assistantTextFromTtsRef.current = false;
  }, [setMessages]);

  const clearPendingSpeech = useCallback(() => {
    pendingSpeechRef.current = "";
    window.clearTimeout(pendingSpeechTimerRef.current);
    setPartial("");
  }, []);

  const stopModelAudio = useCallback(() => {
    audioPlayerRef.current?.stop();
    modelAudioPlayingRef.current = false;
  }, []);

  const ensureAudioPlayer = useCallback(() => {
    if (!audioPlayerRef.current) {
      audioPlayerRef.current = new PcmStreamPlayer(
        () => {
          modelAudioPlayingRef.current = true;
          setAiState("speaking");
        },
        () => {
          modelAudioPlayingRef.current = false;
          if (!assistantMessageIdRef.current) setAiState(runningRef.current ? "listening" : "idle");
        },
      );
    }
    return audioPlayerRef.current;
  }, []);

  const suppressAsrForTts = useCallback((durationMs = TTS_ASR_SUPPRESSION_MS) => {
    ttsAsrSuppressedUntilRef.current = Math.max(ttsAsrSuppressedUntilRef.current, Date.now() + durationMs);
  }, []);

  const isAsrSuppressedForTts = useCallback(
    () =>
      ttsPlayingRef.current ||
      ttsQueueRef.current.length > 0 ||
      recognitionPausedForTtsRef.current ||
      Date.now() < ttsAsrSuppressedUntilRef.current,
    [],
  );

  const processTtsQueue = useCallback(() => {
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    recognitionPausedForTtsRef.current = false;
  }, []);

  const enqueueSpeech = useCallback(
    (text: string) => {
      if (!ELECTRONIC_TTS_ENABLED) return;
      if (!text.trim()) return;
      ttsQueueRef.current.push(text.trim());
      processTtsQueue();
    },
    [processTtsQueue],
  );

  const stopSpeech = useCallback(() => {
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    ttsAsrSuppressedUntilRef.current = 0;
    window.clearTimeout(ttsReleaseTimerRef.current);
    recognitionPausedForTtsRef.current = false;
    setAiState(runningRef.current ? "listening" : "idle");
  }, []);

  const interruptActiveSpeech = useCallback(
    (reason = "barge_in") => {
      client.send("speech.cancel", { reason });
      clearPendingSpeech();
      stopModelAudio();
      stopSpeech();
      if (assistantMessageIdRef.current) finishAssistant(true);
      setAiState(runningRef.current ? "listening" : "idle");
    },
    [clearPendingSpeech, client, finishAssistant, stopModelAudio, stopSpeech],
  );

  const replayAssistantAudio = useCallback(
    (message: ChatMessage) => {
      const chunks = assistantAudioClipsRef.current[message.id] ?? [];
      if (chunks.length === 0) return false;
      stopSpeech();
      stopModelAudio();
      const player = ensureAudioPlayer();
      chunks.forEach((chunk) => {
        void player.play(chunk.audio, chunk.sampleRate);
      });
      return true;
    },
    [ensureAudioPlayer, stopModelAudio, stopSpeech],
  );

  const computeFrameStats = useCallback(() => {
    const video = videoRef.current;
    const sample = sampleRef.current;
    if (!video || !sample) return { diff: 100, sharpness: 1000 };
    const context = sample.getContext("2d", { willReadFrequently: true });
    if (!context) return { diff: 100, sharpness: 1000 };
    sample.width = 64;
    sample.height = 36;
    context.drawImage(video, 0, 0, sample.width, sample.height);
    const data = context.getImageData(0, 0, sample.width, sample.height).data;
    const previous = lastSampleRef.current;
    lastSampleRef.current = new Uint8ClampedArray(data);
    let diff = 0;
    if (previous) {
      for (let i = 0; i < data.length; i += 16) diff += Math.abs(data[i] - previous[i]);
      diff /= data.length / 16;
    } else {
      diff = 100;
    }
    let laplacian = 0;
    let count = 0;
    for (let y = 1; y < sample.height - 1; y += 1) {
      for (let x = 1; x < sample.width - 1; x += 1) {
        const index = (y * sample.width + x) * 4;
        const center = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
        const leftIndex = (y * sample.width + x - 1) * 4;
        const rightIndex = (y * sample.width + x + 1) * 4;
        const upIndex = ((y - 1) * sample.width + x) * 4;
        const downIndex = ((y + 1) * sample.width + x) * 4;
        const left = data[leftIndex] * 0.299 + data[leftIndex + 1] * 0.587 + data[leftIndex + 2] * 0.114;
        const right = data[rightIndex] * 0.299 + data[rightIndex + 1] * 0.587 + data[rightIndex + 2] * 0.114;
        const up = data[upIndex] * 0.299 + data[upIndex + 1] * 0.587 + data[upIndex + 2] * 0.114;
        const down = data[downIndex] * 0.299 + data[downIndex + 1] * 0.587 + data[downIndex + 2] * 0.114;
        const value = 4 * center - left - right - up - down;
        laplacian += value * value;
        count += 1;
      }
    }
    return { diff, sharpness: count ? laplacian / count : 1000 };
  }, []);

  const captureFrame = useCallback(
    async (reason: string, force = false) => {
      if (cameraStatus !== "active") return false;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
      const now = Date.now();
      const { diff, sharpness } = computeFrameStats();
      if (sharpness < BLUR_THRESHOLD && reason !== "manual") return false;
      const shouldSend = force || reason === "semantic" || now - lastVisionAtRef.current > 12000 || diff > 18;
      if (!shouldSend) return false;

      const context = canvas.getContext("2d");
      if (!context) return false;
      const widths = [640, 520, 420];
      const qualities = reason === "semantic" ? [0.72, 0.62, 0.52, 0.42] : [0.58, 0.48, 0.4];
      let image = "";
      for (const width of widths) {
        const height = Math.round((video.videoHeight / Math.max(video.videoWidth, 1)) * width) || Math.round(width * 0.5625);
        canvas.width = width;
        canvas.height = height;
        context.drawImage(video, 0, 0, width, height);
        for (const quality of qualities) {
          image = canvas.toDataURL("image/jpeg", quality);
          if (imagePayloadSize(image) <= MAX_REALTIME_IMAGE_BASE64_BYTES) break;
        }
        if (imagePayloadSize(image) <= MAX_REALTIME_IMAGE_BASE64_BYTES) break;
      }
      const sent = client.send("vision.frame", { image, reason, diff: Number(diff.toFixed(2)) });
      if (sent) lastVisionAtRef.current = now;
      return sent;
    },
    [cameraStatus, client, computeFrameStats],
  );

  const captureFrameForRequest = useCallback(
    async (requestId: string, reason: string, quality: "high" | "normal") => {
      if (cameraStatus !== "active") {
        client.send("vision.capture.failed", { requestId, reason: "camera_unavailable" });
        appendMessage({ id: uid(), role: "system", text: "摄像头未开启，暂时无法识别药品说明书。请先打开摄像头后再试。" });
        return false;
      }
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) {
        client.send("vision.capture.failed", { requestId, reason: "camera_unavailable" });
        appendMessage({ id: uid(), role: "system", text: "没有拿到摄像头画面，正在等待下一次截图。" });
        return false;
      }

      const startedAt = Date.now();
      while (
        (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) &&
        Date.now() - startedAt < CAPTURE_VIDEO_READY_TIMEOUT_MS
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
        client.send("vision.capture.failed", { requestId, reason: "video_not_ready" });
        appendMessage({ id: uid(), role: "system", text: "摄像头画面还没准备好，我会再尝试截图。" });
        return false;
      }

      const context = canvas.getContext("2d");
      if (!context) {
        client.send("vision.capture.failed", { requestId, reason: "canvas_unavailable" });
        appendMessage({ id: uid(), role: "system", text: "截图组件暂时不可用，我会再尝试。" });
        return false;
      }
      const widths = quality === "high" ? [960, 840, 720] : [720, 640, 520];
      const qualities = quality === "high" ? [0.86, 0.78, 0.68] : [0.72, 0.62, 0.52];
      let image = "";
      for (const width of widths) {
        const height = Math.round((video.videoHeight / Math.max(video.videoWidth, 1)) * width) || Math.round(width * 0.5625);
        canvas.width = width;
        canvas.height = height;
        context.drawImage(video, 0, 0, width, height);
        for (const imageQuality of qualities) {
          image = canvas.toDataURL("image/jpeg", imageQuality);
          if (imagePayloadSize(image) <= MAX_OCR_IMAGE_BASE64_BYTES) break;
        }
        if (imagePayloadSize(image) <= MAX_OCR_IMAGE_BASE64_BYTES) break;
      }
      const sent = client.send("vision.frame", {
        image,
        requestId,
        reason,
        realtimeEligible: false,
      });
      if (!sent) {
        appendMessage({ id: uid(), role: "system", text: "截图已生成，但连接暂时不可用，请重新开启实时对话后再试。" });
      }
      return sent;
    },
    [appendMessage, cameraStatus, client],
  );

  const sendRealtimeVisualPrompt = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean) return false;
      if (mediaState !== "running" || !realtimeAudioRef.current) {
        appendMessage({ id: uid(), role: "system", text: "请先开启实时对话；视觉快捷提问需要使用实时模型返回音频流。" });
        setLastError("视觉快捷提问需要先开启实时对话，并使用支持音频流的实时模型。");
        return false;
      }
      if (cameraStatus !== "active") {
        appendMessage({ id: uid(), role: "system", text: "请先开启摄像头，视觉快捷提问需要携带当前画面。" });
        setLastError("视觉快捷提问需要先开启摄像头。");
        return false;
      }
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        appendMessage({ id: uid(), role: "system", text: "当前摄像头画面还没有准备好，请稍后再试。" });
        return false;
      }
      const context = canvas.getContext("2d");
      if (!context) return false;

      const widths = [720, 640, 520, 420];
      const qualities = [0.72, 0.62, 0.52, 0.42];
      let image = "";
      for (const width of widths) {
        const height = Math.round((video.videoHeight / Math.max(video.videoWidth, 1)) * width) || Math.round(width * 0.5625);
        canvas.width = width;
        canvas.height = height;
        context.drawImage(video, 0, 0, width, height);
        for (const imageQuality of qualities) {
          image = canvas.toDataURL("image/jpeg", imageQuality);
          if (imagePayloadSize(image) <= MAX_REALTIME_IMAGE_BASE64_BYTES) break;
        }
        if (imagePayloadSize(image) <= MAX_REALTIME_IMAGE_BASE64_BYTES) break;
      }

      clearPendingSpeech();
      stopModelAudio();
      if (assistantMessageIdRef.current) finishAssistant(true);
      setAiState("processing");
      const sent = client.send("realtime.visual.prompt", {
        text: clean,
        image,
        reason: "visual-quick-prompt",
      });
      if (!sent) {
        appendMessage({ id: uid(), role: "system", text: "实时连接还没准备好，请稍后再试。" });
        return false;
      }
      return true;
    },
    [appendMessage, cameraStatus, clearPendingSpeech, client, finishAssistant, mediaState, stopModelAudio],
  );

  const captureSpeechFrame = useCallback(
    (reason: "speech-start" | "speech-active") => {
      window.clearTimeout(pendingSpeechFrameTimerRef.current);
      const send = () => {
        if (!runningRef.current || !audioReadyForVisionRef.current) return;
        void captureFrame(reason, true);
      };
      if (audioReadyForVisionRef.current) {
        send();
        return;
      }
      pendingSpeechFrameTimerRef.current = window.setTimeout(send, 160);
    },
    [captureFrame],
  );

  const sendFinalTranscript = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      if (assistantMessageIdRef.current || ttsPlayingRef.current || ttsQueueRef.current.length > 0) {
        client.send("speech.cancel", { reason: "new_user_turn" });
        stopSpeech();
        finishAssistant(true);
      }
      if (containsVisualIntent(clean) && !containsMedicationInstructionIntent(clean)) {
        await sendRealtimeVisualPrompt(clean);
        return;
      }
      client.send("browser.asr.final", { text: clean });
    },
    [client, finishAssistant, sendRealtimeVisualPrompt, stopSpeech],
  );

  const submitRecognizedSpeech = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean || !runningRef.current || recognitionDisabledRef.current || isAsrSuppressedForTts()) return;

      const now = Date.now();
      const lastSubmitted = lastSubmittedSpeechRef.current;
      if (
        lastSubmitted &&
        lastSubmitted.text === clean &&
        now - lastSubmitted.at < DUPLICATE_SPEECH_WINDOW_MS
      ) {
        clearPendingSpeech();
        return;
      }

      lastSubmittedSpeechRef.current = { text: clean, at: now };
      clearPendingSpeech();
      void sendFinalTranscript(clean);
    },
    [clearPendingSpeech, isAsrSuppressedForTts, sendFinalTranscript],
  );

  const scheduleRecognizedSpeech = useCallback(
    (text: string, delayMs = SPEECH_AUTO_SEND_DELAY_MS) => {
      const clean = text.trim();
      if (!clean || recognitionDisabledRef.current || isAsrSuppressedForTts()) return;

      pendingSpeechRef.current = clean;
      window.clearTimeout(pendingSpeechTimerRef.current);
      pendingSpeechTimerRef.current = window.setTimeout(() => {
        const pending = pendingSpeechRef.current.trim();
        if (!pending || !runningRef.current || recognitionDisabledRef.current || isAsrSuppressedForTts()) return;
        submitRecognizedSpeech(pending);
      }, delayMs);
    },
    [isAsrSuppressedForTts, submitRecognizedSpeech],
  );

  const handleGatewayEvent = useCallback(
    (event: GatewayEvent) => {
      if (event.type === "session.ready") {
        setConnectionState("open");
        setSessionReady(true);
        const enabled = event.capabilities.realtime === true;
        realtimeAudioRef.current = enabled;
        setRealtimeAudio(enabled);
        if (enabled) setAsrStatus("Qwen Realtime ASR + 浏览器兜底");
      }
      if (event.type === "scene.switched") {
        clearEmptyAssistantPlaceholder();
        appendMessage({ id: uid(), role: "system", text: event.message });
        setAiState("processing");
      }
      if (event.type === "agent.guidance") {
        clearEmptyAssistantPlaceholder();
        appendMessage({ id: uid(), role: "system", text: event.text });
      }
      if (event.type === "vision.capture.request") {
        clearEmptyAssistantPlaceholder();
        const delayMs = event.reason === "medication-agent" ? MEDICATION_CAPTURE_DELAY_MS : 0;
        if (event.reason === "medication-agent") {
          appendMessage({ id: uid(), role: "system", text: `准备截图，请保持说明书在画面中央，约 ${(delayMs / 1000).toFixed(1)} 秒后拍摄。` });
        }
        window.clearTimeout(medicationCaptureTimerRef.current);
        medicationCaptureTimerRef.current = window.setTimeout(() => {
          void captureFrameForRequest(event.requestId, event.reason, event.quality);
        }, delayMs);
      }
      if (event.type === "ocr.started") {
        appendMessage({ id: uid(), role: "system", text: "已完成截图，正在识别说明书文字..." });
      }
      if (event.type === "ocr.result") {
        const confidence = event.confidence == null ? "" : `，置信度 ${(event.confidence * 100).toFixed(0)}%`;
        const text = event.accepted
          ? `已读取到 OCR 结果${confidence}，正在交给模型结合画面判断。`
          : `OCR 结果不完整${confidence}，正在交给模型结合画面判断。`;
        appendMessage({ id: uid(), role: "system", text });
      }
      if (event.type === "ocr.retake.requested") {
        const attempt = event.attempt && event.maxAttempts ? `第 ${event.attempt}/${event.maxAttempts} 次尝试` : "准备重拍";
        appendMessage({ id: uid(), role: "system", text: `${attempt}：${event.reason}` });
      }
      if (event.type === "agent.exited" && event.agent === "medication_instruction" && event.reason !== "topic_changed") {
        appendMessage({ id: uid(), role: "system", text: "药品说明书识别流程已结束。" });
      }
      if (event.type === "asr.partial") {
        if (event.source === "realtime") {
          lastRealtimeAsrAtRef.current = Date.now();
          clearPendingSpeech();
        }
        setPartial(event.text);
        setAiState("listening");
      }
      if (event.type === "asr.final") {
        if (event.source === "realtime") {
          lastRealtimeAsrAtRef.current = Date.now();
          clearPendingSpeech();
        }
        setPartial("");
        appendMessage({ id: uid(), role: "user", text: event.text });
        setSessions((current) =>
          current.map((session) => {
            if (session.id !== currentSessionId) return session;
            const shouldRename = session.title === "新会话" || session.title === "当前会话" || session.title.startsWith("会话 ");
            return {
              ...session,
              title: shouldRename ? event.text.slice(0, 28) : session.title,
              updatedAt: timeLabel(),
              messageCount: session.messageCount + 1,
            };
          }),
        );
        beginAssistantResponse();
      }
      if (event.type === "llm.delta") {
        setAiState((current) => (current === "speaking" ? current : "processing"));
        updateAssistantDelta(event.delta);
      }
      if (event.type === "response.text.delta") {
        setAiState((current) => (current === "speaking" ? current : "processing"));
        updateAssistantDelta(event.delta);
      }
      if (event.type === "response.audio.delta") {
        if (!assistantMessageIdRef.current) beginAssistantResponse();
        const messageId = assistantMessageIdRef.current;
        if (messageId) {
          const clips = assistantAudioClipsRef.current[messageId] ?? [];
          clips.push({ audio: event.audio, sampleRate: event.sampleRate });
          assistantAudioClipsRef.current[messageId] = clips.slice(-800);
        }
        void ensureAudioPlayer().play(event.audio, event.sampleRate);
      }
      if (event.type === "response.audio.done") {
        void refreshConversationMeta();
        if (!modelAudioPlayingRef.current && !assistantMessageIdRef.current) setAiState(runningRef.current ? "listening" : "idle");
      }
      if (event.type === "tts.audio.chunk") {
        if (!assistantMessageIdRef.current) beginAssistantResponse();
        if (event.text?.trim() && (assistantTextFromTtsRef.current || !assistantTextRef.current.trim())) {
          updateAssistantDelta(event.text, "tts");
        }
      }
      if (event.type === "llm.done") {
        finishAssistant(event.cancelled);
        if (!event.cancelled) void refreshConversationMeta();
      }
      if (event.type === "speech.cancelled") {
        stopModelAudio();
        stopSpeech();
        finishAssistant(true);
      }
      if (event.type === "voice.updated") setSelectedVoice(event.voice as RealtimeVoice);
      if (event.type === "session.cost") setCost(event.cost);
      if (event.type === "error" && !isNonBlockingRealtimeError(event.code, event.message)) {
        setLastError(`${event.code}: ${event.message}`);
      }
    },
    [
      appendMessage,
      beginAssistantResponse,
      captureFrameForRequest,
      clearPendingSpeech,
      clearEmptyAssistantPlaceholder,
      currentSessionId,
      ensureAudioPlayer,
      finishAssistant,
      refreshConversationMeta,
      stopModelAudio,
      stopSpeech,
      updateAssistantDelta,
    ],
  );

  useEffect(() => client.on(handleGatewayEvent), [client, handleGatewayEvent]);
  useEffect(
    () =>
      client.onStatus((state) => {
        setConnectionState(state);
        if (state !== "open") setSessionReady(false);
      }),
    [client],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (runningRef.current && client.state === "closed") {
        setSessionReady(false);
        client.connect();
        client.send("session.start");
      }
      setConnectionState(client.state);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [captureFrame, client]);

  const checkMediaPermissions = useCallback(async () => {
    if (!navigator.permissions?.query) {
      setPermissionStatus("浏览器不支持权限预检，将在启动时请求授权");
      return;
    }
    try {
      const [camera, microphone] = await Promise.all([
        navigator.permissions.query({ name: "camera" as PermissionName }),
        navigator.permissions.query({ name: "microphone" as PermissionName }),
      ]);
      const label = `摄像头：${camera.state}；麦克风：${microphone.state}`;
      setPermissionStatus(label);
    } catch {
      setPermissionStatus("权限预检不可用，将在启动时请求授权");
    }
  }, []);

  useEffect(() => {
    void checkMediaPermissions();
  }, [checkMediaPermissions]);

  const startSpeechRecognition = useCallback(() => {
    if (recognitionRef.current || recognitionDisabledRef.current || isAsrSuppressedForTts()) return;
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      const message = "当前浏览器不支持 Web Speech API，可使用文本输入兜底。";
      setAsrStatus("文本兜底");
      setLastError(message);
      appendMessage({ id: uid(), role: "system", text: message });
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    setAsrStatus(realtimeAudioRef.current ? "浏览器 ASR 兜底运行中" : "浏览器 ASR 运行中");
    recognition.onresult = (event: any) => {
      if (!runningRef.current || recognitionDisabledRef.current || isAsrSuppressedForTts()) return;
      if (modelAudioPlayingRef.current || aiStateRef.current === "speaking") return;
      const realtimeRecognizedRecently = realtimeAudioRef.current && Date.now() - lastRealtimeAsrAtRef.current < 2500;
      if (realtimeRecognizedRecently) return;
      let interim = "";
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += transcript;
        else interim += transcript;
      }
      const cleanInterim = interim.trim();
      if (cleanInterim) {
        client.send("browser.asr.partial", { text: cleanInterim });
        scheduleRecognizedSpeech(cleanInterim);
      }
      if (finalText.trim()) scheduleRecognizedSpeech(finalText.trim(), SPEECH_FINAL_SETTLE_DELAY_MS);
    };
    recognition.onerror = (event: any) => {
      const error = event.error ?? "unknown";
      if (error === "network") {
        recognitionDisabledRef.current = true;
        if (realtimeAudioRef.current) {
          setAsrStatus("Qwen Realtime ASR");
          try {
            recognition.stop();
          } catch {
            // Ignore duplicate stop.
          }
          return;
        }
        setAsrStatus("ASR 网络不可用，已切换文本兜底");
        const message = "浏览器语音识别报 network。会话仍可继续，请用文本输入；麦克风音频流和成本统计仍在运行。";
        setLastError(message);
        appendMessage({ id: uid(), role: "system", text: message });
        try {
          recognition.stop();
        } catch {
          // Ignore duplicate stop.
        }
        return;
      }
      if (error !== "no-speech") setLastError(`语音识别错误：${error}`);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      if (runningRef.current && !recognitionDisabledRef.current && !isAsrSuppressedForTts()) {
        window.clearTimeout(recognitionRestartTimerRef.current);
        recognitionRestartTimerRef.current = window.setTimeout(() => startSpeechRecognition(), 650);
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
    }
  }, [appendMessage, client, isAsrSuppressedForTts, scheduleRecognizedSpeech, submitRecognizedSpeech]);

  useEffect(() => {
    recognitionStarterRef.current = startSpeechRecognition;
  }, [startSpeechRecognition]);

  useEffect(
    () => () => {
      pendingSpeechRef.current = "";
      window.clearTimeout(pendingSpeechTimerRef.current);
      window.clearTimeout(pendingSpeechFrameTimerRef.current);
      window.clearTimeout(recognitionRestartTimerRef.current);
      window.clearTimeout(ttsReleaseTimerRef.current);
      window.clearTimeout(medicationCaptureTimerRef.current);
    },
    [],
  );
  
  const handleVad = useCallback(
    (snapshot: VadSnapshot) => {
      if (!runningRef.current) return;
      if (isAsrSuppressedForTts()) return;

      if (snapshot.speechStart) {
        const assistantIsSpeaking =
          modelAudioPlayingRef.current ||
          aiStateRef.current === "speaking" ||
          ttsPlayingRef.current ||
          ttsQueueRef.current.length > 0;

        if (assistantIsSpeaking) interruptActiveSpeech("barge_in");

        speechFrameCountRef.current = 1;
        lastSpeechFrameAtRef.current = Date.now();
        captureSpeechFrame("speech-start");
      }

      if (snapshot.isSpeech && speechFrameCountRef.current > 0 && speechFrameCountRef.current < 2) {
        const now = Date.now();
        if (now - lastSpeechFrameAtRef.current > 1200) {
          speechFrameCountRef.current += 1;
          lastSpeechFrameAtRef.current = now;
          captureSpeechFrame("speech-active");
        }
      }

      if (snapshot.speechEnd) {
        speechFrameCountRef.current = 0;
        lastSpeechFrameAtRef.current = 0;
      }
    },
    [captureSpeechFrame, interruptActiveSpeech, isAsrSuppressedForTts],
  );

  const stopCamera = useCallback(() => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraStatus("idle");
  }, []);

  const requestCamera = useCallback(async () => {
    if (cameraStatus === "active" || cameraStatus === "requesting") return;
    setLastError("");
    setCameraStatus("requesting");
    setPermissionStatus("正在请求摄像头权限...");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      });
      cameraStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraStatus("active");
      setPermissionStatus("摄像头已授权");
    } catch (error) {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setCameraStatus(mediaStatusFromError(error));
      const message = mediaErrorMessage("摄像头", error);
      setPermissionStatus("摄像头启动失败");
      setLastError(message);
    }
  }, [cameraStatus]);

  useEffect(() => {
    if (activeView !== "chat" || cameraStatus !== "active") return;
    const video = videoRef.current;
    const stream = cameraStreamRef.current;
    if (!video || !stream) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    if (video.paused || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      void video.play().catch(() => undefined);
    }
  }, [activeView, cameraStatus]);

  const toggleCamera = useCallback(async () => {
    if (cameraStatus === "requesting") return;
    if (cameraStatus === "active") {
      stopCamera();
      setPermissionStatus("摄像头已关闭");
      return;
    }
    await requestCamera();
  }, [cameraStatus, requestCamera, stopCamera]);
  
  const startSession = useCallback(async () => {
    if (mediaAction || mediaState === "running") return;
    setMediaAction("start");
    let microphoneStream: MediaStream | null = null;
    let permissionStage: "microphone" | "session" = "microphone";
    try {
      if (!conversationsLoaded || !currentSessionId) {
        setLastError("会话历史正在加载，请稍后再启动。");
        return;
      }
      setLastError("");
      setPermissionStatus("正在请求麦克风权限...");
      setMicrophoneStatus("requesting");
      setAsrStatus("准备启动");
      setSessionReady(false);
      setMediaReady(false);
      recognitionDisabledRef.current = false;
      recognitionPausedForTtsRef.current = false;
      ttsAsrSuppressedUntilRef.current = 0;
      window.clearTimeout(ttsReleaseTimerRef.current);
      lastRealtimeAsrAtRef.current = 0;
      audioReadyForVisionRef.current = false;
      speechFrameCountRef.current = 0;
      lastSpeechFrameAtRef.current = 0;
      window.clearTimeout(pendingSpeechFrameTimerRef.current);
      window.clearTimeout(medicationCaptureTimerRef.current);
      clearPendingSpeech();
      client.close();

      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      microphoneStreamRef.current = microphoneStream;
      setMicrophoneStatus("active");
      setPermissionStatus("麦克风已授权");
      setMediaReady(true);

      permissionStage = "session";
      setConnectionState("connecting");
      client.connect();
      await client.waitOpen();
      client.send("session.start");
      client.send("session.voice.update", { voice: selectedVoice });

      const audioCapture = new AudioCapture(
        client,
        setLevel,
        handleVad,
        () => {
          audioReadyForVisionRef.current = true;
        },
        () => !isAsrSuppressedForTts(),
      );
      await audioCapture.start(microphoneStream);
      audioCaptureRef.current = audioCapture;
      runningRef.current = true;
      setAiState("listening");
      setMediaState("running");
      startSpeechRecognition();
    } catch (error) {
      const message = permissionStage === "microphone" ? mediaErrorMessage("麦克风", error) : error instanceof Error ? error.message : String(error);
      microphoneStream?.getTracks().forEach((track) => track.stop());
      microphoneStreamRef.current = null;
      client.close();
      setSessionReady(false);
      setMediaReady(false);
      setPermissionStatus("启动失败");
      setMicrophoneStatus(permissionStage === "microphone" ? mediaStatusFromError(error) : "error");
      setLastError(message);
      setMediaState("error");
      setConnectionState(client.state);
    } finally {
      setMediaAction(null);
    }
  }, [clearPendingSpeech, client, conversationsLoaded, currentSessionId, handleVad, isAsrSuppressedForTts, mediaAction, mediaState, selectedVoice, startSpeechRecognition]);
  const stopSession = useCallback(async () => {
    if (mediaAction === "stop") return;
    setMediaAction("stop");
    try {
      runningRef.current = false;
      audioReadyForVisionRef.current = false;
      speechFrameCountRef.current = 0;
      lastSpeechFrameAtRef.current = 0;
      window.clearTimeout(pendingSpeechFrameTimerRef.current);
      window.clearTimeout(medicationCaptureTimerRef.current);
      clearPendingSpeech();
      stopModelAudio();
      ttsQueueRef.current = [];
      ttsPlayingRef.current = false;
      ttsAsrSuppressedUntilRef.current = 0;
      window.clearTimeout(ttsReleaseTimerRef.current);
      window.clearTimeout(recognitionRestartTimerRef.current);
      recognitionDisabledRef.current = false;
      recognitionPausedForTtsRef.current = false;
      try {
        recognitionRef.current?.stop?.();
      } catch {
        // Some browsers throw if recognition is already stopped.
      }
      recognitionRef.current = null;
      await audioCaptureRef.current?.stop();
      microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
      microphoneStreamRef.current = null;
      audioCaptureRef.current = null;
      client.close();
      if (assistantMessageIdRef.current) finishAssistant(true);
      setSessionReady(false);
      setMediaReady(false);
      setMediaState("stopped");
      setMicrophoneStatus("idle");
      setConnectionState("closed");
      setAsrStatus("已停止");
      setAiState("idle");
    } finally {
      setMediaAction(null);
    }
  }, [clearPendingSpeech, client, finishAssistant, mediaAction, stopModelAudio]);

  const sendManual = useCallback(async () => {
    const text = manualText.trim();
    if (!text) return;
    setManualText("");
    clearPendingSpeech();
    if (containsVisualIntent(text) && !containsMedicationInstructionIntent(text)) {
      await sendRealtimeVisualPrompt(text);
      return;
    }
    await sendFinalTranscript(text);
  }, [clearPendingSpeech, manualText, sendFinalTranscript, sendRealtimeVisualPrompt]);

  const cancel = useCallback(() => {
    client.send("speech.cancel", { reason: "manual" });
    clearPendingSpeech();
    stopModelAudio();
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    ttsAsrSuppressedUntilRef.current = 0;
    window.clearTimeout(ttsReleaseTimerRef.current);
    finishAssistant(true);
    setAiState(runningRef.current ? "listening" : "idle");
  }, [clearPendingSpeech, client, finishAssistant, stopModelAudio]);

  const handleComposerAction = useCallback(() => {
    if (isProcessing) {
      cancel();
      return;
    }
    if (canSend) void sendManual();
  }, [cancel, canSend, isProcessing, sendManual]);

  const toggleVoiceSession = useCallback(async () => {
    if (mediaState === "running") await stopSession();
    else await startSession();
  }, [mediaState, startSession, stopSession]);

  const startNewConversation = useCallback(async () => {
    if (!authSession?.accessToken) return;
    setHistoryBusySessionId(NEW_SESSION_BUSY_ID);
    setHistoryError("");
    try {
      if (runningRef.current) await stopSession();
      if (assistantMessageIdRef.current || ttsPlayingRef.current || ttsQueueRef.current.length > 0) cancel();
      const conversation = await createConversation(apiBaseUrl, authSession.accessToken, "新会话");
      setSessionMessages((store) => ({ ...store, [conversation.id]: createStarterMessages() }));
      setSessions((current) => [conversationToSession(conversation), ...current]);
      setCurrentSessionId(conversation.id);
      setPartial("");
      setManualText("");
      setCost(emptyCost);
      setActiveView("chat");
    } catch (error) {
      const message = error instanceof Error ? error.message : "创建会话失败";
      setHistoryError(message);
      setLastError(message);
    } finally {
      setHistoryBusySessionId(null);
    }
  }, [apiBaseUrl, authSession?.accessToken, cancel, stopSession]);

  const selectConversation = useCallback(
    async (id: string) => {
      if (id === currentSessionId) {
        setActiveView("chat");
        return;
      }
      setHistoryBusySessionId(id);
      setHistoryError("");
      try {
        if (runningRef.current) await stopSession();
        if (assistantMessageIdRef.current || ttsPlayingRef.current || ttsQueueRef.current.length > 0) cancel();
        if (!sessionMessages[id]) await loadConversation(id);
        await refreshConversationMeta(id, undefined, true);
        setCurrentSessionId(id);
        setPartial("");
        setManualText("");
        setActiveView("chat");
      } catch (error) {
        const message = error instanceof Error ? error.message : "切换会话失败";
        setHistoryError(message);
        setLastError(message);
      } finally {
        setHistoryBusySessionId(null);
      }
    },
    [cancel, currentSessionId, loadConversation, refreshConversationMeta, sessionMessages, stopSession],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      const clean = title.trim();
      if (!authSession?.accessToken || !clean) return;
      setHistoryBusySessionId(id);
      setHistoryError("");
      try {
        const conversation = await renameConversation(apiBaseUrl, authSession.accessToken, id, clean);
        setSessions((current) =>
          current.map((session) =>
            session.id === id
              ? { ...session, title: conversation.title, updatedAt: timeLabel(conversation.updatedAt) }
              : session,
          ),
        );
      } catch (error) {
        setHistoryError(error instanceof Error ? error.message : "重命名会话失败");
        throw error;
      } finally {
        setHistoryBusySessionId(null);
      }
    },
    [apiBaseUrl, authSession?.accessToken],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      if (!authSession?.accessToken) return;
      const deletingCurrent = id === currentSessionId;
      const remaining = sessions.filter((session) => session.id !== id);
      setHistoryBusySessionId(id);
      setHistoryError("");
      try {
        if (deletingCurrent && runningRef.current) await stopSession();
        if (deletingCurrent && (assistantMessageIdRef.current || ttsPlayingRef.current || ttsQueueRef.current.length > 0)) cancel();
        await deleteConversation(apiBaseUrl, authSession.accessToken, id);
        setSessions((current) => current.filter((session) => session.id !== id));
        setSessionMessages((store) => {
          const next = { ...store };
          delete next[id];
          return next;
        });

        if (!deletingCurrent) return;
        const nextSession = remaining[0];
        setPartial("");
        setManualText("");
        setCost(emptyCost);
        if (nextSession) {
          if (!sessionMessages[nextSession.id]) await loadConversation(nextSession.id);
          setCurrentSessionId(nextSession.id);
          setActiveView("chat");
          return;
        }

        const conversation = await createConversation(apiBaseUrl, authSession.accessToken, "新会话");
        setSessions([conversationToSession(conversation)]);
        setSessionMessages((store) => ({ ...store, [conversation.id]: createStarterMessages() }));
        setCurrentSessionId(conversation.id);
        setActiveView("chat");
      } catch (error) {
        setHistoryError(error instanceof Error ? error.message : "删除会话失败");
        throw error;
      } finally {
        setHistoryBusySessionId(null);
      }
    },
    [
      apiBaseUrl,
      authSession?.accessToken,
      cancel,
      createConversation,
      currentSessionId,
      loadConversation,
      sessionMessages,
      sessions,
      stopSession,
    ],
  );

  const handleAuthenticated = useCallback((session: AuthSession) => {
    setAuthSession(session);
    storeAuth(session);
    setAuthError("");
  }, []);

  const logout = useCallback(async () => {
    await stopSession();
    stopCamera();
    setAuthSession(null);
    storeAuth(null);
    setAuthError("");
  }, [stopCamera, stopSession]);

  const updateVoice = useCallback(
    (voice: RealtimeVoice) => {
      setSelectedVoice(voice);
      localStorage.setItem(VOICE_STORAGE_KEY, voice);
      if (client.state === "open") client.send("session.voice.update", { voice });
    },
    [client],
  );

  if (!authSession) {
    return <AuthView apiBaseUrl={apiBaseUrl} error={authError} onAuthenticated={handleAuthenticated} />;
  }

  return (
    <main className="h-screen overflow-hidden bg-white text-slate-950">
      <div
        className={cx(
          "grid h-screen min-h-0 max-lg:grid-cols-1",
          historyCollapsed
            ? "grid-cols-[64px_1fr]"
            : "grid-cols-[280px_1fr] max-xl:grid-cols-[244px_1fr]",
        )}
      >
        <HistoryRail
          busySessionId={historyBusySessionId}
          collapsed={historyCollapsed}
          currentSessionId={currentSessionId}
          error={historyError}
          onDeleteSession={deleteSession}
          onNewSession={startNewConversation}
          onLogout={logout}
          onOpenApiKeys={() => setActiveView("apiKeys")}
          onOpenSettings={() => setActiveView("settings")}
          onOpenUsage={() => setActiveView("usage")}
          onRenameSession={renameSession}
          onSelectSession={selectConversation}
          onToggle={() => setHistoryCollapsed((current) => !current)}
          sessions={historySessions}
          user={authSession.user}
        />

        <section className="flex min-h-0 min-w-0 flex-col bg-white">
          <div
            className={cx(
              "flex min-h-0 flex-1 flex-col px-6 py-4 max-lg:px-4",
              activeView === "chat" ? "overflow-hidden" : "overflow-y-auto overflow-x-hidden",
            )}
          >
            {lastError && (
              <div className="mb-4 flex items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-800">
                <WifiOff size={17} /> {lastError}
              </div>
            )}

            {activeView === "chat" && (
              <ChatView
                aiState={aiState}
                canSend={canSend}
                cameraStatus={cameraStatus}
                handleComposerAction={handleComposerAction}
                isProcessing={isProcessing}
                level={level}
                manualText={manualText}
                mediaAction={mediaAction}
                mediaState={mediaState}
                microphoneStatus={microphoneStatus}
                messages={messages}
                partial={partial}
                replayAssistantAudio={replayAssistantAudio}
                setManualText={setManualText}
                sendRealtimeVisualPrompt={sendRealtimeVisualPrompt}
                sendManual={sendManual}
                toggleCamera={toggleCamera}
                toggleVoiceSession={toggleVoiceSession}
                videoRef={videoRef}
                canvasRef={canvasRef}
                sampleRef={sampleRef}
                videoPanePercent={videoPanePercent}
                setVideoPanePercent={setVideoPanePercent}
              />
            )}
            {activeView === "settings" && (
              <SettingsView
                selectedVoice={selectedVoice}
                setSelectedVoice={updateVoice}
                user={authSession.user}
              />
            )}
            {activeView === "apiKeys" && (
              <ApiKeyManagementView apiBaseUrl={apiBaseUrl} token={authSession.accessToken} />
            )}
            {activeView === "usage" && (
              <UsageStatsView apiBaseUrl={apiBaseUrl} cost={cost} token={authSession.accessToken} />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
