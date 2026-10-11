param([Parameter(Mandatory=$true)][string]$Archive, [string]$Variant = 'DS鼠控版.zip')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$project = Split-Path $PSScriptRoot -Parent
$destination = Join-Path $project 'data/live2d/whale-airi.zip'
if (Test-Path -LiteralPath $destination) { throw 'Adapted model already exists. Preserve it before preparing another copy.' }
New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
$encoding = [Text.Encoding]::GetEncoding(936)
$outerStream = [IO.File]::OpenRead((Resolve-Path -LiteralPath $Archive).Path)
$outer = [IO.Compression.ZipArchive]::new($outerStream,[IO.Compression.ZipArchiveMode]::Read,$false,$encoding)
$output = $null
$temporary = $destination + '.preparing-' + [Guid]::NewGuid().ToString() + '.zip'
$complete = $false
try {
  $variantEntry = $outer.Entries | Where-Object { $_.Name -eq $Variant } | Select-Object -First 1
  if (!$variantEntry) { throw 'Requested model variant is missing.' }
  $buffer = [IO.MemoryStream]::new()
  $sourceStream = $variantEntry.Open()
  $sourceStream.CopyTo($buffer)
  $sourceStream.Dispose()
  $buffer.Position = 0
  $inner = [IO.Compression.ZipArchive]::new($buffer,[IO.Compression.ZipArchiveMode]::Read,$false,$encoding)
  try {
    $modelEntries = @($inner.Entries | Where-Object { $_.Name -like '*.model3.json' })
    if ($modelEntries.Count -ne 1) { throw 'Expected exactly one model entry.' }
    $reader = [IO.StreamReader]::new($modelEntries[0].Open())
    $model = $reader.ReadToEnd() | ConvertFrom-Json
    $reader.Dispose()
    $expressions = @($inner.Entries | Where-Object { $_.Name -like '*.exp3.json' } | ForEach-Object {
      @{Name = $_.Name.Replace('.exp3.json',''); File = $_.FullName}
    })
    $model.FileReferences | Add-Member -Force -NotePropertyName Expressions -NotePropertyValue $expressions
    # Motions stay unregistered: some toggle props and are not safe idle animation.
    ($model.Groups | Where-Object Name -eq 'LipSync').Ids = @('ParamMouthOpenY')
    $output = [IO.Compression.ZipFile]::Open($temporary,[IO.Compression.ZipArchiveMode]::Create)
    foreach ($entry in $inner.Entries) {
      if (!$entry.Name) { continue }
      if ($entry.FullName -match '(^[/\\]|^[A-Za-z]:|(^|[/\\])\.\.([/\\]|$))') { throw 'Unsafe archive entry.' }
      $target = $output.CreateEntry($entry.FullName.Replace('\','/'))
      $stream = $target.Open()
      if ($entry -eq $modelEntries[0]) {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($model | ConvertTo-Json -Depth 30))
        $stream.Write($bytes,0,$bytes.Length)
      } else {
        $sourceStream = $entry.Open()
        $sourceStream.CopyTo($stream)
        $sourceStream.Dispose()
      }
      $stream.Dispose()
    }
    foreach ($entry in $outer.Entries | Where-Object { $_.Name -like '*.txt' }) {
      $target = $output.CreateEntry('source-notices/'+$entry.Name)
      $stream = $target.Open()
      $sourceStream = $entry.Open()
      $sourceStream.CopyTo($stream)
      $sourceStream.Dispose()
      $stream.Dispose()
    }
    $complete = $true
  } finally { $inner.Dispose() }
} finally {
  if ($output) { $output.Dispose() }
  $outer.Dispose()
  if (!$complete -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary }
}
[IO.File]::Move($temporary,$destination)
Write-Output ('Prepared local model: '+$destination+'; expressions: '+$expressions.Count)
