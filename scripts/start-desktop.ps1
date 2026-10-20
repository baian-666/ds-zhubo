$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = Join-Path $taskRoot 'data/toolchains/node-v26.7.0-win-x64/node.exe'
$taskLog = Join-Path $taskRoot 'data/start-desktop.log'
$taskMutex = New-Object System.Threading.Mutex($false, 'Local\ds-zhubo-desktop-launch')
if (!$taskMutex.WaitOne(0)) { exit 0 }
try {
  & (Join-Path $PSScriptRoot 'start-cohost.ps1') -SkipRelay
  # Start optional chat services without delaying the desktop window.
  $taskRelayScript = Join-Path $PSScriptRoot 'start-cohost.ps1'
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', ('"' + $taskRelayScript + '"')) -WorkingDirectory $taskRoot -WindowStyle Hidden | Out-Null
  foreach ($taskName in @('desktop-launcher','desktop')) {
    $taskPidFile = Join-Path $taskRoot ('data/' + $taskName + '.pid')
    if (Test-Path -LiteralPath $taskPidFile) {
      $taskSavedId = [int](Get-Content -LiteralPath $taskPidFile)
      $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $taskSavedId"
      if ($taskProcess -and $taskProcess.ExecutablePath -eq $taskNode -and $taskProcess.CommandLine -like '*scripts/desktop.mjs*') {
        $taskStage = $null
        try {
          $taskTargets = Invoke-RestMethod 'http://127.0.0.1:9250/json/list' -TimeoutSec 2
          $taskStage = @($taskTargets | Where-Object { $_.type -eq 'page' -and $_.url -match '^http://(127\.0\.0\.1|localhost):5174/\?synced-leader=true#/' }) | Select-Object -First 1
        } catch {}
        if ($taskStage) {
          # Bring the existing stage forward instead of creating a duplicate room.
          $taskSocket = New-Object System.Net.WebSockets.ClientWebSocket
          $taskCancellation = New-Object System.Threading.CancellationTokenSource
          $taskCancellation.CancelAfter(2000)
          try {
            $null = $taskSocket.ConnectAsync([Uri]$taskStage.webSocketDebuggerUrl, $taskCancellation.Token).GetAwaiter().GetResult()
            $taskBytes = [Text.Encoding]::UTF8.GetBytes('{"id":1,"method":"Page.bringToFront"}')
            $null = $taskSocket.SendAsync([ArraySegment[byte]]::new($taskBytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $taskCancellation.Token).GetAwaiter().GetResult()
          } catch {} finally { $taskSocket.Dispose(); $taskCancellation.Dispose() }
          'Opened the existing desktop stage.' | Set-Content -LiteralPath $taskLog
          exit 0
        }
        if (((Get-Date) - $taskProcess.CreationDate).TotalSeconds -lt 120) {
          'Desktop is still starting. Wait for its AIRI window.' | Set-Content -LiteralPath $taskLog
          exit 0
        }
        # The user closed Electron, but its development watcher can remain alive.
        & taskkill.exe /PID $taskSavedId /T /F | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not stop the stale desktop watcher.' }
      }
    }
  }
  if (!(Test-Path -LiteralPath (Join-Path $taskRoot 'data/desktop-build.json'))) {
    throw 'No fixed desktop build exists. Run scripts/local.ps1 build:desktop once, then start again.'
  }
  # The daily entry runs compiled files. The developer entry remains available separately.
  $env:APP_REMOTE_DEBUG = 'true'
  $env:APP_REMOTE_DEBUG_PORT = '9250'
  $taskDesktop = Start-Process -FilePath $taskNode -ArgumentList 'scripts/desktop.mjs','start' -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRoot 'data/desktop-launch.out.log') -RedirectStandardError (Join-Path $taskRoot 'data/desktop-launch.err.log')
  Set-Content -LiteralPath (Join-Path $taskRoot 'data/desktop-launcher.pid') -Value $taskDesktop.Id
  $taskOpened = $false
  for ($taskTry = 0; $taskTry -lt 60; $taskTry++) {
    Start-Sleep -Milliseconds 500
    $taskDesktop.Refresh()
    if ($taskDesktop.HasExited) { throw 'Desktop failed to start. See data/desktop-launch.err.log. Port 5174 must be free.' }
    try {
      $taskTargets = Invoke-RestMethod 'http://127.0.0.1:9250/json/list' -TimeoutSec 1
      $taskOpened = @($taskTargets | Where-Object { $_.type -eq 'page' -and $_.url -match '^http://localhost:5174/\?synced-leader=true#/' }).Count -gt 0
    } catch {}
    if ($taskOpened) { break }
  }
  if (!$taskOpened) { throw 'Desktop window did not become ready. See data/desktop-launch.err.log. The existing process was kept for diagnosis.' }
  'Fixed desktop window opened.' | Set-Content -LiteralPath $taskLog
}
catch {
  $_.Exception.Message | Set-Content -LiteralPath $taskLog
  $taskPopup = New-Object -ComObject WScript.Shell
  $null = $taskPopup.Popup($_.Exception.Message, 0, 'Little Whale - Startup', 16)
  exit 1
}
finally {
  $taskMutex.ReleaseMutex()
  $taskMutex.Dispose()
}
