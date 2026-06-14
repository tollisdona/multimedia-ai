from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Optional, Protocol

from .models import FrameSnapshot, SessionState


EmitEvent = Callable[[str, Any], Awaitable[None]]
RequestFrame = Callable[[str, str, str, bool, float], Awaitable[Optional[FrameSnapshot]]]


class OcrProvider(Protocol):
    async def recognize(self, frame: FrameSnapshot) -> Any:
        ...


@dataclass
class AgentContext:
    session: SessionState
    emit: EmitEvent | None
    request_frame: RequestFrame | None
    ocr_provider: OcrProvider


@dataclass(frozen=True)
class PipelineEvent:
    type: str
    payload: dict[str, Any]


class AgentRunner(Protocol):
    name: str

    async def run(self, user_text: str) -> Any:
        ...


@dataclass(frozen=True)
class AgentSpec:
    name: str
    runner_factory: Callable[[AgentContext], AgentRunner]


class AgentRouter:
    def __init__(self, specs: list[AgentSpec]) -> None:
        self.specs = specs

    def by_name(self, name: str) -> AgentSpec | None:
        for spec in self.specs:
            if spec.name == name:
                return spec
        return None
