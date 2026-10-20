"""Bounded stdin/stdout worker. All input is real PCM; no network or microphone."""
import argparse
import base64
import json
import pathlib
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--runtime-dir', required=True)
parser.add_argument('--model-dir', required=True)
args = parser.parse_args()
sys.path.insert(0, str(pathlib.Path(args.runtime_dir).resolve()))
import numpy as np
import sherpa_onnx

directory = pathlib.Path(args.model_dir)
recognizer = sherpa_onnx.OnlineRecognizer.from_zipformer2_ctc(
    model=str(directory / 'model.int8.onnx'), tokens=str(directory / 'tokens.txt'),
    num_threads=2, provider='cpu', enable_endpoint_detection=False,
)
streams = {}

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

emit({'type': 'ready'})
for line in sys.stdin:
    identity = None
    try:
        if len(line) > 30000:
            raise ValueError('Input too large')
        command = json.loads(line)
        identity, action = command['id'], command['type']
        if action == 'open':
            if identity in streams or len(streams) >= 3:
                raise ValueError('Too many streams')
            streams[identity] = {'stream': recognizer.create_stream(), 'text': '', 'bytes': 0}
            continue
        if action == 'cancel':
            streams.pop(identity, None)
            continue
        current = streams.get(identity)
        if not current:
            continue
        stream = current['stream']
        if action == 'audio':
            pcm = base64.b64decode(command['pcm'], validate=True)
            current['bytes'] += len(pcm)
            if not 2 <= len(pcm) <= 16384 or len(pcm) % 2 or current['bytes'] > 1760000:
                raise ValueError('Invalid PCM')
            stream.accept_waveform(16000, np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768)
        elif action == 'finish':
            # Decoder right-context padding, supplied only after the real VAD
            # endpoint. It flushes the last chunk, without a wall-clock sleep.
            stream.accept_waveform(16000, np.zeros(10240, dtype=np.float32))
            stream.input_finished()
        else:
            raise ValueError('Unknown command')
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        text = recognizer.get_result(stream)
        if len(text) > 2000:
            raise ValueError('Transcript too long')
        if action == 'finish':
            emit({'id': identity, 'type': 'final', 'text': text})
            streams.pop(identity, None)
        elif text != current['text']:
            current['text'] = text
            emit({'id': identity, 'type': 'partial', 'text': text})
    except Exception:
        if identity is not None:
            streams.pop(identity, None)
            emit({'id': identity, 'type': 'error'})
        else:
            raise
