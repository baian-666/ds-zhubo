"""Offline, bounded IndexTTS-2.5 warm speed trial; not a live latency test.

Use existing fictional speech as reference, never upload or change live settings.
The pinned upstream yields whole text segments, not individual acoustic frames.
"""
import argparse
import contextlib
import functools
import hashlib
import importlib.util
import json
import os
import random
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT / "data/indextts/repo"
CASES = {
    "short": "我在听，你继续。",
    "medium": "你来啦，今天有什么好玩的事情？",
    "long": "等等，这个梗我接住了。你是不是又偷偷摸鱼了？别急，我先听你把故事讲完，再来帮你接下一句。",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    reference, output = args.reference.resolve(), args.output.resolve()
    if not output.is_relative_to((ROOT / "data").resolve()) or output.exists():
        raise ValueError("Choose a new output directory inside ignored data")
    if not 1 <= args.repeats <= 5:
        raise ValueError("This is a bounded trial: 1–5 repeats")
    output.mkdir(parents=True)
    os.environ.update({
        "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
        "NLTK_DATA": str(ROOT / "data/indextts/nltk-data"),
        "TORCH_HOME": str(ROOT / "data/indextts/torch-cache"),
        "NUMBA_CACHE_DIR": str(ROOT / "data/indextts/numba-cache"),
    })
    sys.path.insert(0, str(REPO))
    os.chdir(REPO)
    import_started = time.perf_counter()
    import numpy as np
    import soundfile as sf
    import torch
    import indextts.infer_v2_5 as inference

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA required; do not silently benchmark CPU synthesis")
    info = sf.info(str(reference))
    if not 1 <= info.duration <= 15:
        raise ValueError("Reference must be 1–15 seconds; avoid hidden truncation")
    spec = importlib.util.spec_from_file_location("audition", ROOT / "scripts/indextts-audition.py")
    audition = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audition)
    model_class = audition.model_class_with_reference_device(inference, torch, True)
    torch.set_num_threads(6)
    import_seconds = time.perf_counter() - import_started
    free_bytes, total_bytes = torch.cuda.mem_get_info()
    if free_bytes < 5 * 1024 ** 3:
        raise RuntimeError("Insufficient free VRAM for a useful trial; no other processes stopped")
    report = {
        "model": "IndexTTS-2.5",
        "sourceCommit": subprocess.check_output(
            ["D:/work/code/Git/cmd/git.exe", "-C", str(REPO), "rev-parse", "HEAD"], text=True).strip(),
        "reference": str(reference), "referenceSha256": hashlib.sha256(reference.read_bytes()).hexdigest(),
        "referenceDurationSeconds": info.duration,
        "referencePurpose": "Existing fictional cloud speech, speed fixture only; not chosen character voice",
        "gpu": torch.cuda.get_device_name(0), "torchVersion": torch.__version__,
        "freeMiBBeforeLoad": free_bytes / 1024 ** 2, "totalMiB": total_bytes / 1024 ** 2,
        "importSeconds": import_seconds, "referenceEncoderDevice": "cpu",
        "settings": {"bf16": True, "kvCache": True, "accel": False, "torchCompile": False,
                     "cudaKernel": False, "deepSpeed": False, "qwenEmotion": False,
                     "cfmSteps": 25, "seedPolicy": "Same per case/repeat across beam settings"},
        "scope": "Model-side complete text-segment PCM availability, NOT speaker onset or whole conversation",
        "onsetProxy": "First two consecutive 20ms RMS frames >=0.003; acoustic energy, not speech recognition",
        "quality": "Numerical validation only; beam=1 may change pronunciation, timbre or prosody",
        "uploads": False, "liveConfigurationChanged": False,
        "cold": None, "warmups": [], "measurements": [], "diagnostics": [], "summary": {},
    }

    def persist():
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print("Loading one local model; live voice unchanged", flush=True)
    with (output / "model-load.log").open("w", encoding="utf-8") as log, contextlib.redirect_stdout(log):
        started = time.perf_counter()
        model = model_class(
            cfg_path=str(REPO / "checkpoints/config.yaml"), model_dir=str(REPO / "checkpoints"),
            device="cuda:0", use_bf16=True, use_cuda_kernel=False, use_deepspeed=False,
            use_accel=False, use_torch_compile=False, use_qwen_emo=False,
        )
        torch.cuda.synchronize()
        report["modelLoadSeconds"] = time.perf_counter() - started
    torch.cuda.empty_cache()
    persist()
    stage_times = []
    collecting = False

    def instrument(obj, name, label):
        original = getattr(obj, name)

        @functools.wraps(original)
        def measured(*values, **options):
            if not collecting:
                return original(*values, **options)
            torch.cuda.synchronize()
            started = time.perf_counter()
            result = original(*values, **options)
            torch.cuda.synchronize()
            stage_times.append({"stage": label, "seconds": time.perf_counter() - started})
            return result

        setattr(obj, name, measured)

    instrument(model, "get_emb", "referenceEncoder")
    instrument(model.gpt, "inference_speech", "autoregressiveSpeechTokens")
    instrument(model.semantic_codec, "decode", "semanticDecode")
    instrument(model.s2mel.models["length_regulator"], "forward", "lengthRegulator")
    instrument(model.s2mel.models["cfm"], "inference", "cfm")
    instrument(model.bigvgan, "forward", "vocoder")

    def headroom(_module, _arguments, value):
        if not torch.isfinite(value).all():
            raise RuntimeError("Non-finite waveform")
        peak = float(value.detach().abs().max().item())
        return value * min(1.0, 0.9 / max(peak, 1e-8))

    model.bigvgan.register_forward_hook(headroom)

    def run(label, case, beams, seed, diagnostic=False, segment_tokens=120):
        nonlocal collecting
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()
        stage_times.clear()
        collecting = diagnostic
        chunks, ready_times = [], []
        started = time.perf_counter()
        with (output / (label + ".log")).open("w", encoding="utf-8") as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            generator = model.infer(
                spk_audio_prompt=str(reference), text=CASES[case], output_path=None, lang="ZH",
                stream_return=True, interval_silence=0, max_text_tokens_per_segment=segment_tokens,
                emo_vector=None, use_emo_text=False, use_random=False, num_beams=beams,
                duration_factor=1.0, verbose=False,
            )
            for chunk in generator:
                # Pinned upstream returns its existing wav list as the silence
                # sentinel when interval_silence=0. It is not a new PCM chunk.
                if isinstance(chunk, list):
                    continue
                if chunk is not None and chunk.numel():
                    ready_times.append(time.perf_counter() - started)
                    chunks.append(chunk.numpy().reshape(-1).copy() / 32767.0)
            torch.cuda.synchronize()
        elapsed = time.perf_counter() - started
        collecting = False
        if not chunks:
            raise RuntimeError("No PCM returned")
        audio = np.concatenate(chunks)
        if not np.isfinite(audio).all() or np.mean(audio ** 2) < 1e-10 or np.max(np.abs(audio)) > 0.901:
            raise RuntimeError("Invalid audio")
        # Acoustic onset proxy is computed after timing, never claimed as actual playback.
        frame = 441
        onset = None
        for i in range(max(0, len(chunks[0]) // frame - 1)):
            a, b = chunks[0][i * frame:(i + 1) * frame], chunks[0][(i + 1) * frame:(i + 2) * frame]
            if np.sqrt(np.mean(a ** 2)) >= 0.003 and np.sqrt(np.mean(b ** 2)) >= 0.003:
                onset = i * frame / 22050
                break
        target = output / (label + ".wav")
        sf.write(str(target), audio, 22050, subtype="PCM_16")
        result = {
            "label": label, "case": case, "text": CASES[case], "numBeams": beams,
            "seed": seed, "segmentTokenBudget": segment_tokens, "diagnostic": diagnostic,
            "firstPcmSeconds": ready_times[0], "chunkReadySeconds": ready_times,
            "firstChunkDurationSeconds": len(chunks[0]) / 22050,
            "energyOnsetInFirstChunkSeconds": onset,
            "idealPlaybackEnergyOnsetSeconds": None if onset is None else ready_times[0] + onset,
            "fullGenerationSeconds": elapsed, "durationSeconds": len(audio) / 22050,
            "rtf": elapsed / (len(audio) / 22050), "peak": float(np.max(np.abs(audio))),
            "peakAllocatedMiB": torch.cuda.max_memory_allocated() / 1024 ** 2,
            "stageTimes": list(stage_times) if diagnostic else None,
            "path": str(target), "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
        }
        print(json.dumps({k: result[k] for k in ["label", "numBeams", "firstPcmSeconds", "fullGenerationSeconds", "durationSeconds"]}, ensure_ascii=False), flush=True)
        return result

    report["cold"] = run("cold-reference", "short", 3, 20261013, diagnostic=True)
    persist()
    # Separate first-shape warmups from measured requests, then alternate settings.
    for case_index, case in enumerate(CASES):
        for beams in (3, 1):
            report["warmups"].append(run(f"warmup-{case}-b{beams}", case, beams, 20261013))
            persist()
        for repeat in range(args.repeats):
            for beams in ((3, 1) if repeat % 2 == 0 else (1, 3)):
                report["measurements"].append(run(f"{case}-r{repeat + 1}-b{beams}", case, beams, 20261013 + 100 * case_index + repeat))
                persist()
    for beams in (3, 1):
        report["diagnostics"].append(run(f"diagnostic-medium-b{beams}", "medium", beams, 20261013, diagnostic=True))
        persist()
    report["diagnostics"].append(run("segment-first-long-b1", "long", 1, 20261013, segment_tokens=25))
    for case in CASES:
        report["summary"][case] = {}
        for beams in (3, 1):
            rows = [r for r in report["measurements"] if r["case"] == case and r["numBeams"] == beams]
            report["summary"][case][str(beams)] = {
                "count": len(rows),
                "firstPcmMedianSeconds": statistics.median(r["firstPcmSeconds"] for r in rows),
                "fullMedianSeconds": statistics.median(r["fullGenerationSeconds"] for r in rows),
                "minFullSeconds": min(r["fullGenerationSeconds"] for r in rows),
                "maxFullSeconds": max(r["fullGenerationSeconds"] for r in rows),
                "medianAudioSeconds": statistics.median(r["durationSeconds"] for r in rows),
                "medianRtf": statistics.median(r["rtf"] for r in rows),
            }
    if hashlib.sha256(reference.read_bytes()).hexdigest() != report["referenceSha256"]:
        raise RuntimeError("Reference changed during trial")
    report["completed"] = True
    persist()
    print(json.dumps({"summary": report["summary"], "report": str(output / "report.json")}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
