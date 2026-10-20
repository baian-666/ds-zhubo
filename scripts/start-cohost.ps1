param([string]$RoomSnapshot, [switch]$SkipRelay)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = Join-Path $taskRoot 'data/toolchains/node-v26.7.0-win-x64/node.exe'
if (!(Test-Path -LiteralPath $taskNode)) { throw 'Local toolchain is missing. Run scripts/setup-local.ps1 first.' }
$env:PATH = (Split-Path -Parent $taskNode) + ';' + $env:PATH
$taskMutex = New-Object System.Threading.Mutex($false, 'Local\ds-zhubo-cohost-launch')
if (!$taskMutex.WaitOne(10000)) { throw 'Another launcher is still starting the cohost.' }
try {
  $taskEnvFile=Join-Path $taskRoot '.env'
  if (!$SkipRelay -and (Test-Path -LiteralPath $taskEnvFile) -and [IO.File]::ReadAllText($taskEnvFile) -match '(?m)^\s*BILIBILI_SOURCE\s*=\s*blivechat\s*$') {
    try { & (Join-Path $PSScriptRoot 'start-bilibili.ps1') -SkipSetup } catch { Write-Warning 'Local chat relay did not start. The cohost is still available; retry the chat setup later.' }
  }
  $taskHealthy = $false
  try { $taskHealthy = (Invoke-RestMethod 'http://127.0.0.1:8787/healthz' -TimeoutSec 2).ok } catch {}
  if ($taskHealthy) { return }
  $taskArguments=@('--env-file-if-exists=.env','apps/cohost/server.mjs')
  if ($RoomSnapshot) {
    $taskResolvedSnapshot=(Resolve-Path -LiteralPath $RoomSnapshot).Path
    $taskDataRoot=[IO.Path]::GetFullPath((Join-Path $taskRoot 'data')) + [IO.Path]::DirectorySeparatorChar
    if (!$taskResolvedSnapshot.StartsWith($taskDataRoot,[StringComparison]::OrdinalIgnoreCase) -or $taskResolvedSnapshot.Contains('"')) { throw 'Room snapshot must be a local file under data.' }
    $taskArguments += '"--room-snapshot=' + $taskResolvedSnapshot + '"'
  }
  $taskServer = Start-Process -FilePath $taskNode -ArgumentList $taskArguments -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRoot 'data/cohost-launch.out.log') -RedirectStandardError (Join-Path $taskRoot 'data/cohost-launch.err.log')
  Set-Content -LiteralPath (Join-Path $taskRoot 'data/cohost.pid') -Value $taskServer.Id
  for ($taskTry = 0; $taskTry -lt 20; $taskTry++) {
    Start-Sleep -Milliseconds 500
    try { $taskHealthy = (Invoke-RestMethod 'http://127.0.0.1:8787/healthz' -TimeoutSec 1).ok } catch {}
    if ($taskHealthy) { return }
  }
  throw 'Cohost did not start. See data/cohost-launch.err.log.'
}
finally { $taskMutex.ReleaseMutex(); $taskMutex.Dispose() }
