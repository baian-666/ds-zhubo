"""Voice profile compatibility and validation, without loading speech models."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("index_service", ROOT / "scripts/index-service.py")
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class VoiceProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.profile = self.folder / "reference.json"
        self.speaker = self.folder / "speaker.wav"
        self.emotion = self.folder / "emotion.wav"
        self.emotion.touch()

    def load(self, **extra):
        self.profile.write_text(json.dumps({"audio": str(self.speaker), **extra}), encoding="utf-8")
        return service.voice_settings(self.speaker, self.profile)

    def test_legacy_profile_and_missing_profile_keep_default_emotion(self):
        missing = service.voice_settings(self.speaker, self.profile)
        self.assertEqual(self.load(), missing)
        self.assertIsNone(missing["emotion_audio"])
        self.assertEqual(missing["emotion_alpha"], 1.0)

    def test_separate_emotion_and_explicit_other_speaker_do_not_mix_profiles(self):
        selected = self.load(name="yoimiya-zh", emotion={"audio": str(self.emotion), "alpha": 0.6})
        self.assertEqual(selected["emotion_audio"], self.emotion)
        self.assertEqual(selected["emotion_alpha"], 0.6)
        other = service.voice_settings(self.folder / "other.wav", self.profile)
        self.assertIsNone(other["emotion_audio"])
        self.assertEqual(other["name"], "local-reference")

    def test_invalid_strength_and_missing_audio_fail_before_model_load(self):
        for alpha in [-0.1, 1.1, float("nan"), float("inf"), True, "0.6"]:
            with self.subTest(alpha=alpha), self.assertRaises(ValueError):
                self.load(emotion={"audio": str(self.emotion), "alpha": alpha})
        with self.assertRaises(ValueError):
            self.load(emotion={"audio": str(self.folder / "missing.wav"), "alpha": 0.6})

    def test_contextual_presets_never_carry_happy_reference_into_reassurance(self):
        voice = self.load(contextualEmotion=True, emotion={"audio": str(self.emotion), "alpha": 0.6})
        happy = service.emotion_parameters(voice, 'happy')
        self.assertEqual(happy['emo_audio_prompt'], str(self.emotion))
        self.assertEqual(happy['emo_alpha'], .6)
        for style in [None, 'neutral', 'gentle', 'surprised', '../other.wav', {'audio': 'bad'}]:
            parameters = service.emotion_parameters(voice, style)
            self.assertIsNone(parameters['emo_audio_prompt'])
            self.assertEqual(len(parameters['emo_vector']), 8)
            self.assertLessEqual(sum(parameters['emo_vector']), .8)
        self.assertEqual(service.emotion_parameters(voice, 'happy'), happy)
        self.assertGreater(service.emotion_parameters(voice, 'gentle')['emo_vector'][7],
                           service.emotion_parameters(voice, 'neutral')['emo_vector'][7])

    def test_fixed_profile_stays_compatible_until_context_mode_enabled(self):
        voice = self.load(emotion={"audio": str(self.emotion), "alpha": .6})
        self.assertEqual(service.emotion_parameters(voice, 'gentle')['emo_audio_prompt'], str(self.emotion))
        with self.assertRaises(ValueError):
            self.load(contextualEmotion='true')


if __name__ == "__main__":
    unittest.main()
