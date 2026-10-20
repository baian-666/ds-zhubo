"""Bounded local Aqua V3 speed trial with a fictional speech reference."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'data/aqua-tts'
UPSTREAM = RUNTIME / 'GPT-SoVITS'
PRETRAIN = UPSTREAM / 'GPT_SoVITS/pretrained_models'
CASES = {
    'short': '我在听，你继续。',
    'medium': '你来啦，今天有什么好玩的事情？',
    'long': '等等，这个梗我接住了。你是不是又偷偷摸鱼了？别急，我先听你把故事讲完，再来帮你接下一句。',
    'qwen-conversation': '你来啦，今天有什么好玩的事情？等等，这个梗我接住了。你是不是又偷偷摸鱼了？',
}
REF_TEXT = '晚上好呀，我是小鲸鱼。别看我个头小，接梗可是很认真的。你负责讲故事，我负责让直播间热闹起来。'

def configure():
    os.environ.update({
        'GPT_SOVITS_HOME': str(UPSTREAM), 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
        'NLTK_DATA': str(ROOT / 'data/indextts/nltk-data'), 'NUMBA_CACHE_DIR': str(RUNTIME / 'numba-cache'),
        'BIGVGAN_CACHE_ROOT': str(RUNTIME / 'bigvgan-cache'), 'BIGVGAN_USE_CUDA_KERNEL': '0',
        'TTS_OUTPUT_LANGUAGE': '中文', 'AQUATTS_T2S_FLASH_ATTN': '0',
        'ENABLE_CUDA_GRAPH': '1', 'ENABLE_CUDA_GRAPH_PRECAPTURE': '1',
        'bert_path': str(PRETRAIN / 'chinese-roberta-wwm-ext-large'),
    })
    # This PC lacks MSVC. Use upstream-compatible pure Python jieba only in this
    # trial process; do not modify either source checkout or the Index environment.
    import jieba
    import jieba.posseg
    sys.modules['jieba_fast'] = jieba
    sys.modules['jieba_fast.posseg'] = jieba.posseg
    os.chdir(UPSTREAM)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--reference', type=Path, default=ROOT / 'data/voice-audition/claire.wav')
    parser.add_argument('--repeats', type=int, default=3)
    args = parser.parse_args()
    output, reference = args.output.resolve(), args.reference.resolve()
    if not output.is_relative_to((ROOT / 'data').resolve()) or output.exists():
        raise ValueError('Choose a new output directory inside ignored data')
    if not 1 <= args.repeats <= 3: raise ValueError('Use 1–3 bounded repeats')
    output.mkdir(parents=True)
    original_hash = hashlib.sha256(reference.read_bytes()).hexdigest()
    configure()
    import numpy as np
    import soundfile as sf
    import torch
    from aquatts import TTSInferencer
    torch.set_num_threads(6)
    start = time.perf_counter()
    model = TTSInferencer(device='cuda', language='zh_CN',
        gpt_path=str(PRETRAIN / 's1v3.ckpt'), sovits_path=str(PRETRAIN / 's2Gv3.pth'),
        cuda_graph_preset='full', use_flash_attn=False)
    loaded = time.perf_counter() - start
    report = {
        'kind': 'Local Aqua V3 PCM readiness, excluding ASR/LLM/HTTP/playback',
        'source_revisions': json.loads((RUNTIME / 'source-revisions.json').read_text(encoding='utf-8-sig')),
        'gpu': torch.cuda.get_device_name(0), 'torch': torch.__version__, 'loadSeconds': loaded,
        'reference': str(reference), 'referenceSha256': original_hash, 'referenceText': REF_TEXT,
        'configuration': {'model':'official GPT-SoVITS V3 base weights', 'half':True,
            'staticKV':True, 'cudaGraphs':'full', 'flashAttention':False, 'bigvganCUDAKernel':False,
            'frontend':'pure Python jieba alias; G2PW CPU', 'preset':'fast', 'chunkSeconds':0.25,
            'segmentation':'punctuation', 'CPUThreads':6}, 'trials': [],
    }
    def save():
        (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    def measure(label, text, seed, warm=False):
        random.seed(seed); np.random.seed(seed); torch.manual_seed(seed); torch.cuda.manual_seed_all(seed)
        torch.cuda.synchronize()
        beginning = time.perf_counter(); blocks=[]; first=None; voiced=None; arrival=[]; rate=None
        for sample_rate, chunk, _ in model.infer_stream(text=text, ref_audio_path=str(reference),
            prompt_text=REF_TEXT, text_language='中文', prompt_language='中文', preset='fast',
            enable_cuda_graph=True, enable_static_kv=True, chunk_size_seconds=0.25):
            if chunk is None or not len(chunk): continue
            delta = time.perf_counter() - beginning
            chunk = np.asarray(chunk, dtype=np.float32).reshape(-1)
            if not np.isfinite(chunk).all(): raise RuntimeError('Nonfinite PCM')
            if rate is not None and rate != sample_rate: raise RuntimeError('Sample rate changed')
            rate=sample_rate; first = delta if first is None else first
            frame=max(1,int(rate*0.01))
            if voiced is None and any(np.sqrt(np.mean(chunk[i:i+frame]**2)) >= 10**(-45/20) for i in range(0,len(chunk)-frame+1,frame)):
                voiced=delta
            blocks.append(chunk.copy()); arrival.append({'atSeconds':delta, 'samples':len(chunk)})
        if not blocks or voiced is None: raise RuntimeError('No active PCM; synthesis not validated')
        total=time.perf_counter()-beginning; wave=np.concatenate(blocks)
        name=label+('-warm' if warm else '')+'.wav'
        sf.write(output/name, wave, rate, subtype='PCM_16')
        result={'label':label,'text':text,'seed':seed,'warmup':warm,'firstPcmSeconds':first,
            'firstActiveChunkSeconds':voiced,'totalSeconds':total,'audioSeconds':len(wave)/rate,
            'sampleRate':rate,'chunks':len(blocks),'peak':float(np.max(np.abs(wave))),
            'arrival':arrival,'file':name,'sha256':hashlib.sha256((output/name).read_bytes()).hexdigest()}
        report['trials'].append(result); save()
        print(json.dumps({k:result[k] for k in ['label','warmup','firstPcmSeconds','firstActiveChunkSeconds','totalSeconds','audioSeconds','chunks']},ensure_ascii=False),flush=True)
    save()
    for label,text in CASES.items():
        measure(label,text,20261013,warm=True)
    for repeat in range(args.repeats):
        for label,text in CASES.items(): measure(f'{label}-{repeat+1}',text,20261014+repeat)
    report['referenceUnchanged'] = hashlib.sha256(reference.read_bytes()).hexdigest() == original_hash
    report['peakAllocatedGB'] = torch.cuda.max_memory_allocated()/1024**3
    report['complete'] = True; save()

if __name__ == '__main__': main()
