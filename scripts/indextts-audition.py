"""Local IndexTTS-2.5 audition; no uploads or cohost configuration changes.

Run with the isolated interpreter in data/indextts/repo/.venv. Public weights
must already be prepared. References and generated audio remain in ignored data.
"""
import argparse
import hashlib
import json
import os
import random
import subprocess
import sys
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT / "data/indextts/repo"


def model_class_with_reference_device(inference, torch, cpu_reference_encoder):
    """Audition-only adapter, shared with the offline speed benchmark."""
    if not cpu_reference_encoder:
        return inference.IndexTTS2

    class CPUReferenceModel(inference.Wav2Vec2BertModel):
        def to(self, *values, **options):
            if values and str(values[0]).startswith("cuda"):
                values = ("cpu", *values[1:])
            if str(options.get("device", "")).startswith("cuda"):
                options["device"] = "cpu"
            return super().to(*values, **options)

    inference.Wav2Vec2BertModel = CPUReferenceModel

    class AuditionTTS(inference.IndexTTS2):
        @torch.no_grad()
        def get_emb(self, input_features, attention_mask):
            output_features = self.semantic_model(
                input_features=input_features.cpu(), attention_mask=attention_mask.cpu(),
                output_hidden_states=True,
            ).hidden_states[17].to(self.device)
            return (output_features - self.semantic_mean) / self.semantic_std

    return AuditionTTS


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reference-encoder-device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--case-file", type=Path)
    args = parser.parse_args()
    reference = args.reference.resolve()
    output = args.output.resolve()
    case_file = args.case_file.resolve() if args.case_file else None
    if not output.is_relative_to((ROOT / "data").resolve()):
        raise ValueError("Output must be inside ignored project data")
    if output.exists():
        raise FileExistsError("Existing audition protected; choose a new output directory")
    with wave.open(str(reference), "rb") as stream:
        reference_duration = stream.getnframes() / stream.getframerate()
    if not 1 <= reference_duration <= 15:
        raise ValueError("Use a reference of 1–15 seconds; avoid implicit model truncation")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["NLTK_DATA"] = str(ROOT / "data/indextts/nltk-data")
    os.environ["TORCH_HOME"] = str(ROOT / "data/indextts/torch-cache")
    os.environ["NUMBA_CACHE_DIR"] = str(ROOT / "data/indextts/numba-cache")
    sys.path.insert(0, str(REPO))
    os.chdir(REPO)
    import numpy as np
    import soundfile as sf
    import torch
    import indextts.infer_v2_5 as inference
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable; do not silently run a slow CPU audition")
    free_bytes, _ = torch.cuda.mem_get_info()
    cpu_reference_encoder = args.reference_encoder_device == "cpu" or (
        args.reference_encoder_device == "auto" and free_bytes < 6 * 1024 ** 3
    )
    torch.set_num_threads(6)
    # The reference encoder runs once per reference. Offload it when the user's
    # other programs occupy VRAM; keep the speech generators on CUDA. This
    # audition-local adapter does not edit the downloaded upstream source.
    AuditionTTS = model_class_with_reference_device(inference, torch, cpu_reference_encoder)
    random.seed(20261013)
    np.random.seed(20261013)
    torch.manual_seed(20261013)
    torch.cuda.manual_seed_all(20261013)
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    print(json.dumps({"freeGpuMiBBeforeLoad": free_bytes / 1024 ** 2,
                      "referenceEncoderDevice": "cpu" if cpu_reference_encoder else "cuda"}), flush=True)
    model = AuditionTTS(
        cfg_path=str(REPO / "checkpoints/config.yaml"), model_dir=str(REPO / "checkpoints"),
        device="cuda:0", use_bf16=True, use_cuda_kernel=False,
        use_deepspeed=False, use_accel=False, use_torch_compile=False, use_qwen_emo=False,
    )
    loaded_seconds = time.perf_counter() - started
    torch.cuda.empty_cache()
    peaks = []

    def leave_audio_headroom(_module, _arguments, value):
        # Apply gain before upstream converts/clamps the float waveform to PCM.
        # Scaling an already saturated WAV would not recover its clipped peaks.
        if not torch.isfinite(value).all():
            raise RuntimeError("Non-finite vocoder output")
        raw_peak = float(value.detach().abs().max().item())
        gain = min(1.0, 0.9 / max(raw_peak, 1e-8))
        peaks.append({"rawPeak": raw_peak, "gain": gain})
        return value * gain

    model.bigvgan.register_forward_hook(leave_audio_headroom)
    output.mkdir(parents=True)
    cases = [
        ("plain", "晚上好，我是小鲸鱼。今天不唱歌了，我们来聊聊天。你说，我在听。", None),
        ("happy", "你来啦！我刚才还在等你呢，今天有什么好玩的事情？", [0.35, 0, 0, 0, 0, 0, 0, 0]),
    ]
    if case_file:
        import re
        requested = json.loads(case_file.read_text(encoding='utf-8-sig'))
        if not isinstance(requested, list) or not 1 <= len(requested) <= 4:
            raise ValueError('Use 1–4 bounded audition sentences')
        cases = []
        for item in requested:
            if not isinstance(item, dict) or not isinstance(item.get('name'), str) or not re.fullmatch(r'[a-z0-9-]{1,40}', item['name']):
                raise ValueError('Invalid audition name')
            if not isinstance(item.get('text'), str) or not 1 <= len(item['text'].strip()) <= 200:
                raise ValueError('Invalid audition text')
            cases.append((item['name'], item['text'].strip(), None))
        if len({name for name, _, _ in cases}) != len(cases):
            raise ValueError('Duplicate audition names')
    results = []
    for name, text, emotion in cases:
        target = output / (name + ".wav")
        torch.cuda.synchronize()
        torch.cuda.empty_cache()
        peak_start = len(peaks)
        start = time.perf_counter()
        model.infer(spk_audio_prompt=str(reference), text=text, lang="ZH", output_path=str(target),
                    emo_vector=emotion, use_emo_text=False, use_random=False, verbose=False,
                    duration_factor=1.0, max_text_tokens_per_segment=120)
        torch.cuda.synchronize()
        elapsed = time.perf_counter() - start
        audio, rate = sf.read(str(target), always_2d=True)
        peak = float(np.max(np.abs(audio)))
        if audio.shape[0] == 0 or not np.isfinite(audio).all() or np.mean(audio ** 2) < 1e-10:
            raise RuntimeError("Invalid or silent synthesis: " + name)
        result = {"case": name, "text": text, "emotionVector": emotion,
                  "path": str(target), "sampleRate": rate,
                  "durationSeconds": audio.shape[0] / rate,
                  "fullSynthesisSeconds": elapsed, "peak": peak,
                  "nearClippedFraction": float(np.mean(np.abs(audio) >= 0.999)),
                  "vocoderHeadroom": peaks[peak_start:],
                  "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
        if result["nearClippedFraction"]:
            raise RuntimeError("Generated audio still touches full scale")
        results.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
    report = {
        "model": "IndexTTS-2.5", "sourceCommit": subprocess.check_output(
            ["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True).strip(),
        "reference": str(reference), "referenceDurationSeconds": reference_duration,
        "referenceSha256": hashlib.sha256(reference.read_bytes()).hexdigest(),
        "referenceCropApplied": False, "userMarkedHarmonySeconds": None if case_file else [7, 8],
        "cudaDevice": torch.cuda.get_device_name(0), "torchVersion": torch.__version__,
        "bf16": True, "qwenEmotionLoaded": False, "modelLoadSeconds": loaded_seconds,
        "referenceEncoderDevice": "cpu" if cpu_reference_encoder else "cuda",
        "peakAllocatedMiB": torch.cuda.max_memory_allocated() / 1024 ** 2,
        "cases": results, "uploads": False, "cohostVoiceChanged": False,
        "timingScope": "Full file synthesis, not streaming first sound or live conversation",
        "auditoryQuality": "Requires user audition; assistant audio input is unavailable",
    }
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Audition complete", flush=True)


if __name__ == "__main__":
    main()
