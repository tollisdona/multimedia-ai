import unittest

from app.model_config import RuntimeModelConfig
from app.models import SessionState
from app.realtime import QwenRealtimeProvider


async def noop_emit(_event_type, _payload):
    return None


async def noop_transcript(_text):
    return None


def config():
    return RuntimeModelConfig(
        api_key="test-key",
        base_url="https://example.com/v1",
        chat_model="qwen-test",
        supports_modalities=True,
        realtime_enabled=True,
        realtime_base_url="wss://example.com/realtime",
        realtime_model="qwen-realtime-test",
        realtime_voice="Cherry",
        realtime_vad_silence_ms=1200,
    )


class RealtimeGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_append_image_before_audio_returns_false_without_connecting(self):
        provider = QwenRealtimeProvider(SessionState(), noop_emit, noop_transcript, noop_transcript, config())

        async def fail_connect():
            raise AssertionError("append_image should not connect before audio append")

        provider.ensure_connected = fail_connect
        sent = await provider.append_image("data:image/jpeg;base64,abc")
        self.assertFalse(sent)

    async def test_append_audio_marks_audio_seen(self):
        provider = QwenRealtimeProvider(SessionState(), noop_emit, noop_transcript, noop_transcript, config())

        async def fake_ensure_connected():
            return None

        provider.ensure_connected = fake_ensure_connected

        async def fake_send_raw(_payload):
            return None

        provider.send_raw = fake_send_raw
        await provider.append_audio("abc")
        self.assertTrue(provider.audio_append_seen)

    async def test_append_image_rechecks_after_reconnect_reset(self):
        provider = QwenRealtimeProvider(SessionState(), noop_emit, noop_transcript, noop_transcript, config())
        provider.audio_append_seen = True

        async def fake_ensure_connected():
            provider.audio_append_seen = False

        async def fail_send_raw(_payload):
            raise AssertionError("image should not send after reconnect reset")

        provider.ensure_connected = fake_ensure_connected
        provider.send_raw = fail_send_raw
        sent = await provider.append_image("data:image/jpeg;base64,abc")
        self.assertFalse(sent)

    async def test_realtime_provider_noise_errors_are_suppressed(self):
        emitted = []

        async def collect_emit(event_type, payload):
            emitted.append((event_type, payload))

        provider = QwenRealtimeProvider(SessionState(), collect_emit, noop_transcript, noop_transcript, config())
        await provider.handle_server_event(
            {
                "type": "error",
                "error": {
                    "code": "realtime_error",
                    "message": "append image before append audio",
                },
            }
        )
        self.assertEqual(emitted, [])


if __name__ == "__main__":
    unittest.main()
