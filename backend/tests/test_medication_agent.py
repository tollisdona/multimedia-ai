import unittest

from app.agent_runtime import AgentContext
from app.medication_agent import MedicationInstructionAgent
from app.medication_ocr import MockOcrProvider
from app.model_config import RuntimeModelConfig
from app.models import FrameSnapshot, SessionState, now_ms


class MedicationAgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_followup_uses_cached_ocr_without_requesting_frame(self):
        session = SessionState()
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

    async def test_unavailable_ocr_exits_without_retake_or_cached_context(self):
        session = SessionState()

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
        self.assertFalse(session.agent_context.get("last_ocr"))
        self.assertTrue(any(event.type == "agent.exited" and event.payload["reason"] == "ocr_quality_low" for event in events))


if __name__ == "__main__":
    unittest.main()
