from __future__ import annotations

from dataclasses import dataclass, field
from time import time
from typing import Any
from uuid import uuid4


def now_ms() -> int:
    return int(time() * 1000)


def event(event_type: str, **payload: Any) -> dict[str, Any]:
    return {"type": event_type, "ts": now_ms(), **payload}


@dataclass
class CostState:
    audio_ms: int = 0
    speech_ms: int = 0
    audio_chunks: int = 0
    vision_frames: int = 0
    vision_cache_hits: int = 0
    llm_input_tokens: int = 0
    llm_output_tokens: int = 0
    llm_input_tokens_est: int = 0
    llm_output_tokens_est: int = 0
    tts_chars: int = 0
    tts_audio_ms: int = 0
    interruptions: int = 0
    pending_audio_ms: int = 0
    pending_speech_ms: int = 0
    pending_audio_chunks: int = 0

    def billable_input_tokens(self) -> int:
        return self.llm_input_tokens or self.llm_input_tokens_est

    def billable_output_tokens(self) -> int:
        return self.llm_output_tokens or self.llm_output_tokens_est

    def record_audio_chunk(self, duration_ms: int, is_speech: bool) -> None:
        safe_duration = max(0, min(duration_ms, 200))
        self.audio_chunks += 1
        self.audio_ms += safe_duration
        self.pending_audio_ms += safe_duration
        self.pending_audio_chunks += 1
        if is_speech:
            self.speech_ms += safe_duration
            self.pending_speech_ms += safe_duration

    def consume_pending_audio_usage(self) -> dict[str, int]:
        usage = {
            "audio_ms": self.pending_audio_ms,
            "speech_ms": self.pending_speech_ms,
            "audio_chunks": self.pending_audio_chunks,
        }
        self.pending_audio_ms = 0
        self.pending_speech_ms = 0
        self.pending_audio_chunks = 0
        return usage

    def snapshot(self) -> dict[str, Any]:
        input_tokens = self.billable_input_tokens()
        output_tokens = self.billable_output_tokens()
        return {
            "audioSeconds": round(self.audio_ms / 1000, 1),
            "speechSeconds": round(self.speech_ms / 1000, 1),
            "audioChunks": self.audio_chunks,
            "visionFrames": self.vision_frames,
            "visionCacheHits": self.vision_cache_hits,
            "llmInputTokens": self.llm_input_tokens,
            "llmOutputTokens": self.llm_output_tokens,
            "llmInputTokensEst": self.llm_input_tokens_est,
            "llmOutputTokensEst": self.llm_output_tokens_est,
            "ttsChars": self.tts_chars,
            "ttsAudioSeconds": round(self.tts_audio_ms / 1000, 1),
            "interruptions": self.interruptions,
            "estimatedUnits": round(
                self.speech_ms / 60000 * 1.0
                + self.vision_frames * 4.0
                + (input_tokens + output_tokens) / 1000 * 1.0
                + self.tts_chars / 1000 * 0.3,
                2,
            ),
        }


@dataclass
class FrameSnapshot:
    data_url: str
    reason: str
    frame_hash: str
    captured_at: int


@dataclass
class SessionState:
    session_id: str = field(default_factory=lambda: str(uuid4()))
    user_id: str = ""
    conversation_id: str = ""
    model_config: Any | None = None
    created_at: int = field(default_factory=now_ms)
    latest_transcript: str = ""
    recent_frames: list[FrameSnapshot] = field(default_factory=list)
    history: list[dict[str, str]] = field(default_factory=list)
    cost: CostState = field(default_factory=CostState)
    cancelled_generation: bool = False
    active_agent: str = ""
    agent_state: str = "idle"
    agent_context: dict[str, Any] = field(default_factory=dict)
    agent_followup_until: int = 0
    agent_turns_remaining: int = 0
