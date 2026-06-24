import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import {
  Activity,
  ArrowUp,
  Camera,
  Check,
  Copy,
  Eye,
  FileText,
  Mic,
  Radio,
  Square,
  ThumbsDown,
  ThumbsUp,
  Volume2,
} from "lucide-react";
import type { ChatMessage } from "../../types";

type AiState = "idle" | "listening" | "processing" | "speaking";
type MediaAction = "start" | "stop" | null;
type DeviceStatus = "idle" | "requesting" | "active" | "blocked" | "error";

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
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

export function ChatView(props: {
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
  sendRealtimeVisualPrompt: (text: string) => Promise<boolean>;
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
    sendRealtimeVisualPrompt,
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
        <div className="relative aspect-video overflow-hidden rounded-3xl border border-slate-200 bg-slate-900 shadow-soft">
          <video ref={videoRef} playsInline muted className="h-full w-full object-contain" />
          <canvas ref={canvasRef} hidden />
          <canvas ref={sampleRef} hidden />
          <AiStatusIndicator state={aiState} />
          <CameraStatusDot status={cameraStatus} />
        </div>
        <VisionQuickPrompts onSelectPrompt={(prompt) => void sendRealtimeVisualPrompt(prompt)} />
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
    onReplayAudio(message);
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
              title="播放模型音频"
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
