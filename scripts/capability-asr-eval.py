"""Offline PCM stress evaluation; synthetic source recordings, not human acceptance."""
import hashlib
import json
import pathlib
import re
import sys
import time
import wave
import xml.etree.ElementTree as ET

root = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / "data/asr-local/runtime"))
import numpy as np
import sherpa_onnx

output = root / "data" / ("capability-asr-" + str(time.time_ns()) + ".json")
model = root / "data/asr-local/sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01"
started = time.perf_counter()
recognizer = sherpa_onnx.OnlineRecognizer.from_zipformer2_ctc(
    model=str(model / "model.int8.onnx"), tokens=str(model / "tokens.txt"),
    num_threads=2, provider="cpu", enable_endpoint_detection=False,
)
report = {"method": "Actual local Zipformer decoding of existing synthetic Windows speech PCM; unpaced batch processing, no VAD/microphone/TTS/playback. White noise is a controlled stressor, not a real room.",
          "loadMs": round((time.perf_counter() - started) * 1000), "version": sherpa_onnx.__version__, "rows": []}

def normalized(text):
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]", "", text.lower())

def distance(a, b):
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        current = [i + 1]
        for j, cb in enumerate(b):
            current.append(min(current[-1] + 1, previous[j + 1] + 1, previous[j] + (ca != cb)))
        previous = current
    return previous[-1]

rng = np.random.default_rng(20261020)
sources = []
targeted = "--targeted" in sys.argv
if targeted:
    folder = root / "data/capability-eval-20261020/asr"
    cases = json.loads((folder / "cases.json").read_text(encoding="utf-8-sig"))
else:
    folder = root / "data/listening-audio-trial"
    cases = [{"id": name} for name in ["input", "backchannel-input", "resume-input"]]
report["corpus"] = "12 targeted synthetic utterances" if targeted else "3 existing synthetic story recordings"
for case in cases:
    name = case["id"]
    file = folder / (name + ".wav")
    with wave.open(str(file)) as wav:
        assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (16000, 1, 2)
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    expected = case.get("text") or "".join(ET.parse(file.with_suffix(".ssml")).getroot().itertext()).strip()
    sources.append((name, samples, expected, hashlib.sha256(file.read_bytes()).hexdigest()))
for name, samples, expected, sha in sources:
    voiced = samples[np.abs(samples) > 0.01]
    rms = float(np.sqrt(np.mean(voiced ** 2)))
    for variant in ["clean", "white-noise-10dB"]:
        audio = samples.copy()
        if variant != "clean":
            audio = np.clip(audio + rng.normal(0, rms / (10 ** (10 / 20)), audio.shape).astype(np.float32), -1, 1)
        stream = recognizer.create_stream()
        at = time.perf_counter()
        partials = []
        previous = ""
        for offset in range(0, len(audio), 512):
            stream.accept_waveform(16000, audio[offset:offset + 512])
            while recognizer.is_ready(stream):
                recognizer.decode_stream(stream)
            text = recognizer.get_result(stream)
            if text != previous:
                partials.append({"audioMs": round((offset + 512) / 16), "text": text})
                previous = text
        stream.accept_waveform(16000, np.zeros(10240, dtype=np.float32))
        stream.input_finished()
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        text = recognizer.get_result(stream)
        ref, actual = normalized(expected), normalized(text)
        edits = distance(ref, actual)
        row = {"name": name, "variant": variant, "sha256": sha, "expected": expected, "text": text,
               "referenceChars": len(ref), "editDistance": edits, "cer": edits / len(ref),
               "decodeMs": round((time.perf_counter() - at) * 1000), "audioMs": round(len(audio) / 16), "partials": partials}
        report["rows"].append(row)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({key: value for key, value in row.items() if key not in ["partials", "expected"]}, ensure_ascii=False), flush=True)
report["output"] = str(output)
output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(str(output), flush=True)
