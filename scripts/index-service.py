"""Local IndexTTS-2.5 service. Cached reference, original quality, clause PCM output."""
import argparse
import base64
import contextlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import select
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT / "data/indextts/repo"
PROFILE = ROOT / "data/indextts/reference.json"


def voice_settings(reference, profile_path=PROFILE):
    """Read the selected voice once at startup; explicit other references stay independent."""
    settings = {"name": "local-reference", "emotion_audio": None, "emotion_alpha": 1.0, "contextual": False}
    if not profile_path.exists():
        return settings
    profile = json.loads(profile_path.read_text(encoding="utf-8-sig"))
    if not isinstance(profile, dict) or not isinstance(profile.get("audio"), str):
        raise ValueError("Invalid Index voice profile")
    if Path(profile["audio"]).resolve() != reference.resolve():
        return settings
    name = profile.get("name", "local-reference")
    if not isinstance(name, str) or not name.strip() or len(name) > 80:
        raise ValueError("Invalid Index voice name")
    settings["name"] = name
    if not isinstance(profile.get("contextualEmotion", False), bool):
        raise ValueError("Invalid Index contextual emotion setting")
    settings["contextual"] = profile.get("contextualEmotion", False)
    emotion = profile.get("emotion")
    if emotion is not None:
        if not isinstance(emotion, dict) or not isinstance(emotion.get("audio"), str) or not emotion["audio"].strip():
            raise ValueError("Invalid Index emotion reference")
        audio = Path(emotion["audio"]).resolve()
        alpha = emotion.get("alpha", 1.0)
        if isinstance(alpha, bool) or not isinstance(alpha, (int, float)) or not math.isfinite(alpha) or not 0 <= alpha <= 1:
            raise ValueError("Index emotion alpha must be between 0 and 1")
        if not audio.is_file():
            raise ValueError("Index emotion reference does not exist")
        settings.update(emotion_audio=audio, emotion_alpha=float(alpha))
    return settings


def emotion_parameters(voice, style=None):
    """Bounded per-request presets; no request can provide files or raw model controls."""
    style = style if isinstance(style, str) and style in ("neutral", "happy", "surprised", "gentle") else "neutral"
    if not voice["contextual"] or style == "happy":
        return {"emo_audio_prompt": str(voice["emotion_audio"]) if voice["emotion_audio"] else None,
                "emo_alpha": voice["emotion_alpha"], "emo_vector": None}
    vector = [0.0] * 8
    # Calm is deliberately stronger for reassurance; surprise remains restrained.
    vector[6 if style == "surprised" else 7] = {"neutral": 0.45, "surprised": 0.25, "gentle": 0.65}[style]
    return {"emo_audio_prompt": None, "emo_alpha": 1.0, "emo_vector": vector}


