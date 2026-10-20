"""Read-only resource sampling of this project's local ASR worker during real audio."""
import argparse
import json
import pathlib
import time
import psutil

parser = argparse.ArgumentParser()
parser.add_argument("label")
parser.add_argument("--seconds", type=int, default=180)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parent.parent
if not args.label or not all(c.isalnum() or c == "-" for c in args.label):
    raise ValueError("Use a simple label")
output = root / "data" / (args.label + "-resources.json")
stop = root / "data" / (args.label + "-resources.stop")
if output.exists() or stop.exists():
    raise ValueError("Use a fresh label")
workers = {}
report = {"kind": "Sampled local ASR worker processes during actual microphone replay",
          "logicalCpus": psutil.cpu_count(), "sampleIntervalMs": 500, "workers": workers}
started = time.monotonic()
while time.monotonic() - started < args.seconds and not stop.exists():
    for process in psutil.process_iter(["pid", "name"]):
        if not (process.info["name"] or "").lower().startswith("python"):
            continue
        try:
            if not any(pathlib.Path(arg).resolve() == root / "scripts/local-streaming-asr.py"
                       for arg in process.cmdline()[1:] if arg.endswith("local-streaming-asr.py")):
                continue
            identity = str(process.pid)
            cpu = process.cpu_times()
            memory = process.memory_info()
            sample = {"elapsedMs": round((time.monotonic() - started) * 1000),
                      "cpuSeconds": cpu.user + cpu.system, "rssMiB": memory.rss / 1048576,
                      "privateMiB": getattr(memory, "private", 0) / 1048576}
            worker = workers.setdefault(identity, {"samples": []})
            previous = worker["samples"][-1] if worker["samples"] else None
            if previous:
                sample["oneCorePercent"] = 100000 * (sample["cpuSeconds"] - previous["cpuSeconds"]) / max(1, sample["elapsedMs"] - previous["elapsedMs"])
                sample["machinePercent"] = sample["oneCorePercent"] / report["logicalCpus"]
            worker["samples"].append(sample)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    time.sleep(0.5)
for worker in workers.values():
    samples = worker["samples"]
    rates = sorted(s["machinePercent"] for s in samples if "machinePercent" in s)
    worker["summary"] = {
        "samples": len(samples), "peakRssMiB": max(s["rssMiB"] for s in samples),
        "peakPrivateMiB": max(s["privateMiB"] for s in samples),
        "meanMachinePercent": sum(rates) / len(rates) if rates else None,
        "p95MachinePercent": rates[min(len(rates)-1, int(len(rates)*0.95))] if rates else None,
        "peakMachinePercent": max(rates) if rates else None,
    }
output.write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps({"workers": {pid: value["summary"] for pid, value in workers.items()},
                  "logicalCpus": report["logicalCpus"]}))
