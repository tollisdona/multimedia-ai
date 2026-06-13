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
    llm_input_tokens_est: int = 0
    llm_output_tokens_est: int = 0
    tts_chars: int = 0
    interruptions: int = 0

    def snapshot(self) -> dict[str, Any]:
        return {
            "audioSeconds": round(self.audio_ms / 1000, 1),
            "speechSeconds": round(self.speech_ms / 1000, 1),
            "audioChunks": self.audio_chunks,
            "visionFrames": self.vision_frames,
            "visionCacheHits": self.vision_cache_hits,
            "llmInputTokensEst": self.llm_input_tokens_est,
            "llmOutputTokensEst": self.llm_output_tokens_est,
            "ttsChars": self.tts_chars,
            "interruptions": self.interruptions,
            "estimatedUnits": round(
                self.speech_ms / 60000 * 1.0
                + self.vision_frames * 4.0
                + (self.llm_input_tokens_est + self.llm_output_tokens_est) / 1000 * 1.0
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
    created_at: int = field(default_factory=now_ms)
    latest_transcript: str = ""
    recent_frames: list[FrameSnapshot] = field(default_factory=list)
    history: list[dict[str, str]] = field(default_factory=list)
    cost: CostState = field(default_factory=CostState)
    cancelled_generation: bool = False
