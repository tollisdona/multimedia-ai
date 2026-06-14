import unittest

from app.agent_runtime import AgentContext
from app.medication_agent import MedicationInstructionAgent
from app.medication_models import MedicationOcrResult
from app.medication_ocr import MockOcrProvider
from app.model_config import RuntimeModelConfig
from app.models import FrameSnapshot, SessionState, now_ms


def disable_model_config(session: SessionState) -> None:
    session.model_config = RuntimeModelConfig(
        api_key="",
        base_url="https://example.com/v1",
        chat_model="test",
        supports_modalities=True,
        realtime_enabled=False,
        realtime_base_url="wss://example.com/realtime",
        realtime_model="test-realtime",
        realtime_voice="Cherry",
        realtime_vad_silence_ms=1200,
    )


class MedicationAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_followup_uses_cached_ocr_without_requesting_frame(self):
        session = SessionState()
        disable_model_config(session)
        session.agent_state = "medication.ready_for_followup"
        session.agent_followup_until = now_ms() + 60_000
        session.agent_turns_remaining = 3
        session.agent_context = {
            "last_ocr": {
                "text": "药品名称：示例片。用法用量：一次一片，一日三次。注意事项：请遵医嘱。",
                "confidence": 0.8,
                "provider": "test",
                "image_hash": "hash",
                "captured_at": now_ms(),
                "uncertain_parts": [],
                "blocks": [],
            }
        }

        async def fail_request_frame(*_args, **_kwargs):
            raise AssertionError("follow-up should reuse cached OCR")

        agent = MedicationInstructionAgent(
            AgentContext(
                session=session,
                emit=None,
                request_frame=fail_request_frame,
                ocr_provider=MockOcrProvider(),
            )
        )
        events = [event async for event in agent.run("那饭前还是饭后？")]
        self.assertTrue(any(event.type == "llm.delta" for event in events))
        self.assertEqual(session.agent_state, "medication.ready_for_followup")
        self.assertEqual(session.agent_turns_remaining, 2)

    async def test_unavailable_ocr_still_goes_to_answer_model_path(self):
        session = SessionState()
        disable_model_config(session)

        async def request_frame(*_args, **_kwargs):
            return FrameSnapshot(
                data_url="data:image/jpeg;base64,abc",
                reason="medication-agent",
                frame_hash="frame1",
                captured_at=now_ms(),
            )

        agent = MedicationInstructionAgent(
            AgentContext(
                session=session,
                emit=None,
                request_frame=request_frame,
                ocr_provider=MockOcrProvider(),
            )
        )
        events = [event async for event in agent.run("识别这个说明书")]
        self.assertFalse(any(event.type == "ocr.retake.requested" for event in events))
        self.assertFalse(any(event.type == "agent.exited" and event.payload["reason"] == "ocr_quality_low" for event in events))
        self.assertTrue(any(event.type == "llm.delta" for event in events))
        self.assertEqual(session.agent_state, "medication.ready_for_followup")
        self.assertEqual(session.agent_context["last_ocr"]["image_data_url"], "data:image/jpeg;base64,abc")

    async def test_low_quality_ocr_does_not_trigger_code_retake(self):
        session = SessionState()
        disable_model_config(session)

        async def request_frame(*_args, **_kwargs):
            return FrameSnapshot(
                data_url="data:image/jpeg;base64,abc",
                reason="medication-agent",
                frame_hash="frame1",
                captured_at=now_ms(),
            )

        class LowTextOcrProvider:
            async def recognize(self, frame):
                return MedicationOcrResult(
                    text="太少",
                    confidence=0.78,
                    blocks=[],
                    provider="test",
                    image_hash=frame.frame_hash,
                    captured_at=frame.captured_at,
                    uncertain_parts=[],
                    image_data_url=frame.data_url,
                )

        agent = MedicationInstructionAgent(
            AgentContext(
                session=session,
                emit=None,
                request_frame=request_frame,
                ocr_provider=LowTextOcrProvider(),
            )
        )
        events = [event async for event in agent.run("识别这个说明书")]
        guidance_events = [event for event in events if event.type == "agent.guidance"]
        self.assertEqual(len(guidance_events), 1)
        self.assertFalse(guidance_events[0].payload["speak"])
        ocr_events = [event for event in events if event.type == "ocr.result"]
        self.assertEqual(len(ocr_events), 1)
        self.assertFalse(ocr_events[0].payload["accepted"])
        self.assertFalse(ocr_events[0].payload["retryable"])
        self.assertFalse(any(event.type == "ocr.retake.requested" for event in events))
        self.assertTrue(any(event.type == "llm.delta" for event in events))

    def test_answer_user_content_includes_ocr_text_and_image(self):
        result = MedicationOcrResult(
            text="药品名称：示例片。用法用量：一次一片。",
            confidence=0.8,
            blocks=[],
            provider="test",
            image_hash="hash",
            captured_at=123,
            uncertain_parts=[],
            image_data_url="data:image/jpeg;base64,abc",
        )
        prompt = MedicationInstructionAgent.build_answer_prompt("这个药怎么吃？", result)
        content = MedicationInstructionAgent.build_answer_user_content(prompt, result)
        self.assertIsInstance(content, list)
        self.assertEqual(content[0]["type"], "text")
        self.assertIn("OCR 文本", content[0]["text"])
        self.assertEqual(content[1]["type"], "image_url")
        self.assertEqual(content[1]["image_url"]["url"], result.image_data_url)

    def test_answer_prompt_asks_model_to_handle_retry_guidance(self):
        result = MedicationOcrResult(
            text="",
            confidence=0.0,
            blocks=[],
            provider="test",
            image_hash="hash",
            captured_at=123,
            uncertain_parts=["OCR 调用失败"],
            image_data_url="data:image/jpeg;base64,abc",
        )
        prompt = MedicationInstructionAgent.build_answer_prompt("识别这个说明书", result)
        self.assertIn("OCR 未识别到可用文字", prompt)
        self.assertIn("由你自然提示用户重新", prompt)


if __name__ == "__main__":
    unittest.main()
