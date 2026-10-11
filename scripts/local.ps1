param(
  [ValidateSet('check','test','dev','setup:airi:web','dev:airi','replay:director','setup:desktop','dev:desktop','check:desktop','build:desktop','configure:voice')]
  [string]$Action = 'dev'
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$nodeDir = Join-Path $taskRoot 'data/toolchains/node-v26.7.0-win-x64'
$npmCli = Join-Path $taskRoot 'data/toolchains/npm-11.19.0/node_modules/npm/bin/npm-cli.js'
if (!(Test-Path -LiteralPath $npmCli) -or !(Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))) {
  throw 'Install the pinned local toolchain first. See docs/LOCAL-DEVELOPMENT.md.'
}
$env:PATH = $nodeDir + ';' + $env:PATH
Push-Location $taskRoot
try {
  & (Join-Path $nodeDir 'node.exe') $npmCli run $Action
  if ($LASTEXITCODE -ne 0) { throw "Local command failed: $Action" }
} finally { Pop-Location }
