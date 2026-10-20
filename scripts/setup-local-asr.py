"""Install the opt-in streaming ASR trial in project data, never system Python."""
import hashlib
import pathlib
import subprocess
import sys
import tarfile
import urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
directory = root / 'data/asr-local'
directory.mkdir(parents=True, exist_ok=True)
name = 'sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01'
digest = 'b3b309f7ce4a737195fcc6963ea19b0653a7d3401580af5ae0d3e284cbb71f0b'
archive = directory / (name + '.tar.bz2')
if not archive.exists():
    temporary = archive.with_suffix('.download')
    urllib.request.urlretrieve('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/' + archive.name, temporary)
    if hashlib.sha256(temporary.read_bytes()).hexdigest() != digest:
        raise RuntimeError('Model archive checksum mismatch; download retained for inspection')
    temporary.replace(archive)
if hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
    raise RuntimeError('Model archive checksum mismatch')
if not (directory / name / 'model.int8.onnx').exists():
    with tarfile.open(archive) as model:
        model.extractall(directory, filter='data')
subprocess.run([sys.executable, '-m', 'pip', 'install', '--only-binary=:all:',
                '--target', str(directory / 'runtime'), '-r', str(root / 'scripts/local-asr-requirements.txt')], check=True)
print('Local streaming ASR trial dependencies prepared:', directory)
