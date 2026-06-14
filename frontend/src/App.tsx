import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  BarChart3,
  Camera,
  Check,
  CircleStop,
  Eye,
  History,
  MessageSquare,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Play,
  Radio,
  Settings,
  Shield,
  Square,
  Pencil,
  Trash2,
  Volume2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { AudioCapture } from "./lib/audioCapture";
import { PcmStreamPlayer } from "./lib/pcmPlayer";
import {
  createConversation,
  deleteConversation,
  fetchConversationMessages,
  fetchConversations,
  fetchCurrentUser,
  loadStoredAuth,
  loginUser,
  registerUser,
  renameConversation,
  storeAuth,
  type AuthSession,
  type PersistedConversation,
  type PersistedMessage,
} from "./lib/api";
import { GatewayClient } from "./lib/wsClient";
import type { ChatMessage, CostSnapshot, GatewayEvent, VadSnapshot } from "./types";

const visualKeywords = ["看", "看到", "这个", "那个", "画面", "颜色", "桌", "手里", "旁边", "前面", "物体", "摄像头"];
const SPEECH_AUTO_SEND_DELAY_MS = 1200;
const DUPLICATE_SPEECH_WINDOW_MS = 1800;
const VOICE_STORAGE_KEY = "ai-vision-realtime-voice";
const realtimeVoices = ["Cherry", "Serena", "Ethan", "Chelsie"] as const;
type RealtimeVoice = (typeof realtimeVoices)[number];

const emptyCost: CostSnapshot = {
  audioSeconds: 0,
  speechSeconds: 0,
  audioChunks: 0,
  visionFrames: 0,
  visionCacheHits: 0,
  llmInputTokensEst: 0,
  llmOutputTokensEst: 0,
  ttsChars: 0,
  interruptions: 0,
  estimatedUnits: 0,
};

type AppView = "chat" | "cost" | "settings";
type AiState = "idle" | "listening" | "processing" | "speaking";
type SessionMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};
type SessionListItem = SessionMeta & { messageCount: number };

function uid() {
  return crypto.randomUUID();
}

