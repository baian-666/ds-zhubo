param(
  [ValidateSet('probe','live','fixture')][string]$Mode = 'probe',
  [string]$WavePath = ''
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
Add-Type -AssemblyName System.Web.Extensions
Add-Type -Path (Join-Path $PSScriptRoot '../apps/cohost/windows-speech.cs') -ReferencedAssemblies System.Speech,System.Web.Extensions
[CohostSpeech]::Run($Mode, $WavePath)
