"""Download pinned public Aqua V3 trial assets into ignored data; no user uploads."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1] / 'data/aqua-tts'
LOCK = json.loads((Path(__file__).resolve().parents[1] / 'aqua.lock.json').read_text(encoding='utf-8'))
PRETRAIN = ROOT / 'GPT-SoVITS/GPT_SoVITS/pretrained_models'
SPECS = {
    'lj1995/GPT-SoVITS': (PRETRAIN, ['s1v3.ckpt', 's2Gv3.pth',
        'chinese-roberta-wwm-ext-large/config.json', 'chinese-roberta-wwm-ext-large/tokenizer.json',
        'chinese-roberta-wwm-ext-large/pytorch_model.bin', 'chinese-hubert-base/config.json',
        'chinese-hubert-base/preprocessor_config.json', 'chinese-hubert-base/pytorch_model.bin']),
    'nvidia/bigvgan_v2_24khz_100band_256x': (PRETRAIN / 'models--nvidia--bigvgan_v2_24khz_100band_256x',
        ['LICENSE', 'config.json', 'bigvgan_generator.pt']),
}

def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as file:
        while block := file.read(8*1024*1024): result.update(block)
    return result.hexdigest()

def download(task):
    repo, revision, item, target = task
    expected = item.get('lfs', {}).get('sha256')
    if target.exists():
        checksum = digest(target)
        if target.stat().st_size != item['size'] or (expected and checksum != expected):
            raise RuntimeError('Existing asset mismatch: ' + item['rfilename'])
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(target.name + '.partial')
        for attempt in range(3):
            try:
                offset = partial.stat().st_size if partial.exists() else 0
                url = f'https://huggingface.co/{repo}/resolve/{revision}/{item["rfilename"]}?download=true&fresh={time.time_ns()}'
                request = urllib.request.Request(url, headers={'Range': f'bytes={offset}-'} if offset else {})
                with urllib.request.urlopen(request, timeout=120) as response:
                    resumed = offset and response.status == 206
                    done = offset if resumed else 0
                    reported = done
                    with partial.open('ab' if resumed else 'wb') as file:
                        while block := response.read(8*1024*1024):
                            file.write(block); done += len(block)
                            if done-reported >= 128*1024*1024:
                                print(f'{item["rfilename"]}: {done/1e6:.0f}/{item["size"]/1e6:.0f} MB', flush=True); reported=done
                if partial.stat().st_size != item['size']: raise RuntimeError('Incomplete asset')
                checksum = digest(partial)
                if expected and checksum != expected: raise RuntimeError('Checksum mismatch')
                partial.rename(target); break
            except Exception as error:
                print(f'Retry {item["rfilename"]}: {type(error).__name__}', flush=True)
                if attempt == 2: raise
                time.sleep(2)
    print('Ready: ' + item['rfilename'], flush=True)
    return {'repo': repo, 'revision': revision, 'file': item['rfilename'], 'sha256': checksum, 'bytes': target.stat().st_size}

def main():
    metadata = ROOT / 'model-metadata'; metadata.mkdir(exist_ok=True)
    tasks = []
    for repo, (folder, names) in SPECS.items():
        revision = next(item['revision'] for item in LOCK['models'] if item.get('repo') == repo)
        saved = metadata / (repo.replace('/', '__') + '.json')
        if saved.exists(): info = json.loads(saved.read_text())
        else:
            with urllib.request.urlopen('https://huggingface.co/api/models/' + repo + '/revision/' + revision + '?blobs=true', timeout=30) as response:
                info = json.load(response)
            saved.write_text(json.dumps(info, indent=2), encoding='utf-8')
        if info['sha'] != revision: raise ValueError('Model revision differs from lock')
        for name in names:
            item = next(item for item in info['siblings'] if item['rfilename'] == name)
            tasks.append((repo, info['sha'], item, folder/name))
    print(f'Public assets: {sum(task[2]["size"] for task in tasks)/1e9:.2f} GB', flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        records = list(pool.map(download, tasks))
    # This is the model source selected by the pinned GPT-SoVITS frontend itself.
    archive = ROOT / 'G2PWModel_1.1.zip'
    destination = ROOT / 'GPT-SoVITS/GPT_SoVITS/text'
    if not (destination / 'G2PWModel/g2pW.onnx').exists():
        if not archive.exists():
            with urllib.request.urlopen('https://www.modelscope.cn/models/kamiorinn/g2pw/resolve/master/G2PWModel_1.1.zip', timeout=120) as response, archive.with_suffix('.partial').open('wb') as file:
                while block := response.read(8*1024*1024): file.write(block)
            archive.with_suffix('.partial').rename(archive)
        expected_archive = next(item['sha256'] for item in LOCK['models'] if item.get('pinned') is False)
        if digest(archive) != expected_archive: raise ValueError('G2PW archive differs from recorded trial')
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                if not (destination / member.filename).resolve().is_relative_to(destination.resolve()):
                    raise ValueError('Unsafe archive member')
            bundle.extractall(destination)
        (destination / 'G2PWModel_1.1').rename(destination / 'G2PWModel')
    records.append({'source': 'GPT-SoVITS documented ModelScope G2PWModel_1.1.zip', 'sha256': digest(archive), 'bytes': archive.stat().st_size, 'pinned': False})
    (PRETRAIN / 'fast_langdetect').mkdir(exist_ok=True)
    (ROOT / 'model-files.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')

if __name__ == '__main__': main()
