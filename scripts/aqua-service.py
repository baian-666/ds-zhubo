"""Single-model loopback Aqua PCM service, using the validated isolated runtime."""
import argparse
import base64
import contextlib
import importlib.util
import json
import logging
import math
import os
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', type=Path, default=ROOT / 'data/voice-audition/claire.wav')
    parser.add_argument('--prompt-file', type=Path)
    parser.add_argument('--prompt-language', choices=['中文', '日文', '英文'], default='中文')
    parser.add_argument('--speed', type=float, default=0.9)
    parser.add_argument('--sample-steps', type=int, choices=[4, 8, 16, 32], default=16)
    args = parser.parse_args()
    if not math.isfinite(args.speed) or not 0.65 <= args.speed <= 1.25:
        parser.error('Speed must be finite and between 0.65 and 1.25')
    spec = importlib.util.spec_from_file_location('aqua_trial', ROOT / 'scripts/aqua-speed.py')
    runtime = importlib.util.module_from_spec(spec); spec.loader.exec_module(runtime)
    runtime.configure()
    reference = args.reference.resolve()
    prompt = args.prompt_file.read_text(encoding='utf-8').strip() if args.prompt_file else runtime.REF_TEXT
    if not reference.is_file() or not prompt or len(prompt) > 500: raise ValueError('Reference and matching transcript required')
    import numpy as np
    import soundfile as sf
    import torch
    from aquatts import TTSInferencer
    audio, rate = sf.read(reference)
    if audio.ndim != 1 or not 3 <= len(audio)/rate <= 10: raise ValueError('Reference must be mono speech, 3–10 seconds')
    logging.disable(logging.CRITICAL)
    torch.set_num_threads(6)
    sink = open(os.devnull, 'w')
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        model = TTSInferencer(device='cuda', language='zh_CN', gpt_path=str(runtime.PRETRAIN/'s1v3.ckpt'),
            sovits_path=str(runtime.PRETRAIN/'s2Gv3.pth'), cuda_graph_preset='full', use_flash_attn=False)
        # Load reference/frontend caches before the first live reply.
        for _ in model.infer_stream(text='我在听，你继续。', ref_audio_path=str(reference), prompt_text=prompt,
            text_language='中文', prompt_language=args.prompt_language, speed=args.speed,
            sample_steps=args.sample_steps, enable_cuda_graph=True,
            enable_static_kv=True, chunk_size_seconds=0.25): pass
    lock = threading.Lock()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def local(self):
            return self.client_address[0] == '127.0.0.1' and self.headers.get('Host') == '127.0.0.1:8793' and not self.headers.get('Origin')
        def answer(self, status, payload):
            body=json.dumps(payload).encode(); self.send_response(status); self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
        def do_GET(self):
            if not self.local(): return self.answer(403, {'message':'Local server only'})
            if self.path != '/health': return self.answer(404, {})
            self.answer(200, {'ok':True,'engine':'aqua-v3','sampleRate':24000,'reference':'local-reference','busy':lock.locked(),
                'promptLanguage':args.prompt_language,'speed':args.speed,'sampleSteps':args.sample_steps})
        def do_POST(self):
            if not self.local(): return self.answer(403, {'message':'Local server only'})
            if self.path != '/tts': return self.answer(404, {})
            size=int(self.headers.get('Content-Length','0'))
            if not 1 <= size <= 4096: return self.answer(400, {'message':'Invalid request size'})
            try: body=json.loads(self.rfile.read(size)); text=body['text']
            except (ValueError,KeyError,TypeError): return self.answer(400, {'message':'Invalid request'})
            if not isinstance(text,str) or not text.strip() or len(text)>500: return self.answer(400, {'message':'Invalid text'})
            if not lock.acquire(blocking=False): return self.answer(409, {'message':'Speech engine busy'})
            beginning=time.perf_counter(); first=None; samples=0; generator=None
            try:
                self.send_response(200); self.send_header('Content-Type','application/x-ndjson'); self.send_header('Cache-Control','no-store'); self.end_headers()
                def emit(value): self.wfile.write((json.dumps(value)+'\n').encode()); self.wfile.flush()
                with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                    generator=model.infer_stream(text=text,ref_audio_path=str(reference),prompt_text=prompt,
                        text_language='中文',prompt_language=args.prompt_language,speed=args.speed,
                        sample_steps=args.sample_steps,enable_cuda_graph=True,
                        enable_static_kv=True,chunk_size_seconds=0.25)
                    for rate,chunk,_ in generator:
                        if chunk is None or not len(chunk): continue
                        pcm=np.asarray(chunk,dtype=np.float32).reshape(-1)
                        if not np.isfinite(pcm).all() or rate!=24000: raise ValueError('Invalid PCM')
                        samples+=len(pcm)
                        if samples>3_000_000: raise ValueError('Speech too long')
                        first=time.perf_counter()-beginning if first is None else first
                        encoded=(np.clip(pcm,-1,1)*32767).astype('<i2').tobytes()
                        emit({'type':'audio','sampleRate':rate,'pcm':base64.b64encode(encoded).decode()})
                if first is None: raise ValueError('No audio')
                emit({'type':'done','firstPcmMs':first*1000,'totalMs':(time.perf_counter()-beginning)*1000,'audioSeconds':samples/24000})
            except (BrokenPipeError,ConnectionResetError,ConnectionAbortedError): pass
            except Exception:
                try: emit({'type':'error','message':'Local speech synthesis failed'})
                except (OSError,UnboundLocalError): pass
            finally:
                if generator is not None: generator.close()
                lock.release()
    server=ThreadingHTTPServer(('127.0.0.1',8793),Handler)
    print('Aqua live speech ready: http://127.0.0.1:8793/health',flush=True)
    try: server.serve_forever()
    finally: server.server_close(); sink.close()

if __name__=='__main__': main()