def clauses(text):
    """Group tiny interjections with the next clause. Never cut words to meet a timer."""
    pending = ""
    for part in re.findall(r"[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+", text):
        pending += part
        if len(re.sub(r"\W", "", pending)) >= 8:
            yield pending
            pending = ""
    if pending:
        yield pending


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    args = parser.parse_args()
    reference = args.reference.resolve()
    voice = voice_settings(reference)
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
        raise RuntimeError("Index needs 5 GiB free VRAM. Stop other local speech engines before starting it.")
    for audio in (reference, voice["emotion_audio"]):
        if audio is not None and not 1 <= sf.info(audio).duration <= 15:
            raise ValueError("Use references of 1–15 seconds")
    spec = importlib.util.spec_from_file_location("audition", ROOT / "scripts/indextts-audition.py")
    audition = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audition)
    cls = audition.model_class_with_reference_device(inference, torch, True)
    torch.set_num_threads(6)
    sink = open(os.devnull, "w")
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        model = cls(cfg_path=str(REPO / "checkpoints/config.yaml"), model_dir=str(REPO / "checkpoints"),
                    device="cuda:0", use_bf16=True, use_cuda_kernel=False, use_deepspeed=False,
                    use_accel=False, use_torch_compile=False, use_qwen_emo=False)
        def headroom(_module, _args, wav):
            if not torch.isfinite(wav).all():
                raise RuntimeError("Non-finite audio")
            return wav * min(1.0, 0.9 / max(float(wav.abs().max()), 1e-8))
        model.bigvgan.register_forward_hook(headroom)
        def generate(text, style=None):
            emotion = emotion_parameters(voice, style)
            for part in clauses(text):
                for chunk in model.infer(spk_audio_prompt=str(reference), text=part, output_path=None, lang="ZH",
                                         stream_return=True, interval_silence=0, max_text_tokens_per_segment=120,
                                         use_emo_text=False, use_random=False,
                                         num_beams=3, duration_factor=1.0, verbose=False, **emotion):
                    if not isinstance(chunk, list) and chunk is not None and chunk.numel():
                        yield chunk.numpy().reshape(-1)
        for _ in generate("你来啦！我是小鲸鱼。今天有什么好玩的事情？"):
            pass
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def local(self):
            return self.client_address[0] == "127.0.0.1" and self.headers.get("Host") == "127.0.0.1:8794" and not self.headers.get("Origin")
        def disconnected(self):
            try:
                return bool(select.select([self.connection], [], [], 0)[0]) and not self.connection.recv(1, socket.MSG_PEEK)
            except OSError:
                return True
        def answer(self, status, value):
            body = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def do_GET(self):
            if not self.local():
                return self.answer(403, {})
            if self.path != "/health":
                return self.answer(404, {})
            self.answer(200, dict(ok=True, engine="index-2.5", sampleRate=22050, busy=lock.locked(),
                                  reference=voice["name"], emotionReference=voice["emotion_audio"] is not None,
                                  emotionAlpha=voice["emotion_alpha"], styleMode="contextual" if voice["contextual"] else "fixed",
                                  defaultStyle="neutral" if voice["contextual"] else "configured",
                                  beams=3, cfmSteps=25, output="clauses"))
        def do_POST(self):
            if not self.local():
                return self.answer(403, {})
            if self.path != "/tts":
                return self.answer(404, {})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 1 <= size <= 4096:
                    raise ValueError("size")
                self.connection.settimeout(10)
                payload = json.loads(self.rfile.read(size))
                text = payload["text"]
                style = payload.get("style")
                if not isinstance(text, str) or not text.strip() or len(text) > 500:
                    raise ValueError("text")
            except (ValueError, KeyError, TypeError, OSError):
                return self.answer(400, {})
            if not lock.acquire(blocking=False):
                return self.answer(409, {})
            start, first, samples, generator = time.perf_counter(), None, 0, None
            try:
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                def emit(value):
                    self.wfile.write((json.dumps(value) + "\n").encode())
                    self.wfile.flush()
                with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                    generator = generate(text, style)
                    while not self.disconnected():
                        chunk = next(generator, None)
                        if chunk is None:
                            break
                        if self.disconnected():
                            return
                        if not np.isfinite(chunk).all():
                            raise ValueError("audio")
                        samples += len(chunk)
                        if samples > 3_000_000:
                            raise ValueError("duration")
                        first = time.perf_counter() - start if first is None else first
                        emit(dict(type="audio", sampleRate=22050,
                                  pcm=base64.b64encode(np.clip(chunk, -32767, 32767).astype("<i2").tobytes()).decode()))
                if self.disconnected():
                    return
                if first is None:
                    raise ValueError("empty")
                emit(dict(type="done", firstPcmMs=first * 1000, totalMs=(time.perf_counter() - start) * 1000))
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            except Exception:
                try:
                    emit(dict(type="error", message="Local speech synthesis failed"))
                except (OSError, UnboundLocalError):
                    pass
            finally:
                if generator is not None:
                    generator.close()
                lock.release()
    server = ThreadingHTTPServer(("127.0.0.1", 8794), Handler)
    print("IndexTTS-2.5 ready: http://127.0.0.1:8794/health", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        sink.close()


if __name__ == "__main__":
    main()
