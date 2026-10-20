"""Offline MDX vocal-reference preparation, without changing the cohost runtime.

Needs NumPy/SciPy and ONNX Runtime. The input must be a 44.1 kHz stereo PCM16
WAV. Model configuration is checked against the UVR model-data fingerprint.
No network requests, audio uploads, executable pickle loading or overwrites.
"""
import argparse
import hashlib
import json
import math
import sys
import time
import wave
from pathlib import Path

import numpy as np
from scipy.fft import irfft, rfft
from scipy.signal import resample_poly


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "data/audio-toolchain/onnx"))
import onnxruntime as ort


def read_wav(path):
    with wave.open(str(path), "rb") as stream:
        if (stream.getframerate(), stream.getnchannels(), stream.getsampwidth()) != (44100, 2, 2):
            raise ValueError("Expected stereo 44.1 kHz PCM16 WAV")
        data = np.frombuffer(stream.readframes(stream.getnframes()), dtype="<i2")
    return data.reshape(-1, 2).T.astype(np.float32) / 32768


def write_wav(path, data, rate):
    if path.exists():
        raise FileExistsError(path)
    if not np.isfinite(data).all() or np.max(np.abs(data)) > 1:
        raise ValueError("Non-finite or clipping output")
    pcm = np.round(np.clip(data, -1, 32767 / 32768) * 32768).astype("<i2")
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(data.shape[0])
        stream.setsampwidth(2)
        stream.setframerate(rate)
        stream.writeframes(pcm.T.tobytes())


