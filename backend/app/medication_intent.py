from __future__ import annotations

from dataclasses import dataclass


MEDICATION_AGENT = "medication_instruction"

EXIT_KEYWORDS = ("不用了", "取消", "先不看药", "不看药", "换个问题", "回到普通", "退出药品")
OBJECT_KEYWORDS = ("药品说明书", "药品", "药盒", "药瓶", "这个药", "说明书", "用法用量", "禁忌", "副作用")
ACTION_KEYWORDS = ("帮我看", "识别", "读一下", "看看说明书", "怎么吃", "能不能吃", "一天几次", "吃几片", "饭前", "饭后")
STRONG_PHRASES = (
    "这个药怎么吃",
    "这药怎么吃",
    "帮我看药品说明书",
    "帮我看看药品说明书",
    "药盒上的用法用量",
    "药瓶上的用法用量",
    "说明书上的用法用量",
)
FOLLOWUP_KEYWORDS = ("那", "这个", "注意事项", "老人", "禁忌", "饭前", "饭后", "多久一次", "一次几片", "还能吃", "副作用")


@dataclass(frozen=True)
class MedicationIntent:
    matched: bool
    confidence: float
    reason: str
    is_followup: bool = False
    should_exit: bool = False


def normalize_text(text: str) -> str:
    return "".join(text.strip().lower().split())


def contains_any(text: str, keywords: tuple[str, ...]) -> bool:
    return any(keyword in text for keyword in keywords)


def detect_medication_intent(user_text: str, active_context: bool = False) -> MedicationIntent:
    text = normalize_text(user_text)
    if not text:
        return MedicationIntent(False, 0.0, "empty")

    if contains_any(text, EXIT_KEYWORDS):
        return MedicationIntent(False, 1.0, "explicit_exit", should_exit=True)

    if active_context and contains_any(text, FOLLOWUP_KEYWORDS):
        return MedicationIntent(True, 0.72, "followup", is_followup=True)

    if contains_any(text, STRONG_PHRASES):
        return MedicationIntent(True, 0.95, "strong_phrase")

    has_object = contains_any(text, OBJECT_KEYWORDS)
    has_action = contains_any(text, ACTION_KEYWORDS)
    if has_object and has_action:
        return MedicationIntent(True, 0.82, "object_and_action")

    return MedicationIntent(False, 0.0, "no_conservative_match")
