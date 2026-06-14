from __future__ import annotations

import json
from typing import Any

import httpx

from .ai import estimate_tokens
from .db import enqueue_usage_event
from .medication_models import MedicationOcrResult
from .model_config import env_model_config
from .models import FrameSnapshot, SessionState


OCR_PROMPT = (
    "qwenvl markdown\n"
    "你正在做药品说明书、药盒或药瓶标签的 OCR。请只提取图像中明确可见的文字，"
    "不要推测、不要补全、不要解释药品用法。优先关注药名、成份、适应症、用法用量、禁忌、"
    "注意事项、老人/儿童/孕妇等特殊人群信息。"
    "请输出严格 JSON："
    '{"full_text":"...","key_sections":[{"label":"...","text":"..."}],"uncertain_parts":["..."]}。'
    "如果看不清，请在 uncertain_parts 中说明。"
)


class UnavailableOcrProvider:
    provider_name = "ocr-unavailable"

    def __init__(self, reason: str) -> None:
        self.reason = reason

    async def recognize(self, frame: FrameSnapshot) -> MedicationOcrResult:
        return MedicationOcrResult(
            text="",
            confidence=0.0,
            blocks=[],
            provider=self.provider_name,
            image_hash=frame.frame_hash,
            captured_at=frame.captured_at,
            uncertain_parts=[self.reason],
        )


class MockOcrProvider(UnavailableOcrProvider):
    def __init__(self) -> None:
        super().__init__("当前未配置可用 OCR 模型，已停止药品说明书识别。")


class QwenVlDocumentOcrProvider:
    provider_name = "qwen-vl-document-ocr"

    def __init__(self, session: SessionState) -> None:
        self.session = session

    async def recognize(self, frame: FrameSnapshot) -> MedicationOcrResult:
        config = self.session.model_config or env_model_config()
        if not config or not config.api_key:
            return await UnavailableOcrProvider("未配置可用 OCR 模型，请先在 API Key 管理中配置支持视觉的模型。").recognize(frame)

        payload = {
            "model": config.chat_model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": OCR_PROMPT},
                        {"type": "image_url", "image_url": {"url": frame.data_url, "detail": "high"}},
                    ],
                }
            ],
            "temperature": 0,
        }
        headers = {"Authorization": f"Bearer {config.api_key}", "Content-Type": "application/json"}
        estimated_prompt_tokens = estimate_tokens(OCR_PROMPT)

        try:
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.post(f"{config.base_url}/chat/completions", headers=headers, json=payload)
                response.raise_for_status()
                data = response.json()
        except Exception:
            return await UnavailableOcrProvider("OCR 调用失败，请检查视觉模型配置或网络后重试。").recognize(frame)

        content = self.extract_content(data)
        parsed = self.parse_ocr_json(content)
        sections = parsed.get("key_sections")
        blocks = sections if isinstance(sections, list) else []
        normalized_blocks = [
            {"label": str(block.get("label", "section")), "text": str(block.get("text", ""))}
            for block in blocks
            if isinstance(block, dict)
        ]
        uncertain_raw = parsed.get("uncertain_parts")
        uncertain_parts = [str(item) for item in uncertain_raw] if isinstance(uncertain_raw, list) else []
        section_text = "\n".join(
            f"{block['label']}：{block['text']}" if block["label"] else block["text"]
            for block in normalized_blocks
            if block.get("text")
        )
        parsed_json = bool(parsed.get("_parsed_json"))
        text = str(parsed.get("full_text") or section_text or ("" if parsed_json else content)).strip()
        usage = data.get("usage") if isinstance(data, dict) else {}
        prompt_tokens = int(usage.get("prompt_tokens", 0) or usage.get("input_tokens", 0) or 0) if isinstance(usage, dict) else 0
        completion_tokens = int(usage.get("completion_tokens", 0) or usage.get("output_tokens", 0) or 0) if isinstance(usage, dict) else 0
        enqueue_usage_event(
            self.session.user_id,
            self.session.conversation_id,
            provider=config.base_url,
            model=config.chat_model,
            modality="ocr",
            metric_type="provider_usage" if prompt_tokens or completion_tokens else "estimated_tokens",
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            estimated_prompt_tokens=0 if prompt_tokens else estimated_prompt_tokens,
            estimated_completion_tokens=0 if completion_tokens else estimate_tokens(content),
            image_count=1,
            details={"provider": self.provider_name},
        )
        return MedicationOcrResult(
            text=text,
            confidence=0.78 if text else 0.0,
            blocks=normalized_blocks,
            provider=self.provider_name,
            image_hash=frame.frame_hash,
            captured_at=frame.captured_at,
            uncertain_parts=uncertain_parts,
        )

    @staticmethod
    def extract_content(data: dict[str, Any]) -> str:
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            return ""
        if isinstance(content, str):
            return content
        return json.dumps(content, ensure_ascii=False)

    @staticmethod
    def parse_ocr_json(content: str) -> dict[str, Any]:
        clean = content.strip()
        if clean.startswith("```"):
            clean = clean.strip("`")
            if clean.lower().startswith("json"):
                clean = clean[4:].strip()
        start = clean.find("{")
        end = clean.rfind("}")
        if start >= 0 and end > start:
            clean = clean[start : end + 1]
        try:
            parsed = json.loads(clean)
        except json.JSONDecodeError:
            return {"full_text": content, "key_sections": [], "uncertain_parts": ["OCR 输出不是 JSON，已保留原始文本。"], "_parsed_json": False}
        if isinstance(parsed, dict):
            parsed["_parsed_json"] = True
            return parsed
        return {"full_text": content, "key_sections": [], "uncertain_parts": ["OCR 输出不是对象 JSON，已保留原始文本。"], "_parsed_json": False}
