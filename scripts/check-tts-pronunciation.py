"""Offline ASR diagnostic for trial WAVs. ASR disagreement is not proof of a TTS error."""
import argparse
import hashlib
import json
from math import gcd
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--repeat", type=int, default=1)
    args = parser.parse_args()
    path = args.report.resolve()
    if not path.is_relative_to(ROOT / "data"):
        raise ValueError("Only project-local trial reports")
    import numpy as np
    from scipy.signal import resample_poly
    import soundfile as sf
    import torch
    import whisper
    from opencc import OpenCC

    report = json.loads(path.read_text(encoding="utf-8"))
    torch.set_num_threads(6)
    model = whisper.load_model(str(ROOT / "data/aqua-tts/whisper-small/small.pt"), device="cpu")
    convert = OpenCC("t2s")
    def normalize(text):
        return re.sub(r"[^\w\u4e00-\u9fff]", "", convert.convert(text))
    def distance(a, b):
        row = list(range(len(b) + 1))
        for i, x in enumerate(a):
            new = [i + 1]
            for j, y in enumerate(b):
                new.append(min(new[-1] + 1, row[j + 1] + 1, row[j] + (x != y)))
            row = new
        return row[-1]
    checks = []
    for trial in report["trials"]:
        if trial["warmup"] or not trial["name"].endswith(f"-r{args.repeat}"):
            continue
        wav = Path(trial["wav"]).resolve()
        if not wav.is_relative_to(path.parent):
            raise ValueError("Waveform outside trial folder")
        digest = hashlib.sha256(wav.read_bytes()).hexdigest()
        if digest != trial["sha256"]:
            raise ValueError("Waveform changed after benchmark")
        audio, rate = sf.read(wav)
        d = gcd(rate, 16000)
        audio = resample_poly(audio, 16000 // d, rate // d).astype(np.float32)
        result = model.transcribe(audio, language="zh", fp16=False, temperature=0, beam_size=5,
                                  condition_on_previous_text=False)
        row = dict(name=trial["name"], expected=trial["text"], recognized=result["text"],
                   characterEditDistance=distance(normalize(trial["text"]), normalize(result["text"])),
                   diagnosticOnly=True, humanListeningRequired=True)
        checks.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
        (path.parent / f"asr-check-r{args.repeat}.json").write_text(
            json.dumps(checks, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
