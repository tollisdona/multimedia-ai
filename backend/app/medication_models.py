from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class MedicationOcrResult:
    text: str
    confidence: float | None
    blocks: list[dict[str, str]]
    provider: str
    image_hash: str
    captured_at: int
    uncertain_parts: list[str] = field(default_factory=list)

    def text_preview(self, limit: int = 160) -> str:
        clean = " ".join(self.text.split())
        return clean[:limit]


@dataclass
class MedicationQuality:
    accepted: bool
    reason: str
    score: float
    missing: list[str] = field(default_factory=list)
    retryable: bool = True


def medication_quality(result: MedicationOcrResult) -> MedicationQuality:
    text = result.text.strip()
    if result.provider == "ocr-unavailable":
        reason = result.uncertain_parts[0] if result.uncertain_parts else "OCR 服务暂不可用，无法读取说明书。"
        return MedicationQuality(False, reason, 0.0, ["ocr_provider"], retryable=False)
    if len(text) < 12:
        return MedicationQuality(False, "识别到的文字太少，请靠近一点并保持画面稳定。", 0.2, ["text"])

    has_medication_hint = any(keyword in text for keyword in ("药", "片", "胶囊", "颗粒", "说明书", "成份", "成分", "适应症"))
    has_usage_hint = any(keyword in text for keyword in ("用法", "用量", "一次", "每日", "一天", "口服", "饭前", "饭后", "禁忌", "注意事项"))
    if not has_medication_hint and not has_usage_hint:
        return MedicationQuality(False, "还没有看清药品名称、用法用量或注意事项，请把相关区域放到画面中央。", 0.35, ["药品名称或用法用量"])

    confidence = result.confidence if result.confidence is not None else 0.72
    if confidence < 0.35:
        return MedicationQuality(False, "文字识别置信度偏低，请换个光线更好的角度再试。", confidence)

    missing: list[str] = []
    if not has_medication_hint:
        missing.append("药品名称或剂型")
    if not has_usage_hint:
        missing.append("用法用量或注意事项")
    if missing:
        return MedicationQuality(True, f"已识别到部分说明书文字，但{ '、'.join(missing) }仍不够清楚。", min(0.72, max(0.5, confidence)), missing)

    return MedicationQuality(True, "accepted", min(1.0, max(0.6, confidence)))


def result_to_agent_context(result: MedicationOcrResult) -> dict[str, Any]:
    return {
        "text": result.text,
        "confidence": result.confidence,
        "provider": result.provider,
        "image_hash": result.image_hash,
        "captured_at": result.captured_at,
        "uncertain_parts": result.uncertain_parts,
        "blocks": result.blocks,
    }
