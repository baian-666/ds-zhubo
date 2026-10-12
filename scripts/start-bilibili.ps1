param([switch]$SkipSetup)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = Join-Path $taskRoot 'data/toolchains/node-v26.7.0-win-x64/node.exe'
$taskPackage = Join-Path $taskRoot 'data/blivechat-download/blivechat-1.10.4-windows-x64.zip'
$taskDestination = Join-Path $taskRoot 'data/blivechat-1.10.4'
$taskExe = Join-Path $taskDestination 'blivechat/blivechat.exe'
if (!(Test-Path -LiteralPath $taskExe)) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $taskPackage) -Force | Out-Null
  if (!(Test-Path -LiteralPath $taskPackage)) {
    Invoke-WebRequest 'https://github.com/xfgryujk/blivechat/releases/download/v1.10.4/blivechat-1.10.4-windows-x64.zip' -UseBasicParsing -OutFile $taskPackage
  }
  if ((Get-FileHash -LiteralPath $taskPackage -Algorithm SHA256).Hash -ne '411F51518EBBFFF31C9E37A432164C12FE11600C11BEC7A1F1A95428E5620445') { throw 'Unexpected blivechat package hash.' }
  $taskDestinationRoot = [IO.Path]::GetFullPath($taskDestination) + [IO.Path]::DirectorySeparatorChar
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $taskArchive = [IO.Compression.ZipFile]::OpenRead($taskPackage)
  try {
    foreach ($taskEntry in $taskArchive.Entries) {
      $taskTarget = [IO.Path]::GetFullPath((Join-Path $taskDestination $taskEntry.FullName))
      if (!$taskTarget.StartsWith($taskDestinationRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive path.' }
    }
  } finally { $taskArchive.Dispose() }
  Expand-Archive -LiteralPath $taskPackage -DestinationPath $taskDestination
}
$taskAlive = $false
try {
  $taskPage = Invoke-WebRequest 'http://127.0.0.1:12451/' -UseBasicParsing -TimeoutSec 2
  if (!$taskPage.Content.Contains('blivechat')) { throw 'Port 12451 belongs to another application.' }
  $taskAlive = $true
} catch { if ($_.Exception.Message -eq 'Port 12451 belongs to another application.') { throw } }
if (!$taskAlive) {
  $taskProcess = Start-Process -FilePath $taskExe -ArgumentList @('--host','127.0.0.1','--port','12451') -WorkingDirectory (Split-Path -Parent $taskExe) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRoot 'data/blivechat.out.log') -RedirectStandardError (Join-Path $taskRoot 'data/blivechat.err.log')
  Set-Content -LiteralPath (Join-Path $taskRoot 'data/blivechat.pid') -Value $taskProcess.Id
  for ($taskAttempt=0; $taskAttempt -lt 30; $taskAttempt++) {
    Start-Sleep -Milliseconds 500
    try { if ((Invoke-WebRequest 'http://127.0.0.1:12451/' -UseBasicParsing -TimeoutSec 1).Content.Contains('blivechat')) { $taskAlive=$true; break } } catch {}
    if ($taskProcess.HasExited) { throw 'blivechat did not start. See its local log.' }
  }
  if (!$taskAlive) { throw 'blivechat startup timed out.' }
}
if ($SkipSetup) { return }
$taskSetupAlive = $false
try { $taskSetupAlive = (Invoke-WebRequest 'http://127.0.0.1:8791/' -UseBasicParsing -TimeoutSec 1).Content.Contains('data-bilibili-setup') } catch {}
if (!$taskSetupAlive) {
  $taskSetup = Start-Process -FilePath $taskNode -ArgumentList 'scripts/configure-bilibili.mjs' -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRoot 'data/bilibili-setup.out.log') -RedirectStandardError (Join-Path $taskRoot 'data/bilibili-setup.err.log')
  Set-Content -LiteralPath (Join-Path $taskRoot 'data/bilibili-setup.pid') -Value $taskSetup.Id
  for ($taskAttempt=0; $taskAttempt -lt 20; $taskAttempt++) {
    Start-Sleep -Milliseconds 250
    try { if ((Invoke-WebRequest 'http://127.0.0.1:8791/' -UseBasicParsing -TimeoutSec 1).Content.Contains('data-bilibili-setup')) { return } } catch {}
  }
  throw 'Local chat setup startup timed out.'
}
