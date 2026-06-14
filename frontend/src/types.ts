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
  llmInputTokens?: number;
  llmOutputTokens?: number;
  llmInputTokensEst: number;
  llmOutputTokensEst: number;
  ttsChars: number;
  ttsAudioSeconds?: number;
  interruptions: number;
  estimatedUnits: number;
}

export interface VadSnapshot {
  rms: number;
  noiseFloor: number;
  isSpeech: boolean;
  speechStart: boolean;
  speechEnd: boolean;
}

export type GatewayEvent =
  | { type: "session.ready"; sessionId: string; capabilities: Record<string, unknown> }
  | { type: "session.started"; sessionId: string }
  | { type: "asr.partial"; text: string }
  | { type: "asr.final"; text: string }
  | { type: "vision.frame.cached"; reason: string; frameHash: string; reused: boolean; bufferedFrames: number }
  | { type: "vision.frames.cleared"; reason: string; bufferedFrames: number }
  | { type: "llm.delta"; delta: string }
  | { type: "llm.done"; cancelled: boolean }
  | { type: "response.text.delta"; delta: string }
  | { type: "response.audio.delta"; audio: string; encoding: "pcm16"; sampleRate: number }
  | { type: "response.audio.done" }
  | { type: "tts.audio.chunk"; mode: "browser-speech"; text: string }
  | { type: "speech.cancelled"; reason: string }
  | { type: "voice.updated"; voice: string; provider: string }
  | { type: "session.cost"; cost: CostSnapshot }
  | { type: "error"; code: string; message: string };
