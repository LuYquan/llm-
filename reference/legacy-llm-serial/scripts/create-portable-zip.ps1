param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDirectory,

  [Parameter(Mandatory = $true)]
  [string]$ZipPath
)

$ErrorActionPreference = 'Stop'
trap {
  Write-Error $_
  exit 1
}

$source = [System.IO.Path]::GetFullPath($SourceDirectory)
$destination = [System.IO.Path]::GetFullPath($ZipPath)

if (-not (Test-Path -LiteralPath $source -PathType Container)) {
  throw "Portable source directory not found: $source"
}
if (Test-Path -LiteralPath $destination) {
  throw "Refusing to overwrite existing ZIP: $destination"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $source,
  $destination,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false,
  [System.Text.Encoding]::UTF8
)

if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
  throw "ZIP output was not created: $destination"
}

$archive = [System.IO.Compression.ZipFile]::OpenRead($destination)
try {
  $expectedExeName = 'LLM' + [char]0x4E32 + [char]0x53E3 + '.exe'
  $expectedNames = @($expectedExeName, 'portable.flag', 'README.txt', 'build-manifest.json')
  $actualNames = @($archive.Entries | ForEach-Object { $_.FullName })
  if ($actualNames.Count -ne $expectedNames.Count) {
    throw "Unexpected number of ZIP entries: $($actualNames.Count)"
  }
  foreach ($expectedName in $expectedNames) {
    $found = $false
    foreach ($actualName in $actualNames) {
      if ([System.String]::Equals($actualName, $expectedName, [System.StringComparison]::Ordinal)) {
        $found = $true
        break
      }
    }
    if (-not $found) {
      throw "Missing UTF-8 ZIP entry or incorrect name: $expectedName"
    }
  }
}
finally {
  $archive.Dispose()
}
