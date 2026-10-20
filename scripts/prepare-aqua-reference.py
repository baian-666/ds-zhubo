"""Prepare a local Aqua reference from an explicitly selected speech interval.

No ASR, uploads, denoising or pitch changes. Existing outputs are protected.
Run with the installed Aqua interpreter; keep audio and transcripts in data.
"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--start', type=float, required=True)
    parser.add_argument('--end', type=float, required=True)
    parser.add_argument('--transcript-file', type=Path, required=True)
    parser.add_argument('--prompt-language', choices=['中文', '日文', '英文'], default='中文')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    if not output.is_relative_to((ROOT / 'data').resolve()):
        raise ValueError('Output must be inside ignored project data')
    if output.exists():
        raise FileExistsError('Choose a fresh reference directory')
    if not 0 <= args.start < args.end or not 3 <= args.end - args.start <= 10:
        raise ValueError('Select 3–10 seconds of complete speech')
    transcript = args.transcript_file.read_text(encoding='utf-8-sig').strip()
    if not transcript or len(transcript) > 500:
        raise ValueError('Matching transcript required')
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    from math import gcd
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    audio, rate = sf.read(source, always_2d=True)
    if args.end > len(audio) / rate:
        raise ValueError('Interval exceeds the source duration')
    mono = audio[round(args.start * rate):round(args.end * rate)].mean(axis=1)
    divisor = gcd(rate, 24000)
    mono = resample_poly(mono, 24000 // divisor, rate // divisor)
    peak, rms = float(np.max(np.abs(mono))), float(np.sqrt(np.mean(mono ** 2)))
    if not np.isfinite(mono).all() or peak >= 0.999 or rms < 0.001:
        raise ValueError('Nonfinite, clipping or silent reference')
    output.mkdir(parents=True)
    sf.write(output / 'reference.wav', mono, 24000, subtype='PCM_16')
    (output / 'prompt.txt').write_text(transcript + '\n', encoding='utf-8')
    report = {'source': str(source), 'sourceSha256': original_hash,
              'intervalSeconds': [args.start, args.end], 'seconds': len(mono) / 24000,
              'sampleRate': 24000, 'channels': 1, 'peak': peak, 'rms': rms,
              'processing': 'Contiguous crop, stereo average, resample to PCM16; no normalization/denoising/pitch change',
              'transcript': transcript, 'promptLanguage': args.prompt_language,
              'referenceSha256': hashlib.sha256((output / 'reference.wav').read_bytes()).hexdigest(),
              'originalUnchanged': hashlib.sha256(source.read_bytes()).hexdigest() == original_hash}
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    profile = {'audio': str(output / 'reference.wav'), 'promptFile': str(output / 'prompt.txt'),
               'promptLanguage': args.prompt_language}
    (output / 'profile.json').write_text(json.dumps(profile, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: report[key] for key in ['seconds', 'sampleRate', 'channels', 'peak', 'originalUnchanged']}))


if __name__ == '__main__':
    main()