class Spectrogram:
    def __init__(self, nfft, hop):
        self.nfft, self.hop = nfft, hop
        # Periodic Hann, matching UVR's Torch STFT, with unnormalised FFT.
        self.window = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(nfft) / nfft)).astype(np.float32)

    def encode(self, audio):
        padded = np.pad(audio, ((0, 0), (self.nfft // 2, self.nfft // 2)), mode="reflect")
        frames = np.lib.stride_tricks.sliding_window_view(padded, self.nfft, axis=-1)[:, ::self.hop]
        spectrum = rfft(frames * self.window, axis=-1).transpose(0, 2, 1)
        return np.stack((spectrum[0].real, spectrum[0].imag,
                         spectrum[1].real, spectrum[1].imag))[None].astype(np.float32)

    def decode(self, packed):
        full = np.pad(packed[0], ((0, 0), (0, self.nfft // 2 + 1 - packed.shape[2]), (0, 0)))
        spectrum = np.stack((full[0] + 1j * full[1], full[2] + 1j * full[3]))
        frames = irfft(spectrum.transpose(0, 2, 1), n=self.nfft, axis=-1) * self.window
        count = frames.shape[1]
        length = self.nfft + (count - 1) * self.hop
        result, weight = np.zeros((2, length), np.float32), np.zeros(length, np.float32)
        for index in range(count):
            start = index * self.hop
            result[:, start:start + self.nfft] += frames[:, index]
            weight[start:start + self.nfft] += self.window ** 2
        result /= np.maximum(weight, 1e-8)
        return result[:, self.nfft // 2:-self.nfft // 2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", type=Path, default=ROOT / "data/audio-toolchain/models/UVR-MDX-NET-Voc_FT.onnx")
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError("Use a new output directory; existing outputs are protected")
    # All generated material remains inside the ignored project data directory.
    if not args.output.resolve().is_relative_to((ROOT / "data").resolve()):
        raise ValueError("Output must be inside project data")
    model_bytes = args.model.read_bytes()
    fingerprint = hashlib.md5(model_bytes[-10000 * 1024:]).hexdigest()
    catalog = json.loads((ROOT / "data/audio-toolchain/reference/mdx-model-data.json").read_text())
    config = catalog.get(fingerprint)
    if not config or config["primary_stem"] != "Vocals":
        raise ValueError("Unknown model or non-vocal primary stem")
    mix = read_wav(args.input)
    nfft, hop = config["mdx_n_fft_scale_set"], 1024
    dimf, frames = config["mdx_dim_f_set"], 2 ** config["mdx_dim_t_set"]
    chunk = hop * (frames - 1)
    transform = Spectrogram(nfft, hop)
    probe = np.random.default_rng(731).normal(0, 0.05, (2, chunk)).astype(np.float32)
    error = float(np.max(np.abs(transform.decode(transform.encode(probe)) - probe)))
    if error > 1e-5:
        raise ValueError(f"STFT reconstruction failed: {error}")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 6
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(args.model), sess_options=options, providers=["CPUExecutionProvider"])
    shape = session.get_inputs()[0].shape
    if shape[1:] != [4, dimf, frames]:
        raise ValueError(f"Unexpected model layout: {shape}")
    trim, generated = nfft // 2, chunk - nfft
    padding = generated + trim - (mix.shape[1] % generated)
    padded = np.pad(mix, ((0, 0), (trim, padding)))
    output, weights = np.zeros_like(padded), np.zeros(padded.shape[1], np.float32)
    step = int(chunk * 0.75)
    starts = list(range(0, padded.shape[1], step))
    started = time.perf_counter()
    print(json.dumps({"config": config, "chunks": len(starts), "stftRoundtripMaxError": error}), flush=True)
    for index, start in enumerate(starts):
        actual = min(chunk, padded.shape[1] - start)
        segment = np.pad(padded[:, start:start + actual], ((0, 0), (0, chunk - actual)))
        spectrum = transform.encode(segment)[:, :, :dimf]
        spectrum[:, :, :3] = 0
        # UVR's optional polarity averaging cancels some model bias.
        positive = session.run(None, {session.get_inputs()[0].name: spectrum})[0]
        negative = session.run(None, {session.get_inputs()[0].name: -spectrum})[0]
        vocal = transform.decode((positive - negative) * 0.5)[:, :actual]
        window = np.hanning(actual).astype(np.float32)
        output[:, start:start + actual] += vocal * window
        weights[start:start + actual] += window
        print(f"Chunk {index + 1}/{len(starts)} ({time.perf_counter() - started:.1f}s)", flush=True)
    vocals = (output / np.maximum(weights, 1e-8))[:, trim:trim + mix.shape[1]] * config["compensate"]
    accompaniment = mix - vocals
    if not np.isfinite(vocals).all():
        raise ValueError("Non-finite separated output")
    gain = min(1.0, 0.98 / max(float(np.max(np.abs(vocals))), float(np.max(np.abs(accompaniment))), 1e-8))
    reconstruction_error = float(np.max(np.abs(vocals + accompaniment - mix)))
    args.output.mkdir(parents=True)
    write_wav(args.output / "vocals.wav", vocals * gain, 44100)
    write_wav(args.output / "accompaniment.wav", accompaniment * gain, 44100)
    mono = resample_poly(np.mean(vocals, axis=0), 80, 147)[None] * gain
    if np.max(np.abs(mono)) > 0.98:
        mono *= 0.98 / np.max(np.abs(mono))
    write_wav(args.output / "vocals-reference-24k.wav", mono, 24000)
    for start in (8, 32):
        clip = mono[:, start * 24000:(start + 10) * 24000].copy()
        fade = min(1200, clip.shape[1] // 2)
        clip[:, :fade] *= np.linspace(0, 1, fade)
        clip[:, -fade:] *= np.linspace(1, 0, fade)
        write_wav(args.output / f"preview-{start:02d}-{start + 10:02d}.wav", clip, 24000)
    report = {
        "input": str(args.input.resolve()), "inputSha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
        "modelSha256": hashlib.sha256(model_bytes).hexdigest(), "modelFingerprint": fingerprint,
        "modelSource": "https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models",
        "config": config, "provider": session.get_providers(), "ortVersion": ort.__version__,
        "durationSeconds": mix.shape[1] / 44100, "elapsedSeconds": time.perf_counter() - started,
        "gain": gain, "stftRoundtripMaxError": error, "sumReconstructionMaxError": reconstruction_error,
        "vocalsRmsDb": float(20 * math.log10(max(float(np.sqrt(np.mean(vocals ** 2))), 1e-12))),
        "accompanimentRmsDb": float(20 * math.log10(max(float(np.sqrt(np.mean(accompaniment ** 2))), 1e-12))),
        "auditoryQuality": "Unverified; model outputs and numerical checks do not establish clean vocals",
        "previews": "Fixed excerpts, not selected by listening; 50ms edge fades only",
        "uploads": False, "cloningPerformed": False,
    }
    (args.output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
