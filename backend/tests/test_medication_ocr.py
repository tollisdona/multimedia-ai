import unittest

from app.medication_models import MedicationOcrResult, medication_quality
from app.medication_ocr import MockOcrProvider, QwenVlDocumentOcrProvider
from app.models import FrameSnapshot


class MedicationOcrTests(unittest.IsolatedAsyncioTestCase):
    async def test_mock_provider_returns_unavailable_result(self):
        frame = FrameSnapshot(
            data_url="data:image/jpeg;base64,abc",
            reason="medication-agent",
            frame_hash="frame1",
            captured_at=123,
        )
        result = await MockOcrProvider().recognize(frame)
        self.assertEqual(result.provider, "ocr-unavailable")
        self.assertEqual(result.image_hash, "frame1")
        self.assertEqual(result.text, "")
        self.assertIsNotNone(result.confidence)
        self.assertNotIn("示例片", result.text)

    async def test_mock_result_fails_quality_gate_without_retry(self):
        frame = FrameSnapshot(
            data_url="data:image/jpeg;base64,abc",
            reason="medication-agent",
            frame_hash="frame1",
            captured_at=123,
        )
        result = await MockOcrProvider().recognize(frame)
        quality = medication_quality(result)
        self.assertFalse(quality.accepted)
        self.assertFalse(quality.retryable)

    def test_structured_empty_json_does_not_become_raw_text(self):
        parsed = QwenVlDocumentOcrProvider.parse_ocr_json(
            '```json\n{"full_text":"","key_sections":[],"uncertain_parts":["图像中未检测到任何文字信息。"]}\n```'
        )
        self.assertTrue(parsed["_parsed_json"])
        self.assertEqual(parsed["full_text"], "")

    def test_partial_medication_text_can_be_accepted_as_uncertain(self):
        result = MedicationOcrResult(
            text="药品名称：示例片。成份：示例成分。",
            confidence=0.5,
            blocks=[],
            provider="test",
            image_hash="hash",
            captured_at=123,
            uncertain_parts=[],
        )
        quality = medication_quality(result)
        self.assertTrue(quality.accepted)
        self.assertIn("用法用量或注意事项", quality.missing)


if __name__ == "__main__":
    unittest.main()
