from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .agent_runtime import AgentContext, PipelineEvent
from .ai import direct_model_config, estimate_tokens, extract_stream_usage, sentence_chunks
from .db import enqueue_usage_event
from .medication_intent import MEDICATION_AGENT
from .medication_models import MedicationOcrResult, medication_quality, result_to_agent_context
from .models import FrameSnapshot, now_ms


CAPTURE_INSTRUCTION = "请把药品说明书、药盒或药瓶标签对准镜头，尽量让药名和用法用量清晰可见。"
RETAKE_INSTRUCTION = "我会再等一下，请把药名、用法用量或注意事项区域放到画面中央，尽量避免反光。"
FOLLOWUP_MS = 3 * 60 * 1000
FOLLOWUP_TURNS = 3
MAX_RETAKES = 2
FRAME_WAIT_SECONDS = 12.0


class MedicationInstructionAgent:
    name = MEDICATION_AGENT

    def __init__(self, context: AgentContext) -> None:
        self.context = context
        self.session = context.session

    async def run(self, user_text: str) -> AsyncIterator[PipelineEvent]:
        now = now_ms()
        is_followup_context = self.session.agent_state == "medication.ready_for_followup"
        if self.session.active_agent != self.name and not is_followup_context:
            self.session.active_agent = self.name
            self.session.agent_state = "medication.awaiting_frame"
            self.session.agent_context = {}
            yield PipelineEvent(
                "scene.switched",
                {
                    "scene": self.name,
                    "label": "药品说明书识别",
                    "message": "已切换到「药品说明书识别」。我会先识别画面文字，再基于识别结果回答。",
                },
            )
        elif self.session.active_agent != self.name:
            self.session.active_agent = self.name

        existing = self.current_ocr_result()
        if existing and self.is_followup_active(now):
            async for event in self.answer_from_ocr(user_text, existing):
                yield event
            self.session.agent_turns_remaining = max(0, self.session.agent_turns_remaining - 1)
            self.session.agent_followup_until = now_ms() + FOLLOWUP_MS
            if self.session.agent_turns_remaining <= 0:
                yield self.exit_event("followup_turns_exhausted")
            return

        frame: FrameSnapshot | None = None
        ocr_result: MedicationOcrResult | None = None
        for attempt in range(MAX_RETAKES + 1):
            self.session.agent_state = "medication.awaiting_frame"
            instruction = CAPTURE_INSTRUCTION if attempt == 0 else RETAKE_INSTRUCTION
            yield PipelineEvent(
                "agent.guidance",
                {"agent": self.name, "text": instruction, "speak": True, "attempt": attempt + 1, "maxAttempts": MAX_RETAKES + 1},
            )
            frame = await self.request_frame(instruction)
            if frame is None:
                async for event in self.emit_answer("没有获得清晰画面，我先退出药品说明书识别。你可以打开摄像头后再说“帮我看药品说明书”。"):
                    yield event
                yield self.exit_event("capture_unavailable")
                return

            self.session.agent_state = "medication.ocr_running"
            yield PipelineEvent("ocr.started", {"requestId": frame.frame_hash})
            ocr_result = await self.context.ocr_provider.recognize(frame)
            quality = medication_quality(ocr_result)
            yield PipelineEvent(
                "ocr.result",
                {
                    "textPreview": ocr_result.text_preview(),
                    "confidence": ocr_result.confidence,
                    "accepted": quality.accepted,
                    "provider": ocr_result.provider,
                },
            )
            if quality.accepted:
                if quality.missing:
                    ocr_result.uncertain_parts = [*ocr_result.uncertain_parts, *quality.missing]
                break
            if quality.retryable and attempt < MAX_RETAKES:
                yield PipelineEvent(
                    "ocr.retake.requested",
                    {
                        "requestId": frame.frame_hash,
                        "reason": quality.reason,
                        "instruction": RETAKE_INSTRUCTION,
                        "attempt": attempt + 2,
                        "maxAttempts": MAX_RETAKES + 1,
                    },
                )
                continue
            async for event in self.emit_answer(f"{quality.reason} 我先退出药品说明书识别，请换个光线或手动输入关键文字后再问。"):
                yield event
            yield self.exit_event("ocr_quality_low")
            return

        if ocr_result is None:
            yield self.exit_event("ocr_missing")
            return

        self.session.agent_context["last_ocr"] = result_to_agent_context(ocr_result)
        async for event in self.answer_from_ocr(user_text, ocr_result):
            yield event
        self.refresh_followup()

    async def request_frame(self, instruction: str) -> FrameSnapshot | None:
        if not self.context.request_frame:
            return self.session.recent_frames[-1] if self.session.recent_frames else None
        return await self.context.request_frame(
            self.name,
            "medication-agent",
            instruction,
            False,
            FRAME_WAIT_SECONDS,
        )

    def current_ocr_result(self) -> MedicationOcrResult | None:
        raw = self.session.agent_context.get("last_ocr") if isinstance(self.session.agent_context, dict) else None
        if not isinstance(raw, dict):
            return None
        text = str(raw.get("text", "")).strip()
        if not text:
            return None
        return MedicationOcrResult(
            text=text,
            confidence=raw.get("confidence") if isinstance(raw.get("confidence"), (int, float)) else None,
            blocks=raw.get("blocks") if isinstance(raw.get("blocks"), list) else [],
            provider=str(raw.get("provider", "cached-ocr")),
            image_hash=str(raw.get("image_hash", "")),
            captured_at=int(raw.get("captured_at", now_ms()) or now_ms()),
            uncertain_parts=raw.get("uncertain_parts") if isinstance(raw.get("uncertain_parts"), list) else [],
        )

    def is_followup_active(self, now: int) -> bool:
        return self.session.agent_followup_until >= now and self.session.agent_turns_remaining > 0

    def refresh_followup(self) -> None:
        self.session.active_agent = ""
        self.session.agent_state = "medication.ready_for_followup"
        self.session.agent_followup_until = now_ms() + FOLLOWUP_MS
        self.session.agent_turns_remaining = FOLLOWUP_TURNS

    def exit_event(self, reason: str) -> PipelineEvent:
        self.session.active_agent = ""
        self.session.agent_state = "idle"
        self.session.agent_followup_until = 0
        self.session.agent_turns_remaining = 0
        return PipelineEvent("agent.exited", {"agent": self.name, "reason": reason})

    async def answer_from_ocr(self, user_text: str, ocr_result: MedicationOcrResult) -> AsyncIterator[PipelineEvent]:
        answer = ""
        async for event in self.emit_streamed_answer(user_text, ocr_result):
            if event.type == "llm.delta":
                answer += str(event.payload.get("delta", ""))
            yield event
        if answer.strip():
            self.session.history.append({"role": "assistant", "content": answer.strip()})

    async def emit_streamed_answer(self, user_text: str, ocr_result: MedicationOcrResult) -> AsyncIterator[PipelineEvent]:
        tts_buffer = ""
        async for delta in self.stream_medication_answer(user_text, ocr_result):
            self.session.cost.llm_output_tokens_est += estimate_tokens(delta)
            yield PipelineEvent("llm.delta", {"delta": delta})
            tts_buffer += delta
            chunks, tts_buffer = sentence_chunks(tts_buffer)
            for chunk in chunks:
                self.session.cost.tts_chars += len(chunk)
                yield PipelineEvent("tts.audio.chunk", {"mode": "browser-speech", "text": chunk})
                yield PipelineEvent("session.cost", {"cost": self.session.cost.snapshot()})
        tail = tts_buffer.strip()
        if tail:
            self.session.cost.tts_chars += len(tail)
            yield PipelineEvent("tts.audio.chunk", {"mode": "browser-speech", "text": tail})
        yield PipelineEvent("llm.done", {"cancelled": False})
        yield PipelineEvent("session.cost", {"cost": self.session.cost.snapshot()})

    async def emit_answer(self, text: str) -> AsyncIterator[PipelineEvent]:
        for i in range(0, len(text), 10):
            yield PipelineEvent("llm.delta", {"delta": text[i : i + 10]})
        yield PipelineEvent("tts.audio.chunk", {"mode": "browser-speech", "text": text})
        yield PipelineEvent("llm.done", {"cancelled": False})
        yield PipelineEvent("session.cost", {"cost": self.session.cost.snapshot()})

    async def stream_medication_answer(self, user_text: str, ocr_result: MedicationOcrResult) -> AsyncIterator[str]:
        config = direct_model_config(self.session)
        prompt = self.build_answer_prompt(user_text, ocr_result)
        self.session.cost.llm_input_tokens_est += estimate_tokens(prompt)
        if config is None:
            text = self.local_answer(user_text, ocr_result)
            for i in range(0, len(text), 10):
                yield text[i : i + 10]
            return

        api_key, base_url, model, _supports_modalities = config
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": "你是药品说明书阅读助手。只能根据用户提供的 OCR 文本回答，不要凭空补全。"},
                {"role": "user", "content": prompt},
            ],
            "stream": True,
            "stream_options": {"include_usage": True},
            "temperature": 0.2,
        }
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        prompt_tokens = 0
        completion_tokens = 0
        estimated_output_tokens = 0
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", f"{base_url}/chat/completions", headers=headers, json=payload) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    raw = line.removeprefix("data: ").strip()
                    if raw == "[DONE]":
                        break
                    try:
                        chunk = json.loads(raw)
                        usage = extract_stream_usage(chunk)
                        if usage:
                            prompt_tokens, completion_tokens = usage
                        delta = chunk["choices"][0].get("delta", {}).get("content", "")
                    except (KeyError, json.JSONDecodeError, IndexError, TypeError):
                        continue
                    if isinstance(delta, str) and delta:
                        estimated_output_tokens += estimate_tokens(delta)
                        yield delta
        if prompt_tokens > 0 or completion_tokens > 0:
            self.session.cost.llm_input_tokens += prompt_tokens
            self.session.cost.llm_output_tokens += completion_tokens
        enqueue_usage_event(
            self.session.user_id,
            self.session.conversation_id,
            provider=base_url,
            model=model,
            modality="agent",
            metric_type="provider_usage" if prompt_tokens or completion_tokens else "estimated_tokens",
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            estimated_prompt_tokens=0 if prompt_tokens else estimate_tokens(prompt),
            estimated_completion_tokens=0 if completion_tokens else estimated_output_tokens,
            details={"agent": self.name, "ocr_provider": ocr_result.provider},
        )

    @staticmethod
    def build_answer_prompt(user_text: str, ocr_result: MedicationOcrResult) -> str:
        uncertain = "；".join(ocr_result.uncertain_parts) if ocr_result.uncertain_parts else "无"
        return (
            "用户正在让你阅读药品说明书。你不是医生，不能给出超出说明书的医疗建议。\n"
            "必须只根据 OCR 文本回答；如果药名、剂量、频次、禁忌不清楚，明确说无法确认。\n"
            "涉及老人、儿童、孕妇、慢病、过敏或联合用药时，提醒咨询医生或药师。\n\n"
            f"用户问题：{user_text}\n"
            f"OCR 提供方：{ocr_result.provider}\n"
            f"OCR 不确定项：{uncertain}\n"
            f"OCR 文本：\n{ocr_result.text}\n\n"
            "请按以下格式简洁回答：\n"
            "我识别到的关键信息：\n用法用量：\n注意事项：\n我不确定的地方：\n建议："
        )

    @staticmethod
    def local_answer(user_text: str, ocr_result: MedicationOcrResult) -> str:
        preview = ocr_result.text_preview(220)
        uncertainty = "；".join(ocr_result.uncertain_parts) if ocr_result.uncertain_parts else "没有额外不确定项。"
        return (
            "我先基于 OCR 结果帮你读一遍，但这不是医生诊断。\n"
            f"我识别到的关键信息：{preview}\n"
            "用法用量：请以识别文本中的“用法用量”原文为准；如果画面里没有清楚出现，我不能替你推断。\n"
            "注意事项：请重点核对禁忌、过敏、慢病、老人或联合用药相关文字。\n"
            f"我不确定的地方：{uncertainty}\n"
            "建议：吃药前请再核对原包装；如果是老人、儿童、孕妇、慢病或正在合并用药，请咨询医生或药师。"
        )
