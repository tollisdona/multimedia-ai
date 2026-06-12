import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Camera,
  CircleStop,
  Eye,
  Mic,
  Play,
  Radio,
  Send,
  Sparkles,
  Volume2,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { AudioCapture } from "./lib/audioCapture";
import { GatewayClient } from "./lib/wsClient";
import type { ChatMessage, CostSnapshot, GatewayEvent, VisionSummary } from "./types";

const visualKeywords = ["看", "看到", "这个", "那个", "画面", "颜色", "桌", "手里", "旁边", "前面", "物体", "摄像头"];

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

const initialVision: VisionSummary = {
  summary: "等待第一帧关键画面。",
  objects: [],
  textSeen: "",
  confidence: 0,
  source: "none",
  reason: "none",
};

function uid() {
  return crypto.randomUUID();
}

function containsVisualIntent(text: string) {
  return visualKeywords.some((keyword) => text.includes(keyword));
}

export function App() {
  const gatewayUrl = import.meta.env.VITE_GATEWAY_URL ?? "ws://localhost:8000/ws";
  const client = useMemo(() => new GatewayClient(gatewayUrl), [gatewayUrl]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sampleRef = useRef<HTMLCanvasElement | null>(null);
  const audioCaptureRef = useRef<AudioCapture | null>(null);
  const recognitionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const assistantMessageIdRef = useRef<string | null>(null);
  const ttsQueueRef = useRef<string[]>([]);
  const ttsPlayingRef = useRef(false);
  const lastSampleRef = useRef<Uint8ClampedArray | null>(null);
  const lastVisionAtRef = useRef(0);
  const runningRef = useRef(false);

  const [connectionState, setConnectionState] = useState("closed");
  const [mediaState, setMediaState] = useState("idle");
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: uid(),
      role: "system",
      text: "混合流式助手已就绪：音频全流式、文本流式、视觉关键帧准实时。",
    },
  ]);
  const [vision, setVision] = useState<VisionSummary>(initialVision);
  const [cost, setCost] = useState<CostSnapshot>(emptyCost);
  const [manualText, setManualText] = useState("");
  const [lastError, setLastError] = useState("");

  const appendMessage = useCallback((message: ChatMessage) => {
    setMessages((current) => [...current.slice(-30), message]);
  }, []);

  const updateAssistantDelta = useCallback((delta: string) => {
    setMessages((current) => {
      let id = assistantMessageIdRef.current;
      if (!id) {
        id = uid();
        assistantMessageIdRef.current = id;
        return [...current, { id, role: "assistant", text: delta, streaming: true }];
      }
      return current.map((message) =>
        message.id === id ? { ...message, text: message.text + delta, streaming: true } : message,
      );
    });
  }, []);

  const finishAssistant = useCallback((cancelled: boolean) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === assistantMessageIdRef.current
          ? { ...message, text: cancelled ? `${message.text}\n[已中断]` : message.text, streaming: false }
          : message,
      ),
    );
    assistantMessageIdRef.current = null;
  }, []);

  const processTtsQueue = useCallback(() => {
    if (ttsPlayingRef.current) return;
    const next = ttsQueueRef.current.shift();
    if (!next || !("speechSynthesis" in window)) return;
    ttsPlayingRef.current = true;
    const utterance = new SpeechSynthesisUtterance(next);
    utterance.lang = "zh-CN";
    utterance.rate = 1.04;
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
  }, []);

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
    window.speechSynthesis?.cancel();
  }, []);

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
    for (let i = 0; i < data.length; i += 16) {
      diff += Math.abs(data[i] - previous[i]);
    }
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
      if (containsVisualIntent(clean)) {
        await captureFrame("semantic", true);
      }
      client.send("browser.asr.final", { text: clean });
    },
    [captureFrame, client],
  );

  const handleGatewayEvent = useCallback(
    (event: GatewayEvent) => {
      if (event.type === "session.ready") {
        setConnectionState("open");
      }
      if (event.type === "asr.partial") {
        setPartial(event.text);
      }
      if (event.type === "asr.final") {
        setPartial("");
        appendMessage({ id: uid(), role: "user", text: event.text });
      }
      if (event.type === "vision.summary") {
        setVision({
          summary: event.summary,
          objects: event.objects,
          textSeen: event.textSeen,
          confidence: event.confidence,
          source: event.source,
          reason: event.reason,
        });
      }
      if (event.type === "llm.delta") {
        updateAssistantDelta(event.delta);
      }
      if (event.type === "tts.audio.chunk") {
        enqueueSpeech(event.text);
      }
      if (event.type === "llm.done") {
        finishAssistant(event.cancelled);
      }
      if (event.type === "speech.cancelled") {
        stopSpeech();
        finishAssistant(true);
      }
      if (event.type === "session.cost") {
        setCost(event.cost);
      }
      if (event.type === "error") {
        setLastError(`${event.code}: ${event.message}`);
      }
    },
    [appendMessage, enqueueSpeech, finishAssistant, stopSpeech, updateAssistantDelta],
  );

  useEffect(() => client.on(handleGatewayEvent), [client, handleGatewayEvent]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (runningRef.current) void captureFrame("periodic");
      setConnectionState(client.state);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [captureFrame, client]);

  const startSpeechRecognition = useCallback(() => {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      setLastError("当前浏览器不支持 Web Speech API，可使用右下角文本输入兜底。");
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event: any) => {
      let interim = "";
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += transcript;
        else interim += transcript;
      }
      if (interim.trim()) client.send("browser.asr.partial", { text: interim.trim() });
      if (finalText.trim()) void sendFinalTranscript(finalText.trim());
    };
    recognition.onerror = (event: any) => {
      setLastError(`语音识别错误：${event.error ?? "unknown"}`);
    };
    recognition.onend = () => {
      if (runningRef.current) {
        try {
          recognition.start();
        } catch {
          // Browser may throttle immediate restarts.
        }
      }
    };
    recognitionRef.current = recognition;
    recognition.start();
  }, [client, sendFinalTranscript]);

  const startSession = useCallback(async () => {
    try {
      setLastError("");
      setConnectionState("connecting");
      client.connect();
      await client.waitOpen();
      client.send("session.start");

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const audioCapture = new AudioCapture(
        client,
        setLevel,
        () => Boolean(assistantMessageIdRef.current || ttsPlayingRef.current || ttsQueueRef.current.length),
      );
      await audioCapture.start(stream);
      audioCaptureRef.current = audioCapture;
      runningRef.current = true;
      setMediaState("running");
      startSpeechRecognition();
      await captureFrame("startup", true);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
      setMediaState("error");
      setConnectionState(client.state);
    }
  }, [captureFrame, client, startSpeechRecognition]);

  const stopSession = useCallback(async () => {
    runningRef.current = false;
    stopSpeech();
    recognitionRef.current?.stop?.();
    await audioCaptureRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    audioCaptureRef.current = null;
    client.close();
    setMediaState("stopped");
    setConnectionState("closed");
  }, [client, stopSpeech]);

  const sendManual = useCallback(async () => {
    const text = manualText.trim();
    if (!text) return;
    setManualText("");
    await sendFinalTranscript(text);
  }, [manualText, sendFinalTranscript]);

  const cancel = useCallback(() => {
    client.send("speech.cancel", { reason: "manual" });
    stopSpeech();
  }, [client, stopSpeech]);

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <h1>AI 视觉对话助手</h1>
          <p>自建 WebSocket Gateway · 音频流式 · 视觉关键帧 · 成本可控</p>
        </div>
        <div className="topbar-actions">
          <StatusPill label={connectionState === "open" ? "Gateway 已连接" : "Gateway 未连接"} active={connectionState === "open"} />
          {mediaState !== "running" ? (
            <button className="primary" onClick={() => void startSession()}>
              <Play size={18} /> 启动会话
            </button>
          ) : (
            <button className="danger" onClick={() => void stopSession()}>
              <CircleStop size={18} /> 停止
            </button>
          )}
        </div>
      </section>

      <section className="workspace">
        <div className="left-pane">
          <div className="video-panel">
            <video ref={videoRef} playsInline muted />
            <canvas ref={canvasRef} hidden />
            <canvas ref={sampleRef} hidden />
            <div className="video-overlay">
              <span><Camera size={16} /> 关键帧模式</span>
              <button onClick={() => void captureFrame("manual", true)}>
                <Eye size={16} /> 抓取画面
              </button>
            </div>
          </div>

          <div className="meter-row">
            <div className="meter-card">
              <Mic size={18} />
              <div>
                <strong>麦克风流</strong>
                <div className="meter"><span style={{ width: `${Math.min(level * 900, 100)}%` }} /></div>
              </div>
            </div>
            <button className="secondary" onClick={cancel}>
              <Zap size={17} /> 打断
            </button>
          </div>

          <div className="vision-card">
            <div className="section-title"><Sparkles size={18} /> 最新视觉摘要</div>
            <p>{vision.summary}</p>
            <div className="tag-row">
              <span>来源：{vision.source}</span>
              <span>触发：{vision.reason}</span>
              <span>置信度：{Math.round(vision.confidence * 100)}%</span>
            </div>
            {vision.objects.length > 0 && <div className="chips">{vision.objects.map((item) => <b key={item}>{item}</b>)}</div>}
          </div>
        </div>

        <div className="center-pane">
          <div className="chat-header">
            <div className="section-title"><Radio size={18} /> 实时对话</div>
            {partial && <div className="partial">正在听：{partial}</div>}
          </div>
          <div className="messages">
            {messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <span>{message.role === "assistant" ? "AI" : message.role === "user" ? "你" : "系统"}</span>
                <p>{message.text}{message.streaming ? " ▌" : ""}</p>
              </article>
            ))}
          </div>
          <div className="manual-input">
            <input
              value={manualText}
              onChange={(event) => setManualText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void sendManual();
              }}
              placeholder="语音识别不可用时，在这里输入一句话..."
            />
            <button onClick={() => void sendManual()}>
              <Send size={17} /> 发送
            </button>
          </div>
        </div>

        <aside className="right-pane">
          <div className="section-title"><Activity size={18} /> 成本面板</div>
          <CostItem label="音频总时长" value={`${cost.audioSeconds}s`} />
          <CostItem label="有效语音" value={`${cost.speechSeconds}s`} />
          <CostItem label="音频帧" value={cost.audioChunks.toString()} />
          <CostItem label="视觉调用" value={cost.visionFrames.toString()} />
          <CostItem label="缓存命中" value={cost.visionCacheHits.toString()} />
          <CostItem label="输入 token 估算" value={cost.llmInputTokensEst.toString()} />
          <CostItem label="输出 token 估算" value={cost.llmOutputTokensEst.toString()} />
          <CostItem label="TTS 字符" value={cost.ttsChars.toString()} />
          <CostItem label="打断次数" value={cost.interruptions.toString()} />
          <div className="cost-total">
            <span>估算成本单位</span>
            <strong>{cost.estimatedUnits}</strong>
          </div>

          <div className="pipeline">
            <div><Wifi size={16} /> WebSocket Gateway</div>
            <div><Mic size={16} /> Browser ASR fallback</div>
            <div><Eye size={16} /> Keyframe VL</div>
            <div><Volume2 size={16} /> Browser TTS</div>
          </div>
          {lastError && <div className="error"><WifiOff size={16} /> {lastError}</div>}
        </aside>
      </section>
    </main>
  );
}

function StatusPill({ label, active }: { label: string; active: boolean }) {
  return <span className={`status-pill ${active ? "active" : ""}`}>{label}</span>;
}

function CostItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="cost-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
