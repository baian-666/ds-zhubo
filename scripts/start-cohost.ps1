$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = Join-Path $taskRoot 'data/toolchains/node-v26.7.0-win-x64/node.exe'
if (!(Test-Path -LiteralPath $taskNode)) { throw 'Local toolchain is missing. Run scripts/setup-local.ps1 first.' }
$env:PATH = (Split-Path -Parent $taskNode) + ';' + $env:PATH
$taskMutex = New-Object System.Threading.Mutex($false, 'Local\ds-zhubo-cohost-launch')
if (!$taskMutex.WaitOne(10000)) { throw 'Another launcher is still starting the cohost.' }
try {
  $taskHealthy = $false
  try { $taskHealthy = (Invoke-RestMethod 'http://127.0.0.1:8787/healthz' -TimeoutSec 2).ok } catch {}
  if ($taskHealthy) { return }
  $taskServer = Start-Process -FilePath $taskNode -ArgumentList '--env-file-if-exists=.env','apps/cohost/server.mjs' -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRoot 'data/cohost-launch.out.log') -RedirectStandardError (Join-Path $taskRoot 'data/cohost-launch.err.log')
  Set-Content -LiteralPath (Join-Path $taskRoot 'data/cohost.pid') -Value $taskServer.Id
  for ($taskTry = 0; $taskTry -lt 20; $taskTry++) {
    Start-Sleep -Milliseconds 500
    try { $taskHealthy = (Invoke-RestMethod 'http://127.0.0.1:8787/healthz' -TimeoutSec 1).ok } catch {}
    if ($taskHealthy) { return }
  }
  throw 'Cohost did not start. See data/cohost-launch.err.log.'
}
finally { $taskMutex.ReleaseMutex(); $taskMutex.Dispose() }
