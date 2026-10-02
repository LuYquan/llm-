# scripts/build-portable.ps1
# PowerShell entry point for the auditable portable build.
# The Node script owns versioning, checks, unique output paths, hashes and ZIP failure handling.
param(
    [switch]$SkipBuild,
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path

if ($Version) {
    $PackageJson = Get-Content (Join-Path $ProjectRoot "package.json") -Raw | ConvertFrom-Json
    if ([string]$PackageJson.version -ne $Version) {
        throw "Version argument $Version does not match package.json version $($PackageJson.version). Update package.json first."
    }
}

$NodeArgs = @("scripts/build-portable.mjs")
if ($SkipBuild) {
    $NodeArgs += "--skip-build"
}

Push-Location $ProjectRoot
try {
    Write-Host "Calling the unified auditable portable build entry point..." -ForegroundColor Cyan
    & node @NodeArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Portable build failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
