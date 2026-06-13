export type Role = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  streaming?: boolean;
}

export interface CostSnapshot {
  audioSeconds: number;
  speechSeconds: number;
  audioChunks: number;
  visionFrames: number;
  visionCacheHits: number;
  llmInputTokensEst: number;
  llmOutputTokensEst: number;
  ttsChars: number;
  interruptions: number;
  estimatedUnits: number;
}

export type GatewayEvent =
  | { type: "session.ready"; sessionId: string; capabilities: Record<string, unknown> }
  | { type: "session.started"; sessionId: string }
  | { type: "asr.partial"; text: string }
  | { type: "asr.final"; text: string }
  | { type: "vision.frame.cached"; reason: string; frameHash: string; reused: boolean; bufferedFrames: number }
  | { type: "llm.delta"; delta: string }
  | { type: "llm.done"; cancelled: boolean }
  | { type: "tts.audio.chunk"; mode: "browser-speech"; text: string }
  | { type: "speech.cancelled"; reason: string }
  | { type: "session.cost"; cost: CostSnapshot }
  | { type: "error"; code: string; message: string };
