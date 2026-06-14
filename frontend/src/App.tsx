import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowUp,
  BarChart3,
  Camera,
  Check,
  Copy,
  Database,
  Eye,
  FileText,
  Gauge,
  History,
  KeyRound,
  LogOut,
  MessageSquare,
  Mic,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Radio,
  SlidersHorizontal,
  Square,
  Pencil,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
  Timer,
  Trash2,
  Volume2,
  WifiOff,
  X,
} from "lucide-react";
import { AudioCapture } from "./lib/audioCapture";
import { PcmStreamPlayer } from "./lib/pcmPlayer";
import {
  createConversation,
  deleteConversation,
  fetchConversation,
  fetchConversationMessages,
  fetchConversations,
  fetchCurrentUser,
  fetchModelConfig,
  fetchUsageStats,
  loadStoredAuth,
  loginUser,
  registerUser,
  renameConversation,
  storeAuth,
  updateModelConfig,
  type AuthSession,
  type ModelConfig,
  type ModelConfigUpdate,
  type PersistedConversation,
  type PersistedMessage,
  type UsageBucket,
  type UsageEvent,
  type UsageStats,
  type UsageTotals,
} from "./lib/api";
import { GatewayClient } from "./lib/wsClient";
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
    if (ttsPlayingRef.current) return;
    const next = ttsQueueRef.current.shift();
    if (!next || !("speechSynthesis" in window)) {
      const releaseInMs = ttsAsrSuppressedUntilRef.current - Date.now();
      if (releaseInMs > 0) {
        window.clearTimeout(ttsReleaseTimerRef.current);
        ttsReleaseTimerRef.current = window.setTimeout(() => processTtsQueue(), releaseInMs);
        return;
      }
      recognitionPausedForTtsRef.current = false;
      if (runningRef.current && !recognitionDisabledRef.current) {
        window.clearTimeout(recognitionRestartTimerRef.current);
        recognitionRestartTimerRef.current = window.setTimeout(() => recognitionStarterRef.current(), 250);
      }
      setAiState(runningRef.current ? "listening" : "idle");
      return;
    }
    recognitionPausedForTtsRef.current = true;
    suppressAsrForTts();
    window.clearTimeout(ttsReleaseTimerRef.current);
    clearPendingSpeech();
    try {
      recognitionRef.current?.stop?.();
    } catch {
      // Browser may throw if recognition is already stopped.
    }
    ttsPlayingRef.current = true;
    setAiState("speaking");
    const utterance = new SpeechSynthesisUtterance(next);
    utterance.lang = "zh-CN";
    utterance.rate = 0.98;
    utterance.pitch = 1;
    utterance.onend = () => {
      ttsPlayingRef.current = false;
      suppressAsrForTts();
      processTtsQueue();
    };
    utterance.onerror = () => {
      ttsPlayingRef.current = false;
      suppressAsrForTts();
      processTtsQueue();
    };
    window.speechSynthesis.speak(utterance);
  }, [clearPendingSpeech, suppressAsrForTts]);

  const enqueueSpeech = useCallback(
    (text: string) => {
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
    window.speechSynthesis?.cancel();
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
      if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        client.send("vision.capture.failed", { requestId, reason: "camera_unavailable" });
        return false;
      }

      const context = canvas.getContext("2d");
      if (!context) {
        client.send("vision.capture.failed", { requestId, reason: "canvas_unavailable" });
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
      return client.send("vision.frame", {
        image,
        requestId,
        reason,
        realtimeEligible: false,
      });
    },
    [appendMessage, cameraStatus, client],
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
      if (containsVisualIntent(clean) && !containsMedicationInstructionIntent(clean)) await captureFrame("semantic", true);
      client.send("browser.asr.final", { text: clean });
    },
    [captureFrame, client, finishAssistant, stopSpeech],
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
        appendMessage({ id: uid(), role: "assistant", text: event.text });
        if (event.speak) enqueueSpeech(event.text);
      }
      if (event.type === "vision.capture.request") {
        clearEmptyAssistantPlaceholder();
        void captureFrameForRequest(event.requestId, event.reason, event.quality);
      }
      if (event.type === "ocr.started") {
        appendMessage({ id: uid(), role: "system", text: "正在识别说明书文字..." });
      }
      if (event.type === "ocr.result") {
        const confidence = event.confidence == null ? "" : `，置信度 ${(event.confidence * 100).toFixed(0)}%`;
        const text = event.accepted
          ? `已读取到可用文字${confidence}，正在基于说明书整理回答。`
          : `这次画面里的说明书文字还不够清楚${confidence}，我会继续尝试。`;
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
        if (!realtimeAudioRef.current || assistantTextFromTtsRef.current) enqueueSpeech(event.text);
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
      enqueueSpeech,
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
      clearPendingSpeech();
      stopModelAudio();
      ttsQueueRef.current = [];
      ttsPlayingRef.current = false;
      ttsAsrSuppressedUntilRef.current = 0;
      window.clearTimeout(ttsReleaseTimerRef.current);
      window.speechSynthesis?.cancel();
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
    await sendFinalTranscript(text);
  }, [clearPendingSpeech, manualText, sendFinalTranscript]);

  const cancel = useCallback(() => {
    client.send("speech.cancel", { reason: "manual" });
    clearPendingSpeech();
    stopModelAudio();
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    ttsAsrSuppressedUntilRef.current = 0;
    window.clearTimeout(ttsReleaseTimerRef.current);
    window.speechSynthesis?.cancel();
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

function AuthView({
  apiBaseUrl,
  error,
  onAuthenticated,
}: {
  apiBaseUrl: string;
  error: string;
  onAuthenticated: (session: AuthSession) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState(error);
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setLocalError("");
    try {
      const action = mode === "login" ? loginUser : registerUser;
      const session = await action(apiBaseUrl, username, password);
      onAuthenticated(session);
    } catch (authError) {
      setLocalError(authError instanceof Error ? authError.message : "认证失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-slate-950 px-4 text-slate-950">
      <form className="w-full max-w-md rounded-[2rem] bg-white p-7 shadow-soft" onSubmit={submit}>
        <div className="mb-7">
          <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-cyan-400 text-lg font-black">AI</div>
          <h1 className="text-2xl font-black">AI 视觉对话助手</h1>
          <p className="mt-2 text-sm font-semibold text-slate-500">登录后开始实时视觉对话，会话将按账号隔离。</p>
        </div>
        <div className="mb-5 grid grid-cols-2 rounded-2xl bg-slate-100 p-1 text-sm font-black">
          <button
            className={cx("rounded-xl py-2", mode === "login" ? "bg-white shadow-sm" : "text-slate-500")}
            type="button"
            onClick={() => setMode("login")}
          >
            登录
          </button>
          <button
            className={cx("rounded-xl py-2", mode === "register" ? "bg-white shadow-sm" : "text-slate-500")}
            type="button"
            onClick={() => setMode("register")}
          >
            注册
          </button>
        </div>
        <label className="mb-4 grid gap-2 text-sm font-bold text-slate-600">
          用户名
          <input
            className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none focus:border-cyan-400"
            minLength={3}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label className="mb-5 grid gap-2 text-sm font-bold text-slate-600">
          密码
          <input
            className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none focus:border-cyan-400"
            minLength={6}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
          />
        </label>
        {localError && <div className="mb-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">{localError}</div>}
        <button className="h-12 w-full rounded-2xl bg-emerald-700 font-black text-white hover:bg-emerald-800 disabled:opacity-60" disabled={loading}>
          {loading ? "处理中..." : mode === "login" ? "登录" : "创建账号"}
        </button>
      </form>
    </main>
  );
}

function HistoryRail({
  busySessionId,
  collapsed,
  currentSessionId,
  error,
  onDeleteSession,
  onNewSession,
  onLogout,
  onOpenApiKeys,
  onOpenSettings,
  onOpenUsage,
  onRenameSession,
  onSelectSession,
  onToggle,
  sessions,
  user,
}: {
  busySessionId: string | null;
  collapsed: boolean;
  currentSessionId: string;
  error: string;
  onDeleteSession: (id: string) => Promise<void>;
  onNewSession: () => Promise<void>;
  onLogout: () => Promise<void>;
  onOpenApiKeys: () => void;
  onOpenSettings: () => void;
  onOpenUsage: () => void;
  onRenameSession: (id: string, title: string) => Promise<void>;
  onSelectSession: (id: string) => Promise<void>;
  onToggle: () => void;
  sessions: SessionListItem[];
  user: AuthSession["user"];
}) {
  const initials = user.username.slice(0, 1).toUpperCase();
  const [menuOpen, setMenuOpen] = useState(false);

  const toggleUserMenu = useCallback(() => {
    setMenuOpen((current) => !current);
  }, []);

  const openSettings = useCallback(() => {
    setMenuOpen(false);
    onOpenSettings();
  }, [onOpenSettings]);

  const openApiKeys = useCallback(() => {
    setMenuOpen(false);
    onOpenApiKeys();
  }, [onOpenApiKeys]);

  const openUsage = useCallback(() => {
    setMenuOpen(false);
    onOpenUsage();
  }, [onOpenUsage]);

  const logoutFromMenu = useCallback(() => {
    setMenuOpen(false);
    void onLogout();
  }, [onLogout]);

  const createSessionFromRail = useCallback(() => {
    setMenuOpen(false);
    return onNewSession();
  }, [onNewSession]);

  const selectSessionFromRail = useCallback(
    (id: string) => {
      setMenuOpen(false);
      return onSelectSession(id);
    },
    [onSelectSession],
  );

  const toggleRail = useCallback(() => {
    setMenuOpen(false);
    onToggle();
  }, [onToggle]);

  const userMenu = menuOpen ? (
    <div
      className={cx(
        "absolute z-20 rounded-2xl border border-slate-200 bg-white p-2 text-sm font-semibold text-slate-700 shadow-xl",
        collapsed ? "bottom-16 left-3 w-60" : "bottom-20 left-3 right-3",
      )}
    >
      <button className="flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-slate-100" onClick={openSettings} type="button">
        <SlidersHorizontal size={17} /> 系统设置
      </button>
      <button className="flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-slate-100" onClick={openApiKeys} type="button">
        <KeyRound size={17} /> API Key 管理
      </button>
      <button className="flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-slate-100" onClick={openUsage} type="button">
        <BarChart3 size={17} /> 模型消耗统计
      </button>
      <button className="mt-1 flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-rose-600 hover:bg-rose-50" onClick={logoutFromMenu} type="button">
        <LogOut size={17} /> 用户登出
      </button>
    </div>
  ) : null;

  if (collapsed) {
    return (
      <aside className="relative flex flex-col items-center gap-3 border-r border-slate-200 bg-slate-50 py-3 max-lg:hidden">
        <button
          className="grid h-10 w-10 place-items-center rounded-xl text-slate-700 hover:bg-slate-100"
          onClick={toggleRail}
          title="展开历史记录"
          type="button"
        >
          <PanelLeftOpen size={18} />
        </button>
        <button
          className="grid h-10 w-10 place-items-center rounded-xl text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={busySessionId === NEW_SESSION_BUSY_ID}
          onClick={createSessionFromRail}
          title="新会话"
          type="button"
        >
          <Plus size={18} />
        </button>
        {userMenu}
        <div className="mt-auto flex flex-col items-center gap-2">
          <button
            className="grid h-10 w-10 place-items-center rounded-xl text-slate-600 hover:bg-slate-100"
            onClick={toggleUserMenu}
            aria-label="打开用户菜单"
            title="用户菜单"
            type="button"
          >
            <MoreHorizontal size={18} />
          </button>
          <button
            className="grid h-10 w-10 place-items-center rounded-full bg-slate-900 text-sm font-bold text-white"
            onClick={openSettings}
            title="系统设置"
            type="button"
          >
            {initials}
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="relative flex min-h-0 flex-col border-r border-slate-200 bg-slate-50 p-3 max-lg:hidden">
      <div className="mb-4 flex gap-2">
        <button
          className="flex h-11 flex-1 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-slate-900 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={busySessionId === NEW_SESSION_BUSY_ID}
          onClick={createSessionFromRail}
          type="button"
        >
          <Plus size={17} /> {busySessionId === NEW_SESSION_BUSY_ID ? "创建中..." : "新会话"}
        </button>
        <button className="grid h-11 w-11 place-items-center rounded-xl text-slate-600 hover:bg-slate-100" onClick={toggleRail} title="收起历史记录" type="button">
          <PanelLeftClose size={18} />
        </button>
      </div>
      <div className="mb-3 flex items-center gap-2 px-2 text-xs font-bold text-slate-500">
        <History size={15} /> 最近
      </div>
      {error && <p className="mb-3 rounded-2xl bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</p>}
      <div className="min-h-0 flex-1 space-y-1 overflow-auto">
        {sessions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">暂无会话历史</p>
        ) : (
          sessions.map((session) => (
            <HistorySessionItem
              key={session.id}
              active={session.id === currentSessionId}
              busy={busySessionId === session.id}
              onDeleteSession={onDeleteSession}
              onRenameSession={onRenameSession}
              onSelectSession={selectSessionFromRail}
              session={session}
            />
          ))
        )}
      </div>
      {userMenu}
      <div className="mt-3 flex h-12 items-center gap-2 rounded-xl px-2 hover:bg-slate-100">
        <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={openSettings} type="button">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-900 text-sm font-bold text-white">
            {initials}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-slate-900">{user.username}</span>
            <span className="block text-xs text-slate-500">用户管理与设置</span>
          </span>
        </button>
        <button
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-slate-500 hover:bg-white hover:text-slate-900"
          onClick={toggleUserMenu}
          aria-label="打开用户菜单"
          title="更多用户选项"
          type="button"
        >
          <MoreHorizontal size={18} />
        </button>
      </div>
    </aside>
  );
}

function HistorySessionItem({
  active,
  busy,
  onDeleteSession,
  onRenameSession,
  onSelectSession,
  session,
}: {
  active: boolean;
  busy: boolean;
  onDeleteSession: (id: string) => Promise<void>;
  onRenameSession: (id: string, title: string) => Promise<void>;
  onSelectSession: (id: string) => Promise<void>;
  session: SessionListItem;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);

  useEffect(() => {
    if (!isEditing) setDraftTitle(session.title);
  }, [isEditing, session.title]);

  const submitRename = async (event: React.FormEvent) => {
    event.preventDefault();
    const clean = draftTitle.trim();
    if (!clean || clean === session.title) {
      setIsEditing(false);
      setDraftTitle(session.title);
      return;
    }
    try {
      await onRenameSession(session.id, clean);
      setIsEditing(false);
    } catch {
      // Error is rendered by the history rail.
    }
  };

  const deleteCurrentSession = async () => {
    if (!window.confirm(`删除会话「${session.title}」？`)) return;
    try {
      await onDeleteSession(session.id);
    } catch {
      // Error is rendered by the history rail.
    }
  };

  return (
    <article
      className={cx(
        "rounded-xl px-2 py-2 transition",
        active ? "bg-slate-200/70 text-slate-950" : "text-slate-600 hover:bg-slate-100",
      )}
    >
      {isEditing ? (
        <form className="grid gap-2" onSubmit={submitRename}>
          <input
            autoFocus
            className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-900 outline-none focus:border-cyan-400"
            disabled={busy}
            maxLength={80}
            onChange={(event) => setDraftTitle(event.target.value)}
            value={draftTitle}
          />
          <div className="flex justify-end gap-1">
            <button
              className="grid h-8 w-8 place-items-center rounded-xl text-slate-500 hover:bg-slate-100 disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                setIsEditing(false);
                setDraftTitle(session.title);
              }}
              title="取消重命名"
              type="button"
            >
              <X size={16} />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-xl bg-slate-950 text-white disabled:opacity-50"
              disabled={busy || !draftTitle.trim()}
              title="保存会话名称"
              type="submit"
            >
              <Check size={16} />
            </button>
          </div>
        </form>
      ) : (
        <div className="flex items-start gap-2">
          <button
            className="min-w-0 flex-1 text-left"
            disabled={busy}
            onClick={() => void onSelectSession(session.id)}
            type="button"
          >
            <span className="flex min-w-0 items-center gap-2 text-sm font-black">
              <MessageSquare className="shrink-0" size={15} />
              <span className="truncate">{session.title}</span>
            </span>
            <span className="mt-1 block text-xs font-medium text-slate-400">
              {session.updatedAt} · {session.messageCount} 条消息
            </span>
          </button>
          <div className="flex shrink-0 gap-1">
            <button
              className="grid h-8 w-8 place-items-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
              disabled={busy}
              onClick={() => setIsEditing(true)}
              title="重命名会话"
              type="button"
            >
              <Pencil size={15} />
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-xl text-slate-400 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
              disabled={busy}
              onClick={() => void deleteCurrentSession()}
              title="删除会话"
              type="button"
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function VoicePicker({
  selectedVoice,
  setSelectedVoice,
}: {
  selectedVoice: RealtimeVoice;
  setSelectedVoice: (voice: RealtimeVoice) => void;
}) {
  return (
    <section className="mt-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-black text-slate-900">音色选择</h2>
          <p className="mt-0.5 text-xs font-semibold text-slate-500">下一次模型音频回复将使用所选音色。</p>
        </div>
        <Volume2 size={18} className="text-slate-400" />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
        {realtimeVoices.map((voice) => (
          <button
            key={voice}
            className={cx(
              "h-10 rounded-2xl text-sm font-black transition",
              selectedVoice === voice
                ? "bg-slate-950 text-white shadow-sm"
                : "bg-slate-50 text-slate-600 ring-1 ring-slate-200 hover:bg-white",
            )}
            onClick={() => setSelectedVoice(voice)}
            type="button"
          >
            {voice}
          </button>
        ))}
      </div>
    </section>
  );
}

const visionQuickPrompts = [
  {
    icon: Eye,
    label: "描述画面",
    description: "主体、位置和明显细节",
    prompt: "请描述你现在看到的画面，先说主体、位置和明显细节。",
  },
  {
    icon: FileText,
    label: "识别文字",
    description: "读取画面中的文字或标识",
    prompt: "请帮我识别画面里能看到的文字或标识，并说明它们可能代表什么。",
  },
  {
    icon: Check,
    label: "检查异常",
    description: "提醒需要注意的地方",
    prompt: "请检查当前画面里有没有异常、风险或需要我注意的地方。",
  },
  {
    icon: Radio,
    label: "解释变化",
    description: "结合最近画面变化",
    prompt: "请结合刚才到现在的画面变化，说明发生了什么。",
  },
] as const;

function VisionQuickPrompts({ onSelectPrompt }: { onSelectPrompt: (prompt: string) => void }) {
  return (
    <section className="mt-5 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3">
        <h2 className="text-sm font-black text-slate-900">视觉快捷提问</h2>
        <p className="mt-0.5 text-xs font-semibold text-slate-500">围绕当前摄像头画面生成问题。</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {visionQuickPrompts.map(({ icon: Icon, label, description, prompt }) => (
          <button
            key={label}
            className="flex min-h-16 items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-left transition hover:border-slate-300 hover:bg-white hover:shadow-sm"
            onClick={() => onSelectPrompt(prompt)}
            type="button"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white text-slate-700 ring-1 ring-slate-200">
              <Icon size={17} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-black text-slate-900">{label}</span>
              <span className="mt-0.5 block text-xs font-semibold text-slate-500">{description}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function ChatView(props: {
  aiState: AiState;
  canSend: boolean;
  cameraStatus: DeviceStatus;
  handleComposerAction: () => void;
  isProcessing: boolean;
  level: number;
  manualText: string;
  mediaAction: MediaAction;
  mediaState: string;
  microphoneStatus: DeviceStatus;
  messages: ChatMessage[];
  partial: string;
  replayAssistantAudio: (message: ChatMessage) => boolean;
  setManualText: (text: string) => void;
  sendManual: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  toggleVoiceSession: () => Promise<void>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  sampleRef: React.RefObject<HTMLCanvasElement | null>;
  videoPanePercent: number;
  setVideoPanePercent: (value: number) => void;
}) {
  const {
    aiState,
    canSend,
    cameraStatus,
    handleComposerAction,
    isProcessing,
    level,
    manualText,
    mediaAction,
    mediaState,
    microphoneStatus,
    messages,
    partial,
    replayAssistantAudio,
    setManualText,
    sendManual,
    toggleCamera,
    toggleVoiceSession,
    videoRef,
    canvasRef,
    sampleRef,
    videoPanePercent,
    setVideoPanePercent,
  } = props;
  const messageScrollerRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const element = messageScrollerRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [isProcessing, messages, partial]);

  const beginPaneResize = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const grid = gridRef.current;
      if (!grid) return;
      event.preventDefault();
      const rect = grid.getBoundingClientRect();
      const handleMove = (moveEvent: PointerEvent) => {
        const next = ((moveEvent.clientX - rect.left) / rect.width) * 100;
        setVideoPanePercent(Math.min(68, Math.max(42, next)));
      };
      const handleUp = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [setVideoPanePercent],
  );

  return (
    <section
      ref={gridRef}
      className="grid min-h-0 flex-1 gap-5 xl:grid-cols-[minmax(320px,var(--video-fr))_12px_minmax(360px,var(--chat-fr))]"
      style={
        {
          "--video-fr": `${videoPanePercent}fr`,
          "--chat-fr": `${100 - videoPanePercent}fr`,
        } as React.CSSProperties
      }
    >
      <div className="min-h-0 min-w-0 overflow-auto pr-1">
        <div className="relative aspect-[4/3] overflow-hidden rounded-3xl border border-slate-200 bg-slate-900 shadow-soft">
          <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
          <canvas ref={canvasRef} hidden />
          <canvas ref={sampleRef} hidden />
          <AiStatusIndicator state={aiState} />
          <CameraStatusDot status={cameraStatus} />
        </div>
        <VisionQuickPrompts onSelectPrompt={setManualText} />
      </div>

      <button
        className="hidden cursor-col-resize rounded-full bg-slate-200 transition hover:bg-slate-300 xl:block"
        onPointerDown={beginPaneResize}
        title="拖拽调整视频和对话宽度"
      />

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
        <div className="flex min-h-16 items-center justify-between border-b border-slate-100 px-5">
          <div className="flex items-center gap-2 font-black"><Radio size={18} /> 实时对话</div>
          {partial && <div className="max-w-[52%] truncate rounded-full bg-cyan-50 px-3 py-1 text-sm font-bold text-cyan-700">正在听：{partial}</div>}
        </div>
        <div ref={messageScrollerRef} className="flex-1 overflow-auto bg-white px-4 py-7">
          <div className="mx-auto flex min-w-0 w-full max-w-xl flex-col gap-7">
            {messages.map((message) => {
              if (message.role === "assistant" && !message.text.trim()) return null;
              if (message.role === "system" && message.text.startsWith("混合流式助手已就绪")) return null;
              if (message.role === "system") return <SystemNotice key={message.id} text={message.text} />;
              return <MessageBubble key={message.id} message={message} onReplayAudio={replayAssistantAudio} />;
            })}
          </div>
        </div>
        <Composer
          canSend={canSend}
          handleComposerAction={handleComposerAction}
          isProcessing={isProcessing}
          level={level}
          manualText={manualText}
          mediaAction={mediaAction}
          mediaState={mediaState}
          microphoneStatus={microphoneStatus}
          sendManual={sendManual}
          setManualText={setManualText}
          toggleCamera={toggleCamera}
          cameraStatus={cameraStatus}
          toggleVoiceSession={toggleVoiceSession}
        />
      </div>
    </section>
  );
}

function SystemNotice({ text }: { text: string }) {
  return (
    <div className="flex justify-center">
      <div className="inline-flex max-w-full items-start gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold leading-5 text-slate-600 shadow-sm">
        <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-pulse text-slate-500" />
        <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>
      </div>
    </div>
  );
}

function MessageBubble({ message, onReplayAudio }: { message: ChatMessage; onReplayAudio: (message: ChatMessage) => boolean }) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const copyResetTimerRef = useRef(0);

  useEffect(
    () => () => {
      window.clearTimeout(copyResetTimerRef.current);
    },
    [],
  );

  const copyMessage = useCallback(async () => {
    const text = message.text.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }, [message.text]);

  const speakMessage = useCallback(() => {
    if (onReplayAudio(message)) return;
    const text = message.text.trim();
    if (!text || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 0.98;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  }, [message, onReplayAudio]);

  const togglePositiveFeedback = useCallback(() => {
    setFeedback((current) => (current === "up" ? null : "up"));
  }, []);

  const toggleNegativeFeedback = useCallback(() => {
    setFeedback((current) => (current === "down" ? null : "down"));
  }, []);

  return (
    <article className={cx("flex min-w-0 w-full", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cx(
          "min-w-0 break-words text-[15px] leading-7 [overflow-wrap:anywhere]",
          isUser && "rounded-[1.6rem] bg-slate-100 px-5 py-3 text-slate-800",
          isUser && "w-fit max-w-[min(100%,28rem)] sm:max-w-[min(70%,28rem)]",
          isAssistant && "w-fit max-w-full px-1 py-1 text-slate-950 sm:max-w-[30rem]",
        )}
      >
        <p className="min-w-0 whitespace-pre-wrap break-words leading-7 [overflow-wrap:anywhere]">
          {message.text}
          {message.streaming && message.text ? <span className="ml-1 animate-pulse">▌</span> : null}
        </p>
        {isAssistant && message.text.trim() && !message.streaming ? (
          <div className="mt-3 flex items-center gap-1 text-slate-500">
            <button
              className="grid h-8 w-8 place-items-center rounded-full transition hover:bg-slate-100 hover:text-slate-900"
              onClick={copyMessage}
              title={copied ? "已复制" : "复制回复"}
              type="button"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
            <button
              className="grid h-8 w-8 place-items-center rounded-full transition hover:bg-slate-100 hover:text-slate-900"
              onClick={speakMessage}
              title="朗读回复"
              type="button"
            >
              <Volume2 size={16} />
            </button>
            <button
              aria-pressed={feedback === "up"}
              className={cx(
                "grid h-8 w-8 place-items-center rounded-full transition hover:bg-slate-100 hover:text-slate-900",
                feedback === "up" && "bg-slate-100 text-slate-950",
              )}
              onClick={togglePositiveFeedback}
              title="回复有帮助"
              type="button"
            >
              <ThumbsUp size={16} />
            </button>
            <button
              aria-pressed={feedback === "down"}
              className={cx(
                "grid h-8 w-8 place-items-center rounded-full transition hover:bg-slate-100 hover:text-slate-900",
                feedback === "down" && "bg-slate-100 text-slate-950",
              )}
              onClick={toggleNegativeFeedback}
              title="回复不准确"
              type="button"
            >
              <ThumbsDown size={16} />
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function Composer({
  canSend,
  cameraStatus,
  handleComposerAction,
  isProcessing,
  level,
  manualText,
  mediaAction,
  mediaState,
  microphoneStatus,
  sendManual,
  setManualText,
  toggleCamera,
  toggleVoiceSession,
}: {
  canSend: boolean;
  cameraStatus: DeviceStatus;
  handleComposerAction: () => void;
  isProcessing: boolean;
  level: number;
  manualText: string;
  mediaAction: MediaAction;
  mediaState: string;
  microphoneStatus: DeviceStatus;
  sendManual: () => Promise<void>;
  setManualText: (text: string) => void;
  toggleCamera: () => Promise<void>;
  toggleVoiceSession: () => Promise<void>;
}) {
  const cameraActive = cameraStatus === "active";
  const microphoneActive = microphoneStatus === "active" || mediaState === "running";
  const cameraButtonTitle = cameraActive ? "关闭摄像头权限" : "请求摄像头权限";
  const voiceButtonTitle = microphoneActive ? "关闭麦克风权限" : "请求麦克风权限并开启实时语音";
  return (
    <div className="border-t border-slate-100 bg-white px-5 py-5">
      <div className="mx-auto w-full max-w-xl rounded-[2rem] border border-slate-200 bg-white px-4 py-3 shadow-[0_10px_30px_rgba(15,23,42,0.08)]">
        <textarea
          className="min-h-12 w-full resize-none border-0 bg-transparent px-1 pt-1 text-base leading-7 text-slate-900 outline-none placeholder:text-slate-400"
          value={manualText}
          onChange={(event) => setManualText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!isProcessing && canSend) void sendManual();
            }
          }}
          placeholder="输入消息，或点击麦克风开始实时对话"
          rows={2}
        />
        <div className="flex items-center justify-between gap-3 px-1 pb-1">
          <span className="text-xs font-semibold text-slate-400">
            {microphoneActive ? "实时语音进行中" : cameraActive ? "摄像头已开启，文字问题可携带画面" : "文字可直接发送，按需开启摄像头或麦克风"}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              className={cx(
                "grid h-11 w-11 place-items-center rounded-full text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60",
                cameraActive && "bg-emerald-50 text-emerald-700 hover:bg-emerald-100",
                cameraStatus === "blocked" && "bg-rose-50 text-rose-700 hover:bg-rose-100",
              )}
              disabled={cameraStatus === "requesting"}
              onClick={() => void toggleCamera()}
              title={cameraButtonTitle}
              type="button"
            >
              <Camera size={20} />
            </button>
            <button
              className={cx(
                "grid h-11 w-11 place-items-center rounded-full text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60",
                microphoneActive && "bg-amber-50 text-amber-700 hover:bg-amber-100",
                microphoneStatus === "blocked" && "bg-rose-50 text-rose-700 hover:bg-rose-100",
              )}
              disabled={mediaAction !== null}
              onClick={() => void toggleVoiceSession()}
              title={voiceButtonTitle}
              type="button"
            >
              <Mic size={21} />
            </button>
            <button
              className={cx(
                "grid h-11 w-11 place-items-center rounded-full transition",
                isProcessing && "bg-slate-950 text-white hover:bg-slate-800",
                !isProcessing && canSend && "bg-blue-600 text-white hover:bg-blue-700",
                !isProcessing && !canSend && "cursor-not-allowed bg-slate-100 text-slate-400",
              )}
              disabled={!isProcessing && !canSend}
              onClick={handleComposerAction}
              title={isProcessing ? "中断回复" : "发送"}
              type="button"
            >
              {isProcessing ? <Square size={18} /> : <ArrowUp size={23} />}
            </button>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3 rounded-2xl bg-slate-50 px-3 py-2">
          <Mic size={16} className="text-slate-500" />
          <span className="text-xs font-black text-slate-500">麦克风流</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
            <span className="block h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.min(level * 900, 100)}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function CameraStatusDot({ status }: { status: DeviceStatus }) {
  const active = status === "active";
  return (
    <span
      aria-label={active ? "摄像头已开启" : "摄像头未开启"}
      className={cx(
        "absolute right-4 top-4 h-3.5 w-3.5 rounded-full ring-4 ring-slate-950/35",
        active ? "bg-emerald-400" : "bg-rose-500",
      )}
      title={active ? "摄像头已开启" : "摄像头未开启"}
    />
  );
}

function AiStatusIndicator({ state }: { state: AiState }) {
  const label = state === "listening" ? "正在倾听" : state === "processing" ? "模型思考中" : state === "speaking" ? "AI 正在说话" : "待机";
  return (
    <div className="absolute left-4 top-4 flex items-center gap-3 rounded-3xl bg-slate-950/70 px-4 py-3 text-white backdrop-blur">
      <div
        className={cx(
          "relative grid h-12 w-12 place-items-center rounded-full",
          state === "listening" && "bg-cyan-500/25",
          state === "processing" && "bg-gradient-to-br from-cyan-400 via-fuchsia-500 to-amber-300",
          state === "speaking" && "bg-emerald-500/20",
          state === "idle" && "bg-slate-500/30",
        )}
      >
        {state === "processing" ? <span className="absolute inset-0 rounded-full bg-gradient-to-r from-cyan-300 via-fuchsia-400 to-amber-300 animate-spin" /> : null}
        {state === "listening" ? <span className="absolute inset-0 rounded-full bg-cyan-400 opacity-50 animate-ping" /> : null}
        {state === "speaking" ? (
          <span className="relative flex h-7 items-center gap-1">
            {[0, 1, 2, 3].map((item) => (
              <i key={item} className="block h-6 w-1 rounded-full bg-emerald-300 animate-sound-wave" style={{ animationDelay: `${item * 90}ms` }} />
            ))}
          </span>
        ) : (
          <span className="relative h-7 w-7 rounded-full bg-slate-950" />
        )}
      </div>
      <div>
        <strong className="block text-sm">{label}</strong>
        <small className="text-xs text-white/70">{state === "processing" ? "分析画面与上下文" : state === "speaking" ? "语音输出中" : "实时会话"}</small>
      </div>
    </div>
  );
}

function SettingsView({
  selectedVoice,
  setSelectedVoice,
  user,
}: {
  selectedVoice: RealtimeVoice;
  setSelectedVoice: (voice: RealtimeVoice) => void;
  user: AuthSession["user"];
}) {
  return (
    <section className="max-w-3xl rounded-[2rem] border border-slate-200 bg-white p-7 shadow-soft">
      <div>
        <h2 className="text-2xl font-black">系统设置</h2>
        <p className="mt-1 text-sm font-semibold text-slate-500">管理账号资料和实时语音偏好。</p>
      </div>
      <div className="mt-6 grid gap-4">
        <ReadonlyField label="用户名" value={user.username} />
        <ReadonlyField label="用户 ID" value={user.id} />
        <VoicePicker selectedVoice={selectedVoice} setSelectedVoice={setSelectedVoice} />
      </div>
    </section>
  );
}

type ModelConfigForm = ModelConfigUpdate & { apiKey: string };
type ProviderPreset = {
  id: string;
  name: string;
  badge?: string;
  description: string;
  baseUrl: string;
  chatModel: string;
  supportsRealtime: boolean;
  realtimeEnabled: boolean;
  realtimeBaseUrl: string;
  realtimeModel: string;
  realtimeVoice: string;
};

const providerPresets: ProviderPreset[] = [
  {
    id: "dashscope",
    name: "阿里云百炼",
    badge: "Omni",
    description: "DashScope 兼容模式，支持 Qwen Omni Realtime。",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    chatModel: "qwen3.5-omni-plus",
    supportsRealtime: true,
    realtimeEnabled: true,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    badge: "常用",
    description: "DeepSeek 官方 OpenAI 兼容接口。",
    baseUrl: "https://api.deepseek.com",
    chatModel: "deepseek-chat",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    description: "智谱开放平台 GLM 系列模型。",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    chatModel: "glm-4.5",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "moonshot",
    name: "Moonshot Kimi",
    description: "月之暗面 Kimi OpenAI 兼容接口。",
    baseUrl: "https://api.moonshot.cn/v1",
    chatModel: "kimi-k2-0711-preview",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "baidu",
    name: "百度千帆",
    description: "千帆 ModelBuilder OpenAI 兼容入口。",
    baseUrl: "https://qianfan.baidubce.com/v2",
    chatModel: "ernie-4.5-turbo-vl",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "tencent",
    name: "腾讯混元",
    description: "混元 OpenAI 兼容 Chat Completions。",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    chatModel: "hunyuan-turbos-vision",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "volcengine",
    name: "火山方舟",
    description: "火山引擎方舟推理接入点。",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    chatModel: "doubao-1-5-vision-pro-32k",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    badge: "聚合",
    description: "国内聚合平台，适合快速切模型。",
    baseUrl: "https://api.siliconflow.cn/v1",
    chatModel: "Qwen/Qwen2.5-VL-72B-Instruct",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "minimax",
    name: "MiniMax",
    description: "MiniMax Open Platform 兼容接口。",
    baseUrl: "https://api.minimax.chat/v1",
    chatModel: "abab6.5s-chat",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    badge: "国际",
    description: "多模型路由，可填任意 OpenRouter 模型。",
    baseUrl: "https://openrouter.ai/api/v1",
    chatModel: "qwen/qwen2.5-vl-72b-instruct",
    supportsRealtime: false,
    realtimeEnabled: false,
    realtimeBaseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    realtimeModel: "qwen3-omni-flash-realtime",
    realtimeVoice: "Cherry",
  },
];

function modelConfigToForm(config: ModelConfig): ModelConfigForm {
  return {
    apiKey: "",
    baseUrl: config.baseUrl,
    chatModel: config.chatModel,
    realtimeEnabled: config.realtimeEnabled,
    realtimeBaseUrl: config.realtimeBaseUrl,
    realtimeModel: config.realtimeModel,
    realtimeVoice: config.realtimeVoice,
  };
}

function keySourceLabel(config: ModelConfig | null) {
  if (!config) return "读取中";
  if (config.keySource === "user") return `用户密钥 ${config.keyPreview}`;
  if (config.keySource === "environment") return "使用后端环境变量";
  return "未配置";
}

function normalizeUrlForPreset(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function findMatchingPreset(form: ModelConfigForm | null) {
  if (!form) return null;
  return providerPresets.find((preset) => normalizeUrlForPreset(preset.baseUrl) === normalizeUrlForPreset(form.baseUrl)) ?? null;
}

function ApiKeyManagementView({ apiBaseUrl, token }: { apiBaseUrl: string; token: string }) {
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [form, setForm] = useState<ModelConfigForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const selectedPreset = useMemo(() => findMatchingPreset(form), [form]);
  const realtimeConfigVisible = !selectedPreset || selectedPreset.supportsRealtime;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchModelConfig(apiBaseUrl, token);
      setConfig(next);
      setForm(modelConfigToForm(next));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载配置失败");
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, token]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const updateForm = useCallback(
    <Key extends keyof ModelConfigForm>(key: Key, value: ModelConfigForm[Key]) => {
      setForm((current) => (current ? { ...current, [key]: value } : current));
      setMessage("");
      setError("");
    },
    [],
  );

  const saveConfig = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!form) return;
      setSaving(true);
      setError("");
      try {
        const payload: ModelConfigUpdate = {
          baseUrl: form.baseUrl,
          chatModel: form.chatModel,
          realtimeEnabled: form.realtimeEnabled,
          realtimeBaseUrl: form.realtimeBaseUrl,
          realtimeModel: form.realtimeModel,
          realtimeVoice: form.realtimeVoice,
        };
        if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
        const next = await updateModelConfig(apiBaseUrl, token, payload);
        setConfig(next);
        setForm(modelConfigToForm(next));
        setMessage("模型配置已保存，新会话连接会使用最新配置。");
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : "保存配置失败");
      } finally {
        setSaving(false);
      }
    },
    [apiBaseUrl, form, token],
  );

  const clearApiKey = useCallback(async () => {
    if (!form) return;
    setClearing(true);
    setError("");
    try {
      const next = await updateModelConfig(apiBaseUrl, token, {
        ...form,
        apiKey: undefined,
        clearApiKey: true,
      });
      setConfig(next);
      setForm(modelConfigToForm(next));
      setMessage("用户 API Key 已清除。");
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : "清除密钥失败");
    } finally {
      setClearing(false);
    }
  }, [apiBaseUrl, form, token]);

  const applyPreset = useCallback((preset: ProviderPreset) => {
    setForm((current) => {
      const keepApiKey = current?.apiKey ?? "";
      return {
        apiKey: keepApiKey,
        baseUrl: preset.baseUrl,
        chatModel: preset.chatModel,
        realtimeEnabled: preset.realtimeEnabled,
        realtimeBaseUrl: preset.realtimeBaseUrl,
        realtimeModel: preset.realtimeModel,
        realtimeVoice: preset.realtimeVoice,
      };
    });
    setMessage(`已套用 ${preset.name} 预设，检查 API Key 后保存。`);
    setError("");
  }, []);

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-1 flex-col pb-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase text-emerald-700">Model switchboard</p>
          <h2 className="mt-1 text-3xl font-black text-slate-950">API Key 管理</h2>
          <p className="mt-2 max-w-2xl text-sm font-semibold leading-6 text-slate-500">
            选择供应商预设后填入密钥；自定义 Base URL 和模型名仍可直接编辑。
          </p>
        </div>
        <div className="min-w-[13rem] rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <span className="block text-xs font-black text-slate-400">当前密钥</span>
          <strong className={cx("mt-1 block text-sm", config?.keyConfigured ? "text-emerald-700" : "text-rose-700")}>
            {keySourceLabel(config)}
          </strong>
        </div>
      </div>
      {loading && <div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm font-bold text-slate-500">正在读取配置...</div>}
      {!loading && form && (
        <form className="grid min-h-0 gap-5 lg:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)]" onSubmit={saveConfig}>
          <aside className="self-start rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-lg font-black text-slate-950">预设供应商</h3>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-500">
                {selectedPreset?.name ?? "自定义"}
              </span>
            </div>
            <div className="grid max-h-[calc(100vh-17rem)] gap-2 overflow-y-auto pr-1 max-lg:max-h-none max-lg:grid-cols-2 max-sm:grid-cols-1">
              {providerPresets.map((preset) => {
                const active = selectedPreset?.id === preset.id;
                return (
                  <button
                    aria-pressed={active}
                    className={cx(
                      "group min-w-0 rounded-2xl border px-3 py-2.5 text-left transition focus:outline-none focus:ring-2 focus:ring-emerald-500",
                      active
                        ? "border-emerald-700 bg-emerald-700 text-white shadow-[0_12px_30px_rgba(4,120,87,0.18)]"
                        : "border-slate-200 bg-slate-50 text-slate-700 hover:border-slate-300 hover:bg-white",
                    )}
                    key={preset.id}
                    onClick={() => applyPreset(preset)}
                    type="button"
                    >
                      <span className="flex min-w-0 items-center justify-between gap-3">
                      <strong className="truncate text-[15px] font-black">{preset.name}</strong>
                      {preset.badge && (
                        <span
                          className={cx(
                            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-black",
                            active ? "bg-white/20 text-white" : "bg-amber-100 text-amber-700",
                          )}
                        >
                          {preset.badge}
                        </span>
                      )}
                    </span>
                    <span className={cx("mt-1 block truncate text-xs font-semibold", active ? "text-emerald-50" : "text-slate-500")}>
                      {preset.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="min-w-0 rounded-3xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-lg font-black text-slate-950">
                    {selectedPreset ? selectedPreset.name : "自定义配置"}
                  </h3>
                  <p className="mt-1 text-xs font-semibold text-slate-500">当前会话保持不变，新建或重连后使用保存的配置。</p>
                </div>
                {realtimeConfigVisible ? (
                  <label className="flex h-10 shrink-0 items-center gap-3 rounded-2xl bg-slate-100 px-3 text-sm font-black text-slate-700">
                    Realtime
                    <input
                      checked={form.realtimeEnabled}
                      className="h-5 w-5 accent-emerald-700"
                      disabled={Boolean(selectedPreset && !selectedPreset.supportsRealtime)}
                      onChange={(event) => updateForm("realtimeEnabled", event.target.checked)}
                      type="checkbox"
                    />
                  </label>
                ) : (
                  <span className="h-10 shrink-0 rounded-2xl bg-slate-100 px-3 pt-2.5 text-sm font-black text-slate-500">
                    Chat / Vision
                  </span>
                )}
              </div>
            </div>

            <div className="grid gap-4 px-5 py-5">
              <label className="grid min-w-0 gap-2 text-sm font-bold text-slate-600">
                API Key
                <input
                  autoComplete="off"
                  className="h-12 min-w-0 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none transition focus:border-emerald-600 focus:bg-white"
                  onChange={(event) => updateForm("apiKey", event.target.value)}
                  placeholder={config?.keyConfigured ? "留空表示保留当前密钥" : "输入模型服务 API Key"}
                  type="password"
                  value={form.apiKey}
                />
              </label>

              <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <label className="grid min-w-0 gap-2 text-sm font-bold text-slate-600">
                  Base URL
                  <input
                    className="h-12 min-w-0 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none transition focus:border-emerald-600 focus:bg-white"
                    onChange={(event) => updateForm("baseUrl", event.target.value)}
                    required
                    value={form.baseUrl}
                  />
                </label>
                <label className="grid min-w-0 gap-2 text-sm font-bold text-slate-600">
                  对话 / 视觉模型
                  <input
                    className="h-12 min-w-0 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none transition focus:border-emerald-600 focus:bg-white"
                    onChange={(event) => updateForm("chatModel", event.target.value)}
                    required
                    value={form.chatModel}
                  />
                </label>
              </div>

              {realtimeConfigVisible && form.realtimeEnabled ? (
                <>
                  <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                    <label className="grid min-w-0 gap-2 text-sm font-bold text-slate-600">
                      Realtime Base URL
                      <input
                        className="h-12 min-w-0 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none transition focus:border-emerald-600 focus:bg-white"
                        onChange={(event) => updateForm("realtimeBaseUrl", event.target.value)}
                        required
                        value={form.realtimeBaseUrl}
                      />
                    </label>
                    <label className="grid min-w-0 gap-2 text-sm font-bold text-slate-600">
                      Realtime 模型
                      <input
                        className="h-12 min-w-0 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none transition focus:border-emerald-600 focus:bg-white"
                        onChange={(event) => updateForm("realtimeModel", event.target.value)}
                        required
                        value={form.realtimeModel}
                      />
                    </label>
                  </div>

                  <label className="grid min-w-0 gap-2 text-sm font-bold text-slate-600">
                    默认音色
                    <input
                      className="h-12 min-w-0 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none transition focus:border-emerald-600 focus:bg-white"
                      onChange={(event) => updateForm("realtimeVoice", event.target.value)}
                      required
                      value={form.realtimeVoice}
                    />
                  </label>
                </>
              ) : null}

              {message && <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">{message}</div>}
              {error && <div className="rounded-2xl bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">{error}</div>}
            </div>

            <div className="sticky bottom-0 flex flex-wrap gap-3 border-t border-slate-100 bg-white/95 px-5 py-4 backdrop-blur">
              <button
                className="h-11 rounded-2xl bg-emerald-700 px-5 text-sm font-black text-white hover:bg-emerald-800 disabled:opacity-60"
                disabled={saving || clearing}
                type="submit"
              >
                {saving ? "保存中..." : "保存配置"}
              </button>
              <button
                className="h-11 rounded-2xl bg-slate-100 px-5 text-sm font-black text-slate-700 hover:bg-slate-200 disabled:opacity-60"
                disabled={saving || clearing || config?.keySource !== "user"}
                onClick={() => void clearApiKey()}
                type="button"
              >
                {clearing ? "清除中..." : "清除用户密钥"}
              </button>
            </div>
          </div>
        </form>
      )}
    </section>
  );
}

const usageWindows = [7, 30, 90] as const;
const RECENT_EVENTS_PAGE_SIZE = 6;
const modalityLabels: Record<string, string> = {
  llm: "LLM 文本",
  vlm: "VLM 视觉",
  stt: "STT 语音识别",
  tts: "TTS 语音合成",
};

function UsageStatsView({
  apiBaseUrl,
  cost,
  token,
}: {
  apiBaseUrl: string;
  cost: CostSnapshot;
  token: string;
}) {
  const [days, setDays] = useState<(typeof usageWindows)[number]>(7);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [recentPage, setRecentPage] = useState(0);

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setStats(await fetchUsageStats(apiBaseUrl, token, days));
    } catch (statsError) {
      setError(statsError instanceof Error ? statsError.message : "用量统计加载失败");
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, days, token]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    setRecentPage(0);
  }, [days]);

  const totals = stats?.totals ?? emptyUsageTotals();
  const actualTokens = totals.promptTokens + totals.completionTokens;
  const estimatedTokens = totals.estimatedPromptTokens + totals.estimatedCompletionTokens;
  const currentInputTokens = cost.llmInputTokens || cost.llmInputTokensEst;
  const currentOutputTokens = cost.llmOutputTokens || cost.llmOutputTokensEst;
  const recentEvents = stats?.recentEvents ?? [];
  const recentPageCount = Math.max(1, Math.ceil(recentEvents.length / RECENT_EVENTS_PAGE_SIZE));
  const safeRecentPage = Math.min(recentPage, recentPageCount - 1);
  const visibleRecentEvents = recentEvents.slice(
    safeRecentPage * RECENT_EVENTS_PAGE_SIZE,
    safeRecentPage * RECENT_EVENTS_PAGE_SIZE + RECENT_EVENTS_PAGE_SIZE,
  );

  return (
    <section className="min-h-full bg-white px-1 py-1 text-slate-950">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <div className="grid gap-4 border-b border-slate-300 pb-5 xl:grid-cols-[1.35fr_0.65fr]">
          <div className="min-w-0">
            <h2 className="max-w-4xl text-3xl font-black leading-tight tracking-normal text-slate-950 md:text-5xl">
              模型消耗统计
            </h2>
          </div>
          <div className="grid content-end gap-3">
            <div className="flex flex-wrap justify-start gap-2 xl:justify-end">
              {usageWindows.map((windowDays) => (
                <button
                  className={cx(
                    "h-9 rounded-lg border px-3 text-sm font-black transition",
                    days === windowDays
                      ? "border-slate-950 bg-slate-950 text-white"
                      : "border-slate-300 bg-white text-slate-700 hover:border-slate-500",
                  )}
                  key={windowDays}
                  onClick={() => setDays(windowDays)}
                  type="button"
                >
                  {windowDays} 天
                </button>
              ))}
              <button
                className="grid h-9 w-9 place-items-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:border-slate-500 disabled:opacity-50"
                disabled={loading}
                onClick={() => void loadStats()}
                title="刷新统计"
                type="button"
              >
                <RefreshCw className={cx(loading && "animate-spin")} size={16} />
              </button>
            </div>
            <div className="text-left text-xs font-bold text-slate-500 xl:text-right">
              {stats ? `统计至 ${dateTimeLabel(stats.generatedAt)}` : "等待统计数据"}
            </div>
          </div>
        </div>

        {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">{error}</div>}

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <UsageKpi icon={<Gauge size={19} />} label="估算计费单位" value={formatCompact(totals.estimatedUnits)} accent="bg-lime-300" />
          <UsageKpi icon={<BarChart3 size={19} />} label="真实 token" value={formatCompact(actualTokens)} subValue={`估算 ${formatCompact(estimatedTokens)}`} accent="bg-cyan-300" />
          <UsageKpi icon={<Timer size={19} />} label="STT 音频" value={formatDuration(totals.audioMs)} subValue={`有效语音 ${formatDuration(totals.speechMs)}`} accent="bg-amber-300" />
          <UsageKpi icon={<Volume2 size={19} />} label="TTS 输出" value={`${formatCompact(totals.ttsChars)} 字`} subValue={`音频 ${formatDuration(totals.ttsAudioMs)}`} accent="bg-rose-300" />
        </div>

        <div className="grid gap-5 xl:grid-cols-[0.92fr_1.08fr]">
          <section className="rounded-lg border border-slate-300 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-black text-slate-900">当前会话实时快照</h3>
              <span className="rounded bg-slate-100 px-2 py-1 text-xs font-black text-slate-500">{formatCompact(cost.estimatedUnits)} units</span>
            </div>
            <div className="grid gap-0 divide-y divide-slate-100">
              <UsageLine icon={<Mic size={16} />} label="STT 上传音频" value={formatSeconds(cost.audioSeconds)} detail={`有效语音 ${formatSeconds(cost.speechSeconds)} · ${cost.audioChunks} 帧`} />
              <UsageLine icon={<Eye size={16} />} label="VLM 图片输入" value={`${cost.visionFrames} 帧`} detail={`缓存命中 ${cost.visionCacheHits}`} />
              <UsageLine icon={<Activity size={16} />} label="LLM token" value={formatCompact(currentInputTokens + currentOutputTokens)} detail={`输入 ${formatCompact(currentInputTokens)} · 输出 ${formatCompact(currentOutputTokens)}`} />
              <UsageLine icon={<FileText size={16} />} label="TTS 输出" value={`${formatCompact(cost.ttsChars)} 字`} detail={`音频 ${formatSeconds(cost.ttsAudioSeconds ?? 0)} · 打断 ${cost.interruptions} 次`} />
            </div>
          </section>

          <section className="rounded-lg border border-slate-300 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-black text-slate-900">模态拆分</h3>
              <span className="text-xs font-bold text-slate-500">{totals.eventCount} 条计量事件</span>
            </div>
            <div className="grid gap-3 p-4">
              {stats?.modalities.length ? (
                stats.modalities.map((bucket) => (
                  <ModalityUsageBar key={bucket.modality} bucket={bucket} maxUnits={maxBucketUnits(stats.modalities)} />
                ))
              ) : (
                <EmptyUsageState text="还没有聚合事件。开始一次对话后，后台队列会写入新的计量事件。" />
              )}
            </div>
          </section>
        </div>

        <div className="grid gap-5 xl:grid-cols-[1fr_0.8fr]">
          <section className="rounded-lg border border-slate-300 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-black text-slate-900">每日趋势</h3>
              <span className="text-xs font-bold text-slate-500">{days} 天窗口</span>
            </div>
            <DailyUsageChart daily={stats?.daily ?? []} />
          </section>

          <section className="rounded-lg border border-slate-300 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="text-sm font-black text-slate-900">最近事件</h3>
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-slate-500">
                  {recentEvents.length ? `${safeRecentPage + 1} / ${recentPageCount}` : "0 / 0"}
                </span>
                <Database size={16} className="text-slate-400" />
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              {visibleRecentEvents.length ? (
                visibleRecentEvents.map((event, index) => <RecentUsageEvent event={event} key={`${event.createdAt}-${safeRecentPage}-${index}`} />)
              ) : (
                <EmptyUsageState text="暂无事件记录。" />
              )}
            </div>
            {recentEvents.length > RECENT_EVENTS_PAGE_SIZE && (
              <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
                <button
                  className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-black text-slate-600 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={safeRecentPage === 0}
                  onClick={() => setRecentPage((page) => Math.max(0, page - 1))}
                  type="button"
                >
                  上一页
                </button>
                <span className="text-xs font-bold text-slate-500">
                  {safeRecentPage * RECENT_EVENTS_PAGE_SIZE + 1}-{Math.min((safeRecentPage + 1) * RECENT_EVENTS_PAGE_SIZE, recentEvents.length)} / {recentEvents.length}
                </span>
                <button
                  className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-black text-slate-600 transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={safeRecentPage >= recentPageCount - 1}
                  onClick={() => setRecentPage((page) => Math.min(recentPageCount - 1, page + 1))}
                  type="button"
                >
                  下一页
                </button>
              </div>
            )}
          </section>
        </div>

        <section className="rounded-lg border border-slate-300 bg-white">
          <div className="grid grid-cols-[1.4fr_0.8fr_0.8fr_0.8fr] gap-3 border-b border-slate-200 px-4 py-3 text-xs font-black uppercase tracking-[0.12em] text-slate-500 max-md:hidden">
            <span>会话</span>
            <span>token</span>
            <span>音频</span>
            <span>单位</span>
          </div>
          <div className="divide-y divide-slate-100">
            {stats?.conversations.length ? (
              stats.conversations.map((conversation) => <ConversationUsageRow conversation={conversation} key={conversation.id} />)
            ) : (
              <EmptyUsageState text="这个时间窗口内还没有会话用量。" />
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function emptyUsageTotals(): UsageTotals {
  return {
    eventCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    audioMs: 0,
    speechMs: 0,
    audioChunks: 0,
    ttsChars: 0,
    ttsAudioMs: 0,
    imageCount: 0,
    estimatedUnits: 0,
  };
}

function UsageKpi({
  accent,
  icon,
  label,
  subValue,
  value,
}: {
  accent: string;
  icon: React.ReactNode;
  label: string;
  subValue?: string;
  value: string;
}) {
  return (
    <article className="rounded-lg border border-slate-300 bg-white p-4">
      <div className="mb-5 flex items-center justify-between">
        <span className={cx("grid h-8 w-8 place-items-center rounded-lg text-slate-950", accent)}>{icon}</span>
        <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">{label}</span>
      </div>
      <strong className="block text-3xl font-black leading-none text-slate-950">{value}</strong>
      {subValue && <span className="mt-2 block text-xs font-bold text-slate-500">{subValue}</span>}
    </article>
  );
}

function UsageLine({ detail, icon, label, value }: { detail: string; icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="grid grid-cols-[28px_1fr_auto] items-center gap-3 px-4 py-3">
      <span className="grid h-7 w-7 place-items-center rounded bg-slate-100 text-slate-600">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-black text-slate-900">{label}</span>
        <span className="block truncate text-xs font-semibold text-slate-500">{detail}</span>
      </span>
      <strong className="text-right text-lg font-black text-slate-950">{value}</strong>
    </div>
  );
}

function ModalityUsageBar({ bucket, maxUnits }: { bucket: UsageBucket; maxUnits: number }) {
  const width = maxUnits > 0 ? Math.max(5, Math.round((bucket.estimatedUnits / maxUnits) * 100)) : 0;
  const tokens = bucket.promptTokens + bucket.completionTokens || bucket.estimatedPromptTokens + bucket.estimatedCompletionTokens;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm font-black text-slate-900">{modalityLabels[bucket.modality ?? ""] ?? bucket.modality}</span>
        <span className="text-xs font-bold text-slate-500">
          {formatCompact(bucket.estimatedUnits)} units · {formatCompact(tokens)} token
        </span>
      </div>
      <div className="h-3 rounded bg-slate-100">
        <div className="h-3 rounded bg-slate-950" style={{ width: `${width}%` }} />
      </div>
      <div className="mt-2 text-xs font-semibold text-slate-500">
        图片 {bucket.imageCount} · 音频 {formatDuration(bucket.audioMs)} · TTS {formatCompact(bucket.ttsChars)} 字
      </div>
    </div>
  );
}

function DailyUsageChart({ daily }: { daily: UsageBucket[] }) {
  if (!daily.length) return <EmptyUsageState text="暂无每日趋势。" />;
  const maxUnits = maxBucketUnits(daily);
  return (
    <div className="flex h-64 items-end gap-2 px-4 pb-4 pt-6">
      {daily.map((day) => {
        const height = maxUnits > 0 ? Math.max(8, Math.round((day.estimatedUnits / maxUnits) * 100)) : 0;
        return (
          <div className="flex min-w-0 flex-1 flex-col items-center gap-2" key={day.day}>
            <div className="flex h-48 w-full items-end rounded bg-slate-100">
              <div className="w-full rounded bg-cyan-500" style={{ height: `${height}%` }} title={`${day.day}: ${day.estimatedUnits} units`} />
            </div>
            <span className="max-w-full truncate text-[11px] font-bold text-slate-500">{day.day?.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

function RecentUsageEvent({ event }: { event: UsageEvent }) {
  const tokens = event.promptTokens + event.completionTokens || event.estimatedPromptTokens + event.estimatedCompletionTokens;
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3">
      <span className="min-w-0">
        <span className="block truncate text-sm font-black text-slate-900">{modalityLabels[event.modality] ?? event.modality}</span>
        <span className="block truncate text-xs font-semibold text-slate-500">
          {event.metricType} · {event.model || event.provider}
        </span>
      </span>
      <span className="text-right text-xs font-bold text-slate-500">
        <strong className="block text-sm font-black text-slate-950">{tokens ? `${formatCompact(tokens)} token` : formatDuration(event.audioMs || event.ttsAudioMs)}</strong>
        {timeLabel(event.createdAt)}
      </span>
    </div>
  );
}

function ConversationUsageRow({ conversation }: { conversation: UsageBucket }) {
  const tokens = conversation.promptTokens + conversation.completionTokens || conversation.estimatedPromptTokens + conversation.estimatedCompletionTokens;
  return (
    <div className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[1.4fr_0.8fr_0.8fr_0.8fr] md:items-center">
      <span className="min-w-0">
        <span className="block truncate font-black text-slate-950">{conversation.title ?? "未命名会话"}</span>
        <span className="block text-xs font-semibold text-slate-500">{conversation.lastUsedAt ? dateTimeLabel(conversation.lastUsedAt) : "暂无时间"}</span>
      </span>
      <span className="font-bold text-slate-700">{formatCompact(tokens)}</span>
      <span className="font-bold text-slate-700">{formatDuration(conversation.audioMs)}</span>
      <span className="font-black text-slate-950">{formatCompact(conversation.estimatedUnits)}</span>
    </div>
  );
}

function EmptyUsageState({ text }: { text: string }) {
  return <p className="px-4 py-6 text-sm font-bold text-slate-500">{text}</p>;
}

function maxBucketUnits(buckets: UsageBucket[]) {
  return Math.max(0, ...buckets.map((bucket) => bucket.estimatedUnits));
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: value >= 10 ? 0 : 2 }).format(value);
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

function formatSeconds(seconds: number) {
  return formatDuration(Math.round(seconds * 1000));
}

function dateTimeLabel(timestamp: number) {
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <label className="grid gap-2 text-sm font-bold text-slate-600">
      {label}
      <input className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none" value={value} readOnly />
    </label>
  );
}
