"""Four offline emotion samples; never starts, stops, or configures live services.

Run only in an agreed GPU window. Uses the installed IndexTTS environment and
the current reference.json. Output is protected from overwriting previous runs.
"""
import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT / "data/indextts/repo"
PROFILE = ROOT / "data/indextts/reference.json"
TEXT = "原来你真的做到了，我刚才还以为你在开玩笑呢。"
SEED = 20261015


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--emotion-reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    emotion_reference = args.emotion_reference.resolve()
    if not output.is_relative_to((ROOT / "data/indextts").resolve()):
        raise ValueError("Output must be inside project data/indextts")
    if output.exists():
        raise FileExistsError("Choose a new output directory")
    profile_hash = digest(PROFILE)
    reference = Path(json.loads(PROFILE.read_text(encoding="utf-8-sig"))["audio"]).resolve()
    reference_hash, emotion_hash = digest(reference), digest(emotion_reference)
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                      NLTK_DATA=str(ROOT / "data/indextts/nltk-data"),
                      TORCH_HOME=str(ROOT / "data/indextts/torch-cache"),
                      NUMBA_CACHE_DIR=str(ROOT / "data/indextts/numba-cache"))
    sys.path.insert(0, str(REPO))
    os.chdir(REPO)
    import numpy as np
    import psutil
    import soundfile as sf
    import torch
    import indextts.infer_v2_5 as inference

    for path in (reference, emotion_reference):
        if not 1 <= sf.info(path).duration <= 15:
            raise ValueError("References must be 1–15 seconds; no implicit crop")
    if not torch.cuda.is_available() or torch.cuda.mem_get_info()[0] < 5 * 1024**3:
        raise RuntimeError("Need 5 GiB free VRAM; coordinate before running")
    if psutil.virtual_memory().available < 5 * 1024**3:
        raise RuntimeError("Need 5 GiB available RAM; do not force paging")
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
    spec = importlib.util.spec_from_file_location("offline_audition", ROOT / "scripts/indextts-audition.py")
    audition = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audition)
    cls = audition.model_class_with_reference_device(inference, torch, True)
    output.mkdir(parents=True)
    report = {
        "model": "IndexTTS-2.5", "text": TEXT, "seedPerCandidate": SEED,
        "reference": str(reference), "referenceSha256": reference_hash,
        "profileSha256": profile_hash, "referenceDurationSeconds": sf.info(reference).duration,
        "emotionReference": str(emotion_reference), "emotionReferenceSha256": emotion_hash,
        "emotionReferenceDurationSeconds": sf.info(emotion_reference).duration,
        "sourceCommit": subprocess.check_output(["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True).strip(),
        "settings": {"beams": 3, "cfmSteps": 25, "durationFactor": 1.0,
                     "bf16": True, "textEmotion": False, "randomEmotionSelection": False,
                     "doSample": True, "topP": 0.8, "topK": 30, "temperature": 0.8,
                     "repetitionPenalty": 10.0, "referenceEncoder": "cpu"},
        "scope": "One real synthesis per candidate; no latency benchmark or human listening verdict",
        "serviceConfigurationChanged": False, "uploads": False, "cases": [],
    }
    cases = [
        ("01-default", "当前默认", {}),
        ("02-light-happy", "轻开心 0.35", {"emo_vector": [0.35, 0, 0, 0, 0, 0, 0, 0]}),
        ("03-light-surprise", "轻惊讶 0.35", {"emo_vector": [0, 0, 0, 0, 0, 0, 0.35, 0]}),
        ("04-happy-reference", "独立开心参考 0.60", {"emo_audio_prompt": str(emotion_reference), "emo_alpha": 0.6}),
    ]
    peaks = []

    def headroom(_module, _args, wav):
        if not torch.isfinite(wav).all():
            raise RuntimeError("Non-finite vocoder output")
        peak = float(wav.abs().max())
        gain = min(1.0, 0.9 / max(peak, 1e-8))
        peaks.append({"rawPeak": peak, "gain": gain})
        return wav * gain

    with (output / "inference.log").open("w", encoding="utf-8") as log:
        started = time.perf_counter()
        print("Loading offline model", flush=True)
        with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            model = cls(cfg_path=str(REPO / "checkpoints/config.yaml"), model_dir=str(REPO / "checkpoints"),
                        device="cuda:0", use_bf16=True, use_cuda_kernel=False,
                        use_deepspeed=False, use_accel=False, use_torch_compile=False, use_qwen_emo=False)
            model.bigvgan.register_forward_hook(headroom)
        report["modelLoadSeconds"] = time.perf_counter() - started
        for name, label, emotion in cases:
            if digest(PROFILE) != profile_hash or digest(reference) != reference_hash:
                raise RuntimeError("Current voice changed during audition")
            random.seed(SEED)
            np.random.seed(SEED)
            torch.manual_seed(SEED)
            torch.cuda.manual_seed_all(SEED)
            peak_start = len(peaks)
            print("Generating " + name, flush=True)
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                chunks = []
                for part in model.infer(spk_audio_prompt=str(reference), text=TEXT, lang="ZH", output_path=None,
                                        stream_return=True, interval_silence=0, max_text_tokens_per_segment=120,
                                        use_emo_text=False, use_random=False, num_beams=3, duration_factor=1.0,
                                        do_sample=True, top_p=0.8, top_k=30, temperature=0.8,
                                        repetition_penalty=10.0, verbose=False, **emotion):
                    if not isinstance(part, list) and part is not None and part.numel():
                        chunks.append(part.numpy().reshape(-1))
                if not chunks:
                    raise RuntimeError("No generated PCM")
                raw = np.concatenate(chunks)
                if not np.isfinite(raw).all():
                    raise RuntimeError("Non-finite generated PCM")
                pcm = np.clip(raw, -32767, 32767).astype("<i2")
            path = output / (name + ".wav")
            sf.write(path, pcm, 22050, subtype="PCM_16")
            audio, rate = sf.read(path)
            rms = float(np.sqrt(np.mean(audio**2)))
            if not 0.5 < len(audio) / rate < 30 or rms < 1e-5 or np.max(np.abs(audio)) >= 0.999:
                raise RuntimeError("Invalid, silent or clipped candidate")
            result = {"name": name, "label": label, "emotionParameters": emotion, "path": str(path),
                      "sampleRate": rate, "durationSeconds": len(audio) / rate, "rms": rms,
                      "peak": float(np.max(np.abs(audio))), "headroom": peaks[peak_start:], "sha256": digest(path)}
            report["cases"].append(result)
            (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({"completed": name, "durationSeconds": result["durationSeconds"]}), flush=True)
    if digest(PROFILE) != profile_hash or digest(reference) != reference_hash or digest(emotion_reference) != emotion_hash:
        raise RuntimeError("Reference/profile changed during audition")
    print("Four samples complete; references unchanged", flush=True)


if __name__ == "__main__":
    main()
