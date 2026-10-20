"""Pinned Qwen 0.6B public assets for a local trial; no voice uploads."""
import concurrent.futures
import importlib.util
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'data/qwen-local'
LOCK = json.loads((ROOT / 'qwen-local.lock.json').read_text(encoding='utf-8'))


def main():
    # Reuse the existing range-resume, size and SHA256 checked public downloader.
    spec = importlib.util.spec_from_file_location('assets', ROOT / 'scripts/setup-aqua-models.py')
    assets = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(assets)
    model = LOCK['model']
    RUNTIME.mkdir(parents=True, exist_ok=True)
    saved = RUNTIME / 'model-metadata.json'
    if saved.exists():
        metadata = json.loads(saved.read_text(encoding='utf-8'))
    else:
        url = 'https://huggingface.co/api/models/' + model['repository'] + '/revision/' + model['revision'] + '?blobs=true'
        with urllib.request.urlopen(url, timeout=30) as response:
            metadata = json.load(response)
        saved.write_text(json.dumps(metadata, indent=2)+'\n', encoding='utf-8')
    if metadata['sha'] != model['revision']:
        raise ValueError('Qwen revision differs from lock')
    tasks = []
    for expected in model['files']:
        item = next(item for item in metadata['siblings'] if item['rfilename'] == expected['name'])
        if item['size'] != expected['bytes'] or (expected.get('sha256') and item['lfs']['sha256'] != expected['sha256']):
            raise ValueError('Qwen asset differs from lock')
        tasks.append((model['repository'], model['revision'], item, RUNTIME / 'model' / expected['name']))
    print(f'Pinned public Qwen assets: {sum(item[2]["size"] for item in tasks)/1e9:.2f} GB', flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        records = list(pool.map(assets.download, tasks))
    (RUNTIME / 'model-files.json').write_text(json.dumps(records, indent=2)+'\n', encoding='utf-8')
    wheel = RUNTIME / 'qwen_tts-0.1.1-py3-none-any.whl'
    if not wheel.exists():
        with urllib.request.urlopen(LOCK['runtime']['wheel'], timeout=30) as response:
            wheel.write_bytes(response.read())
    if assets.digest(wheel) != LOCK['runtime']['sha256']:
        raise ValueError('Qwen runtime wheel checksum differs')
    print('Qwen model and runtime checksums verified', flush=True)


if __name__ == '__main__':
    main()
