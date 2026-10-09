$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskTools = Join-Path $taskRoot 'data/toolchains'
$taskNodeDir = Join-Path $taskTools 'node-v26.7.0-win-x64'
New-Item -ItemType Directory -Force -Path $taskTools | Out-Null
if (!(Test-Path -LiteralPath (Join-Path $taskNodeDir 'node.exe'))) {
  $taskZip = Join-Path $taskTools 'node.zip'
  $taskChecksums = Join-Path $taskTools 'node-shasums.txt'
  Invoke-WebRequest 'https://nodejs.org/dist/v26.7.0/node-v26.7.0-win-x64.zip' -OutFile $taskZip
  Invoke-WebRequest 'https://nodejs.org/dist/v26.7.0/SHASUMS256.txt' -OutFile $taskChecksums
  $taskActual = (Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLowerInvariant()
  $taskExpected = (Select-String -LiteralPath $taskChecksums -Pattern ' node-v26.7.0-win-x64.zip$').Line.Split(' ')[0]
  if (!$taskExpected -or $taskActual -ne $taskExpected) { throw 'Node checksum mismatch. Archive was not executed.' }
  Expand-Archive -LiteralPath $taskZip -DestinationPath $taskTools
}
$taskNode = Join-Path $taskNodeDir 'node.exe'
if ((& $taskNode --version) -ne 'v26.7.0') { throw 'Unexpected Node version.' }
$env:PATH = $taskNodeDir + ';' + $env:PATH
$taskBootstrapNpm = Join-Path $taskNodeDir 'node_modules/npm/bin/npm-cli.js'
foreach ($taskPackage in @(@{Name='npm';Version='11.19.0'},@{Name='pnpm';Version='11.24.0'})) {
  $taskPrefix = Join-Path $taskTools ($taskPackage.Name + '-' + $taskPackage.Version)
  $taskManifest = Join-Path $taskPrefix ('node_modules/' + $taskPackage.Name + '/package.json')
  if (Test-Path -LiteralPath $taskManifest) {
    if ((Get-Content -LiteralPath $taskManifest -Raw | ConvertFrom-Json).version -eq $taskPackage.Version) { continue }
    throw 'Existing local toolchain has an unexpected version. Preserve it and inspect manually.'
  }
  & $taskNode $taskBootstrapNpm install --prefix $taskPrefix ($taskPackage.Name + '@' + $taskPackage.Version)
  if ($LASTEXITCODE -ne 0) { throw 'Toolchain package installation failed.' }
}
$taskEnv = Join-Path $taskRoot '.env'
if (!(Test-Path -LiteralPath $taskEnv)) { Copy-Item -LiteralPath (Join-Path $taskRoot '.env.example') -Destination $taskEnv }
Write-Output 'Local Node 26.7.0, npm 11.19.0 and pnpm 11.24.0 ready. Existing .env preserved.'
