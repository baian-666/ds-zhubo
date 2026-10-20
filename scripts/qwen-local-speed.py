"""Offline Qwen clone audition. Public wrapper returns a complete waveform.

This measures warm synthesis, NOT streaming first speech or full chat latency.
Run in data/qwen-local/.venv; all model files must already be downloaded.
"""
import argparse
import hashlib
import json
import os
import statistics
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CASES = {
    "short": "我在听，你继续。",
    "welcome": "你来啦！我是小鲸鱼。今天有什么好玩的事情？",
    "teasing": "等等，这个梗我接住了。你是不是又偷偷摸鱼了？",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--prompt-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    output, reference = args.output.resolve(), args.reference.resolve()
    if not output.is_relative_to(ROOT / "data") or output.exists():
        raise ValueError("Use a fresh directory inside ignored data")
    if not 1 <= args.repeats <= 3:
        raise ValueError("Only 1–3 repeats for this bounded audition")
    prompt_text = args.prompt_file.read_text(encoding="utf-8-sig").strip()
    if not 1 <= len(prompt_text) <= 500:
        raise ValueError("Reference transcript required")
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                      NUMBA_CACHE_DIR=str(ROOT / "data/qwen-local/numba-cache"))
    import numpy as np
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA required; do not silently benchmark on CPU")
    free, total = torch.cuda.mem_get_info()
    if free < 5 * 1024 ** 3:
        raise RuntimeError("Insufficient free VRAM; other processes left untouched")
    audio, sr = sf.read(reference, dtype="float32")
    if audio.ndim != 1 or not 1 <= len(audio) / sr <= 15:
        raise ValueError("Use a mono reference of 1–15 seconds")
    output.mkdir(parents=True)
    torch.set_num_threads(6)
    torch.cuda.reset_peak_memory_stats()
    report = dict(model="Qwen3-TTS-12Hz-0.6B-Base", lock=json.loads((ROOT / "qwen-local.lock.json").read_text()),
                  reference=str(reference), referenceSha256=hashlib.sha256(reference.read_bytes()).hexdigest(),
                  promptText=prompt_text, gpu=torch.cuda.get_device_name(), freeGiBBefore=free / 1024**3,
                  dtype="bfloat16", attention="sdpa", maxNewTokens=512,
                  measurement="Complete waveform ready; public wrapper is not PCM streaming; excludes ASR/LLM/playback",
                  trials=[])
    def save():
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    save()
    start = time.perf_counter()
    model = Qwen3TTSModel.from_pretrained(str(ROOT / "data/qwen-local/model"), device_map="cuda:0",
                                        dtype=torch.bfloat16, attn_implementation="sdpa")
    torch.cuda.synchronize()
    report["loadSeconds"] = time.perf_counter() - start
    start = time.perf_counter()
    clone_prompt = model.create_voice_clone_prompt(ref_audio=(audio, sr), ref_text=prompt_text,
                                                  x_vector_only_mode=False)
    torch.cuda.synchronize()
    report["referenceCacheSeconds"] = time.perf_counter() - start
    save()
    print(json.dumps({k: report[k] for k in ("loadSeconds", "referenceCacheSeconds")}), flush=True)
    for repeat in range(args.repeats + 1):
        for index, (case, text) in enumerate(CASES.items()):
            seed = 20261013 + repeat * len(CASES) + index
            torch.manual_seed(seed)
            torch.cuda.manual_seed_all(seed)
            start = time.perf_counter()
            waves, rate = model.generate_voice_clone(text=text, language="Chinese", voice_clone_prompt=clone_prompt,
                                                     non_streaming_mode=False, max_new_tokens=512)
            torch.cuda.synchronize()
            elapsed = time.perf_counter() - start
            wav = np.asarray(waves[0], dtype=np.float32).reshape(-1)
            if not len(wav) or not np.isfinite(wav).all() or float(np.max(np.abs(wav))) < 0.0001:
                raise RuntimeError("Invalid or silent waveform")
            peak = float(np.max(np.abs(wav)))
            gain = min(1.0, 0.95 / peak)
            name = f"{case}-r{repeat}"
            path = output / f"{name}.wav"
            sf.write(path, wav * gain, rate, subtype="PCM_16")
            row = dict(name=name, case=case, text=text, warmup=repeat == 0, seed=seed, completePcmSeconds=elapsed,
                       durationSeconds=len(wav) / rate, rtf=elapsed / (len(wav) / rate), sampleRate=rate,
                       rawPeak=peak, gain=gain, wav=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            report["trials"].append(row)
            report["peakAllocatedGiB"] = torch.cuda.max_memory_allocated() / 1024**3
            save()
            print(json.dumps(row, ensure_ascii=False), flush=True)
    report["warmMediansSeconds"] = {case: statistics.median(row["completePcmSeconds"] for row in report["trials"]
                                    if row["case"] == case and not row["warmup"]) for case in CASES}
    save()


if __name__ == "__main__":
    main()
