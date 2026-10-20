"""Real-time original PCM diagnostic for local streaming ASR; no injected text."""
import hashlib
import json
import pathlib
import sys
import time
import wave

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'data/asr-local/runtime'))
import numpy as np
import sherpa_onnx

model = ROOT / 'data/asr-local/sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01'
label = sys.argv[1]
output = ROOT / 'data' / (label + '.json')
if output.exists() or not all(c.isalnum() or c == '-' for c in label):
    raise RuntimeError('Use a new diagnostic label')
started = time.perf_counter()
recognizer = sherpa_onnx.OnlineRecognizer.from_zipformer2_ctc(
    model=str(model / 'model.int8.onnx'), tokens=str(model / 'tokens.txt'),
    num_threads=2, provider='cpu', enable_endpoint_detection=False,
)
report = {'kind': 'Local original PCM, paced at real time. Provider diagnostic, not end-to-end acceptance.',
          'version': sherpa_onnx.__version__, 'loadMs': round((time.perf_counter() - started) * 1000), 'calls': []}
for name in ['backchannel-input', 'input', 'resume-input']:
    file = ROOT / 'data/listening-audio-trial' / (name + '.wav')
    with wave.open(str(file)) as wav:
        assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (16000, 1, 2)
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    spans = []
    for at in range(0, len(samples) - 160, 160):
        if np.sqrt(np.mean(samples[at:at+160] ** 2)) <= 0.004:
            continue
        if spans and at - spans[-1][1] < 32000:
            spans[-1][1] = at + 160
        else:
            spans.append([at, at + 160])
    if name == 'input':
        first, last = spans[-1][1] - 96000, spans[-1][1]
    else:
        first, last = spans[1]
    first = max(0, first - 5120)
    audio = samples[first:min(len(samples), last + 10400)]
    stream = recognizer.create_stream()
    call = {'input': name, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'startSample': first,
            'endSample': first + len(audio), 'events': [], 'decodeMs': 0}
    start = time.perf_counter()
    previous = ''
    for at in range(0, len(audio), 512):
        stream.accept_waveform(16000, audio[at:at+512])
        decode = time.perf_counter()
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        call['decodeMs'] += (time.perf_counter() - decode) * 1000
        text = recognizer.get_result(stream)
        if text != previous:
            call['events'].append({'ms': round((time.perf_counter() - start) * 1000), 'text': text})
            previous = text
        time.sleep(max(0, start + min(at + 512, len(audio)) / 16000 - time.perf_counter()))
    stream.input_finished()
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    call['text'] = recognizer.get_result(stream)
    call['finalAfterVoiceMs'] = round((time.perf_counter() - start) * 1000 - (last - first) / 16)
    report['calls'].append(call)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(call, ensure_ascii=False), flush=True)
