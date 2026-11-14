$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$distRoot = Join-Path $projectRoot 'dist'
& node (Join-Path $PSScriptRoot 'build.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Runtime build failed.' }

$entries = @(
    @{ Source = (Join-Path $distRoot 'agent-messenger.mjs'); Name = 'agent-messenger.mjs' },
    @{ Source = (Join-Path $distRoot 'README.txt'); Name = 'README.txt' },
    @{ Source = (Join-Path $distRoot 'THIRD_PARTY_LICENSES.txt'); Name = 'THIRD_PARTY_LICENSES.txt' },
    @{ Source = (Join-Path $projectRoot 'LICENSE'); Name = 'LICENSE' },
    @{ Source = (Join-Path $projectRoot 'NOTICE'); Name = 'NOTICE' },
    @{ Source = (Join-Path $projectRoot 'ui/index.html'); Name = 'ui/index.html' }
)
foreach ($entry in $entries) {
    if (-not (Test-Path -LiteralPath $entry.Source -PathType Leaf)) { throw "Missing runtime input: $($entry.Source)" }
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipPath = Join-Path $distRoot 'agent-messenger-runtime.zip'
$stream = [IO.File]::Open($zipPath, [IO.FileMode]::Create)
try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        foreach ($entry in $entries) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $entry.Source, $entry.Name, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $archive.Dispose() }
} finally { $stream.Dispose() }
Get-Item -LiteralPath $zipPath | Select-Object FullName, Length
