"""Bounded, same-reference Index trial: beams, clause scheduling and CFM steps.

Measures when real generated PCM becomes available; does not prepend canned audio.
Profiles change one factor at a time. None changes the live cohost configuration.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT / "data/indextts/repo"
CASES = {
    "welcome": ["你来啦！我是小鲸鱼。", "今天有什么好玩的事情？"],
    "teasing": ["等等，这个梗我接住了。", "你是不是又偷偷摸鱼了？"],
}
PROFILES = {"baseline": (3, 25, False), "beam1": (1, 25, False),
            "clauses": (1, 25, True), "clauses16": (1, 16, True), "clauses_quality": (3, 25, True)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--profiles", nargs="+", choices=list(PROFILES), default=list(PROFILES)[:4])
    args = parser.parse_args()
    reference, output = args.reference.resolve(), args.output.resolve()
    if not output.is_relative_to(ROOT / "data") or output.exists() or not 1 <= args.repeats <= 3:
        raise ValueError("Use fresh ignored output and 1–3 repeats")
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                      NLTK_DATA=str(ROOT / "data/indextts/nltk-data"),
                      TORCH_HOME=str(ROOT / "data/indextts/torch-cache"),
                      NUMBA_CACHE_DIR=str(ROOT / "data/indextts/numba-cache"))
    sys.path.insert(0, str(REPO))
    os.chdir(REPO)
    import numpy as np
    import soundfile as sf
    import torch
    import indextts.infer_v2_5 as inference
    if not torch.cuda.is_available() or torch.cuda.mem_get_info()[0] < 5 * 1024**3:
        raise RuntimeError("Need at least 5 GiB free CUDA memory; other processes left untouched")
    if not 1 <= sf.info(reference).duration <= 15:
        raise ValueError("Use reference of 1–15 seconds")
    output.mkdir(parents=True)
    spec = importlib.util.spec_from_file_location("audition", ROOT / "scripts/indextts-audition.py")
    audition = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audition)
    cls = audition.model_class_with_reference_device(inference, torch, True)
    torch.set_num_threads(6)
    report = dict(model="IndexTTS-2.5", reference=str(reference),
                  referenceSha256=hashlib.sha256(reference.read_bytes()).hexdigest(),
                  measurement="PCM availability and ideal playback schedule, excludes ASR/LLM/device playback",
                  profiles={key: PROFILES[key] for key in args.profiles}, trials=[])
    def save():
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    save()
    with (output / "model.log").open("w", encoding="utf-8") as log, contextlib.redirect_stdout(log):
        start = time.perf_counter()
        model = cls(cfg_path=str(REPO / "checkpoints/config.yaml"), model_dir=str(REPO / "checkpoints"),
                    device="cuda:0", use_bf16=True, use_cuda_kernel=False, use_deepspeed=False,
                    use_accel=False, use_torch_compile=False, use_qwen_emo=False)
        torch.cuda.synchronize()
        report["loadSeconds"] = time.perf_counter() - start
    steps = 25
    original_cfm = model.s2mel.models["cfm"].inference
    def cfm(mu, x_lens, prompt, style, f0, n_timesteps, **kwargs):
        return original_cfm(mu, x_lens, prompt, style, f0, steps, **kwargs)
    model.s2mel.models["cfm"].inference = cfm
    def headroom(_module, _args, wav):
        if not torch.isfinite(wav).all():
            raise RuntimeError("Non-finite audio")
        return wav * min(1.0, 0.9 / max(float(wav.abs().max()), 1e-8))
    model.bigvgan.register_forward_hook(headroom)
    for repeat in range(args.repeats + 1):
        profiles = [(key, PROFILES[key]) for key in args.profiles]
        if repeat % 2:
            profiles.reverse()
        for case_idx, (case, clauses) in enumerate(CASES.items()):
            for profile, (beams, steps, split) in profiles:
                seed = 20261013 + repeat * len(CASES) + case_idx
                random.seed(seed)
                np.random.seed(seed)
                torch.manual_seed(seed)
                torch.cuda.manual_seed_all(seed)
                name = f"{case}-{profile}-r{repeat}"
                chunks, arrival = [], []
                torch.cuda.synchronize()
                start = time.perf_counter()
                with (output / f"{name}.log").open("w", encoding="utf-8") as log, contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                    for text in clauses if split else ["".join(clauses)]:
                        for chunk in model.infer(spk_audio_prompt=str(reference), text=text, output_path=None,
                                                 lang="ZH", stream_return=True, interval_silence=0,
                                                 max_text_tokens_per_segment=120, emo_vector=None, use_emo_text=False,
                                                 use_random=False, num_beams=beams, duration_factor=1.0, verbose=False):
                            if isinstance(chunk, list) or chunk is None or not chunk.numel():
                                continue
                            arrival.append(time.perf_counter() - start)
                            chunks.append(chunk.numpy().reshape(-1).copy() / 32767.0)
                elapsed = time.perf_counter() - start
                if not chunks:
                    raise RuntimeError("No waveform")
                wav = np.concatenate(chunks)
                if not np.isfinite(wav).all() or np.mean(wav ** 2) < 1e-10:
                    raise RuntimeError("Invalid waveform")
                ready_until, gaps = arrival[0], []
                playback = []
                for chunk, arrived in zip(chunks, arrival):
                    gaps.append(max(0, arrived - ready_until))
                    playback.extend([np.zeros(round(gaps[-1] * 22050), dtype=np.float32), chunk])
                    ready_until = max(arrived, ready_until) + len(chunk) / 22050
                path = output / f"{name}.wav"
                sf.write(path, np.concatenate(playback), 22050, subtype="PCM_16")
                row = dict(name=name, case=case, profile=profile, text="".join(clauses), seed=seed,
                           warmup=repeat == 0, firstPcmSeconds=arrival[0], completePcmSeconds=elapsed,
                           chunkReadySeconds=arrival, durationsSeconds=[len(c)/22050 for c in chunks],
                           idealPlaybackGapSeconds=sum(gaps), rawSpeechDurationSeconds=len(wav)/22050,
                           wav=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest())
                report["trials"].append(row)
                save()
                print(json.dumps(row, ensure_ascii=False), flush=True)
    report["warmSummary"] = {}
    for profile in args.profiles:
        for case in CASES:
            rows = [r for r in report["trials"] if r["profile"] == profile and r["case"] == case and not r["warmup"]]
            report["warmSummary"][case + "-" + profile] = dict(
                firstPcmMedian=statistics.median(r["firstPcmSeconds"] for r in rows),
                completeMedian=statistics.median(r["completePcmSeconds"] for r in rows),
                maxIdealPlaybackGap=max(r["idealPlaybackGapSeconds"] for r in rows))
    save()


if __name__ == "__main__":
    main()
