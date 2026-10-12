param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = Join-Path $taskRoot 'data/toolchains/node-v26.7.0-win-x64/node.exe'
$taskMutex = New-Object System.Threading.Mutex($false, 'Local\ds-zhubo-web-launch')
if (!$taskMutex.WaitOne(0)) { exit 0 }
try {
  & (Join-Path $PSScriptRoot 'start-cohost.ps1')
  $taskHealthy = $false
  try { $taskHealthy = (Invoke-WebRequest 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch {}
  if (!$taskHealthy) {
    $taskWeb = Start-Process -FilePath $taskNode -ArgumentList 'scripts/airi.mjs','dev' -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRoot 'data/airi-launch.out.log') -RedirectStandardError (Join-Path $taskRoot 'data/airi-launch.err.log')
    Set-Content -LiteralPath (Join-Path $taskRoot 'data/airi.pid') -Value $taskWeb.Id
    $taskDeadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $taskDeadline) {
      Start-Sleep -Milliseconds 500
      try { $taskHealthy = (Invoke-WebRequest 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200 } catch {}
      if ($taskHealthy) { break }
    }
    if (!$taskHealthy) { throw 'Web stage did not start. See data/airi-launch.err.log.' }
  }
  if (!$NoOpen) { Start-Process 'http://127.0.0.1:5173/?cohost' }
  'Web backup ready at http://127.0.0.1:5173/?cohost' | Set-Content -LiteralPath (Join-Path $taskRoot 'data/start-web.log')
}
catch {
  $_.Exception.Message | Set-Content -LiteralPath (Join-Path $taskRoot 'data/start-web.log')
  exit 1
}
finally { $taskMutex.ReleaseMutex(); $taskMutex.Dispose() }
