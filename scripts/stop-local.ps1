$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = Join-Path $taskRoot 'data/toolchains/node-v26.7.0-win-x64/node.exe'
foreach ($taskService in @(@{Name='cohost';Entry='apps/cohost/server.mjs'},@{Name='airi';Entry='scripts/airi.mjs'},@{Name='desktop-launcher';Entry='scripts/desktop.mjs'})) {
  $taskPidFile = Join-Path $taskRoot ('data/' + $taskService.Name + '.pid')
  if (!(Test-Path -LiteralPath $taskPidFile)) { continue }
  $taskPid = [int](Get-Content -LiteralPath $taskPidFile)
  $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $taskPid"
  if (!$taskProcess) { Write-Output ($taskService.Name + ' is already stopped.'); continue }
  if ($taskProcess.ExecutablePath -ne $taskNode -or $taskProcess.CommandLine -notlike ('*' + $taskService.Entry + '*')) {
    throw 'Saved PID belongs to a different process. Nothing stopped for this service.'
  }
  & taskkill.exe /PID $taskPid /T /F
  if ($LASTEXITCODE -ne 0) { throw 'Service stop failed.' }
}