function containsVisualIntent(text: string) {
  return visualKeywords.some((keyword) => text.includes(keyword));
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
  const streamRef = useRef<MediaStream | null>(null);
  const assistantMessageIdRef = useRef<string | null>(null);
  const assistantPlaceholderRef = useRef(false);
  const assistantTextRef = useRef("");
  const assistantTextFromTtsRef = useRef(false);
  const ttsQueueRef = useRef<string[]>([]);
  const ttsPlayingRef = useRef(false);
  const recognitionPausedForTtsRef = useRef(false);
  const recognitionDisabledRef = useRef(false);
  const recognitionRestartTimerRef = useRef(0);
  const recognitionStarterRef = useRef<() => void>(() => {});
  const pendingSpeechRef = useRef("");
  const pendingSpeechTimerRef = useRef(0);
  const lastSubmittedSpeechRef = useRef<{ text: string; at: number } | null>(null);
  const lastSampleRef = useRef<Uint8ClampedArray | null>(null);
  const lastVisionAtRef = useRef(0);
  const speechFrameCountRef = useRef(0);
  const lastSpeechFrameAtRef = useRef(0);
  const realtimeAudioRef = useRef(false);
  const modelAudioPlayingRef = useRef(false);
  const runningRef = useRef(false);
  const aiStateRef = useRef<AiState>("idle");

  const [connectionState, setConnectionState] = useState("closed");
  const [sessionReady, setSessionReady] = useState(false);
  const [mediaReady, setMediaReady] = useState(false);
  const [mediaState, setMediaState] = useState("idle");
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState("");
  const [sessions, setSessions] = useState<SessionMeta[]>([
    { id: initialSessionId, title: "当前会话", createdAt: timeLabel(), updatedAt: timeLabel() },
  ]);
  const [sessionMessages, setSessionMessages] = useState<Record<string, ChatMessage[]>>({
    [initialSessionId]: createStarterMessages(),
  });
  const [cost, setCost] = useState<CostSnapshot>(emptyCost);
  const [manualText, setManualText] = useState("");
  const [lastError, setLastError] = useState("");
  const [authError, setAuthError] = useState("");
  const [permissionStatus, setPermissionStatus] = useState("等待启动");
  const [asrStatus, setAsrStatus] = useState("未启动");
  const [activeView, setActiveView] = useState<AppView>("chat");
  const [aiState, setAiState] = useState<AiState>("idle");
  const [selectedVoice, setSelectedVoice] = useState<RealtimeVoice>(() => loadStoredVoice());
  const [realtimeAudio, setRealtimeAudio] = useState(false);
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
  const gatewayReady = connectionState === "open" && sessionReady && mediaReady;
  const permissionNeedsAction =
    permissionStatus.includes("denied") ||
    permissionStatus.includes("拒绝") ||
    permissionStatus.includes("失败") ||
    permissionStatus.includes("等待启动");
  const historySessions = useMemo<SessionListItem[]>(
    () =>
      sessions.map((session) => ({
        ...session,
        messageCount: (sessionMessages[session.id] ?? []).filter((message) => message.role !== "system").length,
      })),
    [sessionMessages, sessions],
  );

  useEffect(() => {
    aiStateRef.current = aiState;
  }, [aiState]);

  useEffect(() => {
    setSessions((current) =>
      current.map((session) =>
        session.id === currentSessionId ? { ...session, updatedAt: timeLabel() } : session,
      ),
    );
  }, [currentSessionId, messages.length]);

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

  const processTtsQueue = useCallback(() => {
    if (ttsPlayingRef.current) return;
    const next = ttsQueueRef.current.shift();
    if (!next || !("speechSynthesis" in window)) {
      recognitionPausedForTtsRef.current = false;
      if (runningRef.current && !recognitionDisabledRef.current) {
        window.clearTimeout(recognitionRestartTimerRef.current);
        recognitionRestartTimerRef.current = window.setTimeout(() => recognitionStarterRef.current(), 250);
      }
      setAiState(runningRef.current ? "listening" : "idle");
      return;
    }
    recognitionPausedForTtsRef.current = true;
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
      processTtsQueue();
    };
    utterance.onerror = () => {
      ttsPlayingRef.current = false;
      processTtsQueue();
    };
    window.speechSynthesis.speak(utterance);
  }, [clearPendingSpeech]);

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

  const computeFrameDiff = useCallback(() => {
    const video = videoRef.current;
    const sample = sampleRef.current;
    if (!video || !sample) return 100;
    const context = sample.getContext("2d", { willReadFrequently: true });
    if (!context) return 100;
    sample.width = 64;
    sample.height = 36;
    context.drawImage(video, 0, 0, sample.width, sample.height);
    const data = context.getImageData(0, 0, sample.width, sample.height).data;
    const previous = lastSampleRef.current;
    lastSampleRef.current = new Uint8ClampedArray(data);
    if (!previous) return 100;
    let diff = 0;
    for (let i = 0; i < data.length; i += 16) diff += Math.abs(data[i] - previous[i]);
    return diff / (data.length / 16);
  }, []);

  const captureFrame = useCallback(
    async (reason: string, force = false) => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
      const now = Date.now();
      const diff = computeFrameDiff();
      const shouldSend = force || reason === "semantic" || now - lastVisionAtRef.current > 12000 || diff > 18;
      if (!shouldSend) return false;

      const width = 720;
      const height = Math.round((video.videoHeight / Math.max(video.videoWidth, 1)) * width) || 405;
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return false;
      context.drawImage(video, 0, 0, width, height);
      const image = canvas.toDataURL("image/jpeg", reason === "semantic" ? 0.78 : 0.66);
      const sent = client.send("vision.frame", { image, reason, diff: Number(diff.toFixed(2)) });
      if (sent) lastVisionAtRef.current = now;
      return sent;
    },
    [client, computeFrameDiff],
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
      if (containsVisualIntent(clean)) await captureFrame("semantic", true);
      client.send("browser.asr.final", { text: clean });
    },
    [captureFrame, client, finishAssistant, stopSpeech],
  );

  const submitRecognizedSpeech = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean || !runningRef.current || recognitionPausedForTtsRef.current || recognitionDisabledRef.current) return;

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
    [clearPendingSpeech, sendFinalTranscript],
  );

  const scheduleRecognizedSpeech = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean || recognitionPausedForTtsRef.current || recognitionDisabledRef.current) return;

      pendingSpeechRef.current = clean;
      window.clearTimeout(pendingSpeechTimerRef.current);
      pendingSpeechTimerRef.current = window.setTimeout(() => {
        const pending = pendingSpeechRef.current.trim();
        if (!pending || !runningRef.current || recognitionPausedForTtsRef.current || recognitionDisabledRef.current) return;
        submitRecognizedSpeech(pending);
      }, SPEECH_AUTO_SEND_DELAY_MS);
    },
    [submitRecognizedSpeech],
  );

  const handleGatewayEvent = useCallback(
    (event: GatewayEvent) => {
      if (event.type === "session.ready") {
        setConnectionState("open");
        setSessionReady(true);
        const enabled = event.capabilities.realtime === true;
        realtimeAudioRef.current = enabled;
        setRealtimeAudio(enabled);
        if (enabled) {
          setAsrStatus("Qwen Realtime ASR");
          try {
            recognitionRef.current?.stop?.();
          } catch {
            // Ignore duplicate stop.
          }
          recognitionRef.current = null;
        }
      }
      if (event.type === "asr.partial") {
        setPartial(event.text);
        setAiState("listening");
      }
      if (event.type === "asr.final") {
        setPartial("");
        appendMessage({ id: uid(), role: "user", text: event.text });
        setSessions((current) =>
          current.map((session) =>
            session.id === currentSessionId && (session.title === "新会话" || session.title === "当前会话" || session.title.startsWith("会话 "))
              ? { ...session, title: event.text.slice(0, 28), updatedAt: timeLabel() }
              : session,
          ),
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
        void ensureAudioPlayer().play(event.audio, event.sampleRate);
      }
      if (event.type === "response.audio.done") {
        if (!modelAudioPlayingRef.current && !assistantMessageIdRef.current) setAiState(runningRef.current ? "listening" : "idle");
      }
      if (event.type === "tts.audio.chunk") {
        if (!assistantMessageIdRef.current) beginAssistantResponse();
        if (event.text?.trim() && (assistantTextFromTtsRef.current || !assistantTextRef.current.trim())) {
          updateAssistantDelta(event.text, "tts");
        }
        if (!realtimeAudioRef.current) enqueueSpeech(event.text);
      }
      if (event.type === "llm.done") finishAssistant(event.cancelled);
      if (event.type === "speech.cancelled") {
        stopModelAudio();
        stopSpeech();
        finishAssistant(true);
      }
      if (event.type === "voice.updated") setSelectedVoice(event.voice as RealtimeVoice);
      if (event.type === "session.cost") setCost(event.cost);
      if (event.type === "error") setLastError(`${event.code}: ${event.message}`);
    },
    [appendMessage, beginAssistantResponse, currentSessionId, enqueueSpeech, ensureAudioPlayer, finishAssistant, stopModelAudio, stopSpeech, updateAssistantDelta],
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
    if (realtimeAudioRef.current) {
      setAsrStatus("Qwen Realtime ASR");
      return;
    }
    if (recognitionRef.current || recognitionDisabledRef.current || recognitionPausedForTtsRef.current) return;
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
    setAsrStatus("浏览器 ASR 运行中");
    recognition.onresult = (event: any) => {
      if (!runningRef.current || recognitionPausedForTtsRef.current || recognitionDisabledRef.current) return;
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
      if (finalText.trim()) submitRecognizedSpeech(finalText.trim());
    };
    recognition.onerror = (event: any) => {
      const error = event.error ?? "unknown";
      if (error === "network") {
        recognitionDisabledRef.current = true;
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
      if (runningRef.current && !recognitionPausedForTtsRef.current && !recognitionDisabledRef.current) {
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
  }, [appendMessage, client, scheduleRecognizedSpeech, submitRecognizedSpeech]);

  useEffect(() => {
    recognitionStarterRef.current = startSpeechRecognition;
  }, [startSpeechRecognition]);

  useEffect(
    () => () => {
      pendingSpeechRef.current = "";
      window.clearTimeout(pendingSpeechTimerRef.current);
      window.clearTimeout(recognitionRestartTimerRef.current);
    },
    [],
  );
  
  const handleVad = useCallback(
    (snapshot: VadSnapshot) => {
      if (!runningRef.current) return;

      if (snapshot.speechStart) {
        const assistantIsSpeaking =
          modelAudioPlayingRef.current ||
          aiStateRef.current === "speaking" ||
          ttsPlayingRef.current ||
          ttsQueueRef.current.length > 0;

        if (assistantIsSpeaking) interruptActiveSpeech("barge_in");

        speechFrameCountRef.current = 1;
        lastSpeechFrameAtRef.current = Date.now();
        void captureFrame("speech-start", true);
      }

      if (snapshot.isSpeech && speechFrameCountRef.current > 0 && speechFrameCountRef.current < 2) {
        const now = Date.now();
        if (now - lastSpeechFrameAtRef.current > 1200) {
          speechFrameCountRef.current += 1;
          lastSpeechFrameAtRef.current = now;
          void captureFrame("speech-active", true);
        }
      }

      if (snapshot.speechEnd) {
        speechFrameCountRef.current = 0;
        lastSpeechFrameAtRef.current = 0;
      }
    },
    [captureFrame, interruptActiveSpeech],
  );
  
  const startSession = useCallback(async () => {
    let grantedStream: MediaStream | null = null;
    try {
      if (!conversationsLoaded || !currentSessionId) {
        setLastError("会话历史正在加载，请稍后再启动。");
        return;
      }
      setLastError("");
      setPermissionStatus("正在请求摄像头和麦克风权限...");
      setAsrStatus("准备启动");
      setSessionReady(false);
      setMediaReady(false);
      clearPendingSpeech();
      client.close();

      grantedStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      setPermissionStatus("摄像头和麦克风已授权");
      setMediaReady(true);
      streamRef.current = grantedStream;
      if (videoRef.current) {
        videoRef.current.srcObject = grantedStream;
        await videoRef.current.play();
      }

      setConnectionState("connecting");
      client.connect();
      await client.waitOpen();
      client.send("session.start");
      client.send("session.voice.update", { voice: selectedVoice });

      const audioCapture = new AudioCapture(client, setLevel, handleVad);
      await audioCapture.start(grantedStream);
      audioCaptureRef.current = audioCapture;
      runningRef.current = true;
      setAiState("listening");
      setMediaState("running");
      if (realtimeAudioRef.current) setAsrStatus("Qwen Realtime ASR");
      else startSpeechRecognition();
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      let message = raw;
      if (error instanceof DOMException) {
        if (error.name === "NotAllowedError") message = "摄像头或麦克风权限被拒绝，请在浏览器地址栏权限设置中允许后重试。";
        if (error.name === "NotFoundError") message = "没有检测到可用的摄像头或麦克风设备。";
        if (error.name === "NotReadableError") message = "摄像头或麦克风被其他应用占用，请关闭占用后重试。";
      }
      grantedStream?.getTracks().forEach((track) => track.stop());
      client.close();
      setSessionReady(false);
      setMediaReady(false);
      setPermissionStatus("启动失败");
      setLastError(message);
      setMediaState("error");
      setConnectionState(client.state);
    }
  }, [clearPendingSpeech, client, conversationsLoaded, currentSessionId, handleVad, selectedVoice, startSpeechRecognition]);
  
  const stopSession = useCallback(async () => {
    runningRef.current = false;
    clearPendingSpeech();
    stopModelAudio();
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    window.speechSynthesis?.cancel();
    window.clearTimeout(recognitionRestartTimerRef.current);
    recognitionDisabledRef.current = false;
    recognitionPausedForTtsRef.current = false;
    try {
      recognitionRef.current?.stop?.();
    } catch {
      // Some browsers throw if recognition has already stopped.
    }
    recognitionRef.current = null;
    await audioCaptureRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    audioCaptureRef.current = null;
    client.close();
    if (assistantMessageIdRef.current) finishAssistant(true);
    setSessionReady(false);
    setMediaReady(false);
    setMediaState("stopped");
    setConnectionState("closed");
    setAsrStatus("已停止");
    setAiState("idle");
  }, [clearPendingSpeech, client, finishAssistant, stopModelAudio]);

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

  const startNewConversation = useCallback(async () => {
    if (!authSession?.accessToken) return;
    if (runningRef.current) await stopSession();
    if (assistantMessageIdRef.current || ttsPlayingRef.current || ttsQueueRef.current.length > 0) cancel();
    setHistoryError("");
    const conversation = await createConversation(apiBaseUrl, authSession.accessToken, "新会话");
    setSessionMessages((store) => ({ ...store, [conversation.id]: createStarterMessages() }));
    setSessions((current) => [conversationToSession(conversation), ...current]);
    setCurrentSessionId(conversation.id);
    setPartial("");
    setManualText("");
    setCost(emptyCost);
    setActiveView("chat");
  }, [apiBaseUrl, authSession?.accessToken, cancel, stopSession]);

  const selectConversation = useCallback(
    async (id: string) => {
      if (id === currentSessionId) return;
      if (runningRef.current) await stopSession();
      if (assistantMessageIdRef.current || ttsPlayingRef.current || ttsQueueRef.current.length > 0) cancel();
      setHistoryError("");
      if (!sessionMessages[id]) await loadConversation(id);
      setCurrentSessionId(id);
      setPartial("");
      setManualText("");
      setActiveView("chat");
    },
    [cancel, currentSessionId, loadConversation, sessionMessages, stopSession],
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
    setAuthSession(null);
    storeAuth(null);
    setAuthError("");
  }, [stopSession]);

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
    <main className="h-screen overflow-hidden bg-slate-50 text-slate-950">
      <div
        className={cx(
          "grid h-screen min-h-0 max-lg:grid-cols-1",
          historyCollapsed
            ? "grid-cols-[72px_58px_1fr] max-xl:grid-cols-[68px_54px_1fr]"
            : "grid-cols-[72px_260px_1fr] max-xl:grid-cols-[68px_220px_1fr]",
        )}
      >
        <IconSidebar activeView={activeView} setActiveView={setActiveView} />
        <HistoryRail
          busySessionId={historyBusySessionId}
          collapsed={historyCollapsed}
          currentSessionId={currentSessionId}
          error={historyError}
          onDeleteSession={deleteSession}
          onNewSession={startNewConversation}
          onRenameSession={renameSession}
          onSelectSession={selectConversation}
          onToggle={() => setHistoryCollapsed((current) => !current)}
          sessions={historySessions}
        />

        <section className="flex min-h-0 min-w-0 flex-col border-l border-slate-200 bg-white">
          <TopBar
            activeView={activeView}
            connectionState={connectionState}
            gatewayReady={gatewayReady}
            mediaState={mediaState}
            startSession={startSession}
            stopSession={stopSession}
          />

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6 pb-4 max-lg:px-4">
            {permissionNeedsAction && (
              <PermissionBanner permissionStatus={permissionStatus} startSession={startSession} />
            )}
            {lastError && (
              <div className="mb-4 flex items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-800">
                <WifiOff size={17} /> {lastError}
              </div>
            )}

            {activeView === "chat" && (
              <ChatView
                aiState={aiState}
                canSend={canSend}
                captureFrame={captureFrame}
                handleComposerAction={handleComposerAction}
                isProcessing={isProcessing}
                level={level}
                manualText={manualText}
                messages={messages}
                partial={partial}
                setManualText={setManualText}
                sendManual={sendManual}
                videoRef={videoRef}
                canvasRef={canvasRef}
                sampleRef={sampleRef}
                videoPanePercent={videoPanePercent}
                setVideoPanePercent={setVideoPanePercent}
              />
            )}
            {activeView === "cost" && (
              <CostStation cost={cost} connectionState={connectionState} permissionStatus={permissionStatus} asrStatus={asrStatus} realtimeAudio={realtimeAudio} />
            )}
            {activeView === "settings" && (
              <SettingsView
                gatewayUrl={gatewayUrl}
                permissionStatus={permissionStatus}
                asrStatus={asrStatus}
                selectedVoice={selectedVoice}
                setSelectedVoice={updateVoice}
                user={authSession.user}
                onLogout={logout}
              />
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

function IconSidebar({ activeView, setActiveView }: { activeView: AppView; setActiveView: (view: AppView) => void }) {
  const items = [
    { view: "chat" as const, icon: Radio, label: "实时对话" },
    { view: "cost" as const, icon: BarChart3, label: "模型消耗" },
    { view: "settings" as const, icon: Settings, label: "用户设置" },
  ];
  return (
    <aside className="flex flex-col items-center gap-6 border-r border-slate-200 bg-slate-950 px-3 py-5 text-white max-lg:hidden">
      <div className="grid h-11 w-11 place-items-center rounded-2xl bg-cyan-400 text-sm font-black text-slate-950 shadow-soft">AI</div>
      <nav className="flex flex-col gap-3">
        {items.map(({ view, icon: Icon, label }) => (
          <button
            key={view}
            className={cx(
              "grid h-11 w-11 place-items-center rounded-2xl transition",
              activeView === view ? "bg-white text-slate-950" : "text-slate-400 hover:bg-white/10 hover:text-white",
            )}
            onClick={() => setActiveView(view)}
            title={label}
          >
            <Icon size={20} />
          </button>
        ))}
      </nav>
    </aside>
  );
}

function HistoryRail({
  busySessionId,
  collapsed,
  currentSessionId,
  error,
  onDeleteSession,
  onNewSession,
  onRenameSession,
  onSelectSession,
  onToggle,
  sessions,
}: {
  busySessionId: string | null;
  collapsed: boolean;
  currentSessionId: string;
  error: string;
  onDeleteSession: (id: string) => Promise<void>;
  onNewSession: () => Promise<void>;
  onRenameSession: (id: string, title: string) => Promise<void>;
  onSelectSession: (id: string) => Promise<void>;
  onToggle: () => void;
  sessions: SessionListItem[];
}) {
  if (collapsed) {
    return (
      <aside className="flex flex-col items-center gap-3 border-r border-slate-200 bg-slate-100/80 py-4 max-lg:hidden">
        <button
          className="grid h-10 w-10 place-items-center rounded-2xl bg-white text-slate-700 shadow-sm hover:bg-slate-50"
          onClick={onToggle}
          title="展开历史记录"
        >
          <PanelLeftOpen size={18} />
        </button>
        <button
          className="grid h-10 w-10 place-items-center rounded-2xl bg-white text-slate-700 shadow-sm hover:bg-slate-50"
          onClick={() => void onNewSession()}
          title="新会话"
        >
          <Plus size={18} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="border-r border-slate-200 bg-slate-100/80 p-4 max-lg:hidden">
      <div className="mb-5 flex gap-2">
        <button className="flex h-11 flex-1 items-center gap-2 rounded-2xl bg-white px-4 text-sm font-bold text-slate-800 shadow-sm" onClick={() => void onNewSession()}>
          <Plus size={17} /> 新会话
        </button>
        <button className="grid h-11 w-11 place-items-center rounded-2xl bg-white text-slate-600 shadow-sm hover:bg-slate-50" onClick={onToggle} title="收起历史记录">
          <PanelLeftClose size={18} />
        </button>
      </div>
      <div className="mb-3 flex items-center gap-2 text-xs font-black uppercase tracking-wide text-slate-500">
        <History size={15} /> 历史记录
      </div>
      {error && <p className="mb-3 rounded-2xl bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{error}</p>}
      <div className="space-y-2">
        {sessions.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-500">暂无会话历史</p>
        ) : (
          sessions.map((session) => (
            <HistorySessionItem
              key={session.id}
              active={session.id === currentSessionId}
              busy={busySessionId === session.id}
              onDeleteSession={onDeleteSession}
              onRenameSession={onRenameSession}
              onSelectSession={onSelectSession}
              session={session}
            />
          ))
        )}
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
        "rounded-2xl px-3 py-3 transition",
        active ? "bg-white text-slate-950 shadow-sm" : "text-slate-600 hover:bg-white",
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
            <span className="mt-1 block text-xs font-semibold text-slate-400">
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

function TopBar({
  activeView,
  connectionState,
  gatewayReady,
  mediaState,
  startSession,
  stopSession,
}: {
  activeView: AppView;
  connectionState: string;
  gatewayReady: boolean;
  mediaState: string;
  startSession: () => Promise<void>;
  stopSession: () => Promise<void>;
}) {
  const gatewayLabel = gatewayReady ? "Gateway 已就绪" : connectionState === "open" ? "Gateway 待授权" : "Gateway 未连接";
  return (
    <header className="flex min-h-16 items-center justify-between gap-4 border-b border-slate-200 px-7 py-3 max-md:flex-col max-md:items-start max-md:px-4">
      <div>
        <h1 className="text-xl font-black tracking-tight">
          {activeView === "chat" ? "AI 视觉对话助手" : activeView === "cost" ? "模型消耗中转站" : "用户设置"}
        </h1>
        <p className="mt-0.5 text-xs font-semibold text-slate-500">Tailwind UI · WebSocket Gateway · Pipecat-ready Pipeline · 视觉关键帧</p>
      </div>
      <div className="flex items-center gap-3">
        <StatusPill label={gatewayLabel} active={gatewayReady} />
        {mediaState !== "running" ? (
          <button className="inline-flex h-10 items-center gap-2 rounded-2xl bg-emerald-700 px-5 text-sm font-bold text-white hover:bg-emerald-800" onClick={() => void startSession()}>
            <Play size={18} /> 启动会话
          </button>
        ) : (
          <button className="inline-flex h-10 items-center gap-2 rounded-2xl bg-rose-600 px-5 text-sm font-bold text-white hover:bg-rose-700" onClick={() => void stopSession()}>
            <CircleStop size={18} /> 停止
          </button>
        )}
      </div>
    </header>
  );
}

function PermissionBanner({ permissionStatus, startSession }: { permissionStatus: string; startSession: () => Promise<void> }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-4 rounded-3xl border border-amber-200 bg-amber-50 px-5 py-4 text-amber-950 shadow-sm max-md:flex-col max-md:items-start">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-2xl bg-amber-200">
          <Shield size={20} />
        </div>
        <div>
          <strong className="block text-sm">需要摄像头与麦克风权限</strong>
          <span className="text-sm text-amber-800">{permissionStatus}。点击请求后浏览器会弹出权限提示。</span>
        </div>
      </div>
      <button className="rounded-2xl bg-amber-900 px-4 py-2 text-sm font-bold text-white" onClick={() => void startSession()}>
        请求权限
      </button>
    </div>
  );
}

function ChatView(props: {
  aiState: AiState;
  canSend: boolean;
  captureFrame: (reason: string, force?: boolean) => Promise<boolean>;
  handleComposerAction: () => void;
  isProcessing: boolean;
  level: number;
  manualText: string;
  messages: ChatMessage[];
  partial: string;
  setManualText: (text: string) => void;
  sendManual: () => Promise<void>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  sampleRef: React.RefObject<HTMLCanvasElement | null>;
  videoPanePercent: number;
  setVideoPanePercent: (value: number) => void;
}) {
  const {
    aiState,
    canSend,
    captureFrame,
    handleComposerAction,
    isProcessing,
    level,
    manualText,
    messages,
    partial,
    setManualText,
    sendManual,
    videoRef,
    canvasRef,
    sampleRef,
    videoPanePercent,
    setVideoPanePercent,
  } = props;
  const messageScrollerRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = messageScrollerRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
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
      <div className="min-h-0 min-w-0">
        <div className="relative aspect-[4/3] overflow-hidden rounded-3xl border border-slate-200 bg-slate-900 shadow-soft">
          <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
          <canvas ref={canvasRef} hidden />
          <canvas ref={sampleRef} hidden />
          <AiStatusIndicator state={aiState} />
          <div className="absolute inset-x-4 bottom-4 flex items-center justify-between gap-3">
            <span className="inline-flex h-10 items-center gap-2 rounded-2xl bg-slate-950/70 px-4 text-sm font-bold text-white backdrop-blur">
              <Camera size={16} /> 关键帧模式
            </span>
            <button className="inline-flex h-10 items-center gap-2 rounded-2xl bg-white/90 px-4 text-sm font-bold text-slate-800" onClick={() => void captureFrame("manual", true)}>
              <Eye size={16} /> 抓取画面
            </button>
          </div>
        </div>
      </div>

      <button
        className="hidden cursor-col-resize rounded-full bg-slate-200 transition hover:bg-slate-300 xl:block"
        onPointerDown={beginPaneResize}
        title="拖拽调整视频和对话宽度"
      />

      <div className="flex min-h-0 min-w-0 flex-col rounded-3xl border border-slate-200 bg-white shadow-soft">
        <div className="flex min-h-16 items-center justify-between border-b border-slate-200 px-5">
          <div className="flex items-center gap-2 font-black"><Radio size={18} /> 实时对话</div>
          {partial && <div className="max-w-[52%] truncate rounded-full bg-cyan-50 px-3 py-1 text-sm font-bold text-cyan-700">正在听：{partial}</div>}
        </div>
        <div ref={messageScrollerRef} className="flex-1 space-y-5 overflow-auto px-6 py-6">
          {messages.map((message) => {
            if (message.role === "assistant" && !message.text.trim()) return null;
            if (message.role === "system") return null;
            return <MessageBubble key={message.id} message={message} />;
          })}
        </div>
        <Composer
          canSend={canSend}
          handleComposerAction={handleComposerAction}
          isProcessing={isProcessing}
          level={level}
          manualText={manualText}
          sendManual={sendManual}
          setManualText={setManualText}
        />
      </div>
    </section>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <article className={cx("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cx(
          "max-w-[78%] rounded-[1.35rem] px-5 py-4 shadow-sm",
          isUser && "bg-slate-950 text-white",
          message.role === "assistant" && "bg-white text-slate-900 ring-1 ring-slate-200",
        )}
      >
        <span className={cx("mb-2 block text-xs font-black uppercase tracking-wide", isUser ? "text-white/60" : "text-slate-400")}>
          {message.role === "assistant" ? "AI" : message.role === "user" ? "你" : "系统"}
        </span>
        <p className="whitespace-pre-wrap break-words leading-7">
          {message.text}
          {message.streaming && message.text ? <span className="ml-1 animate-pulse">▌</span> : null}
        </p>
      </div>
    </article>
  );
}

function Composer({
  canSend,
  handleComposerAction,
  isProcessing,
  level,
  manualText,
  sendManual,
  setManualText,
}: {
  canSend: boolean;
  handleComposerAction: () => void;
  isProcessing: boolean;
  level: number;
  manualText: string;
  sendManual: () => Promise<void>;
  setManualText: (text: string) => void;
}) {
  return (
    <div className="border-t border-slate-200 p-4">
      <div className="rounded-[2rem] border border-slate-200 bg-white p-3 shadow-soft">
        <textarea
          className="min-h-16 w-full resize-none border-0 bg-transparent px-3 pt-2 text-base leading-7 text-slate-900 outline-none placeholder:text-slate-400"
          value={manualText}
          onChange={(event) => setManualText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!isProcessing && canSend) void sendManual();
            }
          }}
          placeholder="要求后续变更"
          rows={2}
        />
        <div className="flex items-center gap-3 px-2 pb-1">
          <button className="grid h-10 w-10 place-items-center rounded-full text-slate-500 hover:bg-slate-100"><Plus size={22} /></button>
          <div className="ml-auto flex items-center gap-3">
            <button className="grid h-10 w-10 place-items-center rounded-full text-slate-500 hover:bg-slate-100"><Mic size={21} /></button>
            <button
              className={cx(
                "grid h-12 w-12 place-items-center rounded-full transition",
                isProcessing && "bg-slate-950 text-white hover:bg-slate-800",
                !isProcessing && canSend && "bg-slate-900 text-white hover:bg-slate-700",
                !isProcessing && !canSend && "cursor-not-allowed bg-slate-200 text-slate-400",
              )}
              disabled={!isProcessing && !canSend}
              onClick={handleComposerAction}
              title={isProcessing ? "中断回复" : "发送"}
            >
              {isProcessing ? <Square size={18} /> : <ArrowUp size={23} />}
            </button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-3 rounded-2xl bg-slate-50 px-3 py-2">
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

function CostStation({ cost, connectionState, permissionStatus, asrStatus, realtimeAudio }: { cost: CostSnapshot; connectionState: string; permissionStatus: string; asrStatus: string; realtimeAudio: boolean }) {
  return (
    <section className="space-y-6">
      <div className="rounded-[2rem] bg-slate-950 p-8 text-white shadow-soft">
        <span className="text-sm font-bold text-cyan-300">Gateway & Backend</span>
        <div className="mt-2 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl font-black">模型消耗中转站</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">集中观察 ASR、视觉关键帧、模型 token、TTS 字符和缓存命中。</p>
          </div>
          <strong className="text-6xl font-black">{cost.estimatedUnits}</strong>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Metric label="音频总时长" value={`${cost.audioSeconds}s`} />
        <Metric label="有效语音" value={`${cost.speechSeconds}s`} />
        <Metric label="音频帧" value={cost.audioChunks.toString()} />
        <Metric label="视觉调用" value={cost.visionFrames.toString()} />
        <Metric label="缓存命中" value={cost.visionCacheHits.toString()} />
        <Metric label="输入 token 估算" value={cost.llmInputTokensEst.toString()} />
        <Metric label="输出 token 估算" value={cost.llmOutputTokensEst.toString()} />
        <Metric label="TTS 字符" value={cost.ttsChars.toString()} />
        <Metric label="打断次数" value={cost.interruptions.toString()} />
      </div>
      <div className="grid gap-3 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:grid-cols-2">
        <PipelineItem icon={<Wifi size={16} />} label={`Gateway：${connectionState}`} />
        <PipelineItem icon={<Camera size={16} />} label={`权限：${permissionStatus}`} />
        <PipelineItem icon={<Mic size={16} />} label={`ASR：${asrStatus}`} />
        <PipelineItem icon={<Eye size={16} />} label="Direct Omni/VL" />
        <PipelineItem icon={<Volume2 size={16} />} label={realtimeAudio ? "Qwen Realtime Audio" : "Browser TTS"} />
      </div>
    </section>
  );
}

function SettingsView({
  gatewayUrl,
  permissionStatus,
  asrStatus,
  selectedVoice,
  setSelectedVoice,
  user,
  onLogout,
}: {
  gatewayUrl: string;
  permissionStatus: string;
  asrStatus: string;
  selectedVoice: RealtimeVoice;
  setSelectedVoice: (voice: RealtimeVoice) => void;
  user: AuthSession["user"];
  onLogout: () => Promise<void>;
}) {
  return (
    <section className="max-w-3xl rounded-[2rem] border border-slate-200 bg-white p-7 shadow-soft">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black">用户设置</h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">当前账号：{user.username}</p>
        </div>
        <button className="rounded-2xl bg-slate-950 px-4 py-2 text-sm font-bold text-white" onClick={() => void onLogout()}>
          退出登录
        </button>
      </div>
      <div className="mt-6 grid gap-4">
        <ReadonlyField label="用户 ID" value={user.id} />
        <ReadonlyField label="Gateway 地址" value={gatewayUrl} />
        <ReadonlyField label="权限状态" value={permissionStatus} />
        <ReadonlyField label="语音识别" value={asrStatus} />
        <div className="rounded-2xl bg-slate-50 px-4 py-3">
          <span className="text-xs font-black text-slate-400">Realtime 音色</span>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {realtimeVoices.map((voice) => (
              <button
                key={voice}
                className={cx(
                  "h-10 rounded-2xl text-sm font-black transition",
                  selectedVoice === voice ? "bg-slate-950 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100",
                )}
                onClick={() => setSelectedVoice(voice)}
                type="button"
              >
                {voice}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs font-semibold text-slate-500">音色会保存到本机，并在会话启动或切换时同步给 Realtime Gateway。</p>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <span className="text-sm font-bold text-slate-500">{label}</span>
      <strong className="mt-3 block text-3xl font-black text-slate-950">{value}</strong>
    </div>
  );
}

function PipelineItem({ icon, label }: { icon: React.ReactNode; label: string }) {
  return <div className="flex min-h-12 items-center gap-3 rounded-2xl bg-slate-100 px-4 text-sm font-black text-slate-700">{icon}{label}</div>;
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <label className="grid gap-2 text-sm font-bold text-slate-600">
      {label}
      <input className="h-12 rounded-2xl border border-slate-200 bg-slate-50 px-4 font-semibold text-slate-900 outline-none" value={value} readOnly />
    </label>
  );
}

function StatusPill({ label, active }: { label: string; active: boolean }) {
  return <span className={cx("rounded-full px-4 py-2 text-sm font-black", active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500")}>{label}</span>;
}
