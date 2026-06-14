import unittest

from app.medication_intent import detect_medication_intent


class MedicationIntentTests(unittest.TestCase):
    def test_strong_medication_phrases_match(self):
        self.assertTrue(detect_medication_intent("这个药怎么吃").matched)
        self.assertTrue(detect_medication_intent("帮我看药品说明书").matched)
        self.assertTrue(detect_medication_intent("药盒上的用法用量是什么").matched)

    def test_generic_vision_phrases_do_not_match(self):
        self.assertFalse(detect_medication_intent("识别文字").matched)
        self.assertFalse(detect_medication_intent("帮我看看这个").matched)
        self.assertFalse(detect_medication_intent("看一下说明").matched)

    def test_followup_and_exit(self):
        followup = detect_medication_intent("那饭前还是饭后", active_context=True)
        self.assertTrue(followup.matched)
        self.assertTrue(followup.is_followup)
        exit_intent = detect_medication_intent("不用了，换个问题", active_context=True)
        self.assertTrue(exit_intent.should_exit)


if __name__ == "__main__":
    unittest.main()
