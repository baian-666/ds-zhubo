param([string]$Archive = 'D:\edge_download\大肥鱼.zip')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = Join-Path $taskRoot 'data/toolchains/node-v26.7.0-win-x64/node.exe'
try {
  $taskHealth = Invoke-RestMethod 'http://127.0.0.1:8790/healthz' -TimeoutSec 2
  if ($taskHealth.app -eq 'whale-compose-preview') { return }
} catch {}
$taskArchive = (Resolve-Path -LiteralPath $Archive).Path
if ($taskArchive.Contains('"')) { throw 'Invalid archive path.' }
$taskArgs = @('scripts/compose-preview.mjs', ('"' + $taskArchive + '"'))
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList $taskArgs -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRoot 'data/compose-preview.out.log') -RedirectStandardError (Join-Path $taskRoot 'data/compose-preview.err.log')
Set-Content -LiteralPath (Join-Path $taskRoot 'data/compose-preview.pid') -Value $taskProcess.Id
for ($taskTry=0; $taskTry -lt 30; $taskTry++) {
  Start-Sleep -Milliseconds 500
  try { if ((Invoke-RestMethod 'http://127.0.0.1:8790/healthz' -TimeoutSec 1).app -eq 'whale-compose-preview') { return } } catch {}
  if ($taskProcess.HasExited) { throw 'Preview failed to start. See data/compose-preview.err.log.' }
}
throw 'Preview startup timed out.'
