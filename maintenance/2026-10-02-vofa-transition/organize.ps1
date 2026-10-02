param([ValidateSet('Archive','ResumeArchive','Clean')][string]$Phase = 'Archive')
$ErrorActionPreference = 'Stop'
$workspacePath = 'D:\Desktop\LLM串口'
$archiveRelative = 'reference\legacy-llm-serial'
$recordPath = Join-Path $workspacePath 'maintenance\2026-10-02-vofa-transition'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$emptyIgnore = Join-Path $recordPath 'empty-git-excludes'
[IO.File]::WriteAllText($emptyIgnore, '', $utf8)
function Save-Json($name, $value) {
    [IO.File]::WriteAllText((Join-Path $recordPath $name), (ConvertTo-Json -InputObject $value -Depth 12), $utf8)
}
function Safe-Path([string]$relative, [switch]$Exists) {
    if ([IO.Path]::IsPathRooted($relative)) { throw "Absolute input rejected: $relative" }
    $full = [IO.Path]::GetFullPath((Join-Path $workspacePath $relative))
    if (-not $full.StartsWith($workspacePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Outside workspace: $full" }
    if ($Exists -and -not ([IO.File]::Exists($full) -or [IO.Directory]::Exists($full))) { throw "Missing path: $full" }
    if (-not $full.StartsWith($workspacePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Resolved outside workspace: $full" }
    $cursor = $full
    while ($cursor -ne $workspacePath) {
        if ([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) {
            if ([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point: $cursor" }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $full
}
function File-Record($file, [string]$destination) {
    [pscustomobject]@{ Original=$file.FullName.Substring($workspacePath.Length+1); Archived=$destination; Bytes=$file.Length; Sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
}
$moveNames = @('.github','.vscode','docs','implementation-checkpoint-2026-09-28-stage-a','output','public','release','scripts','src','src-tauri','tests','CONTEXT.md','CONTRIBUTING.md','DESIGN.md','GEMINI.md','index.html','MODEL_HANDOFF_2026-09-28.md','package-lock.json','package.json','PRD.md','PRODUCT.md','README.md','tsconfig.json','vite.config.ts','启动软件.bat','一键更新构建.bat')
$cacheNames = @('dist','dist-staging','node_modules','src-tauri\target','src-tauri\dist-staging','src-tauri\src-tauri','output\cargo-target-beta-20260930')
function Move-Tree([string]$fromRelative, [string]$toRelative) {
    $from = Safe-Path $fromRelative -Exists
    $to = Safe-Path $toRelative
    $item = Get-Item -LiteralPath $from -Force
    if (-not (Test-Path -LiteralPath $to)) {
        if ($item.PSIsContainer) { [IO.Directory]::Move($from, $to) } else { [IO.File]::Move($from, $to) }
        return
    }
    if (-not $item.PSIsContainer -or -not (Get-Item -LiteralPath $to -Force).PSIsContainer) { throw "Conflicting target: $to" }
    foreach ($child in @(Get-ChildItem -LiteralPath $from -Force)) {
        Move-Tree (Join-Path $fromRelative $child.Name) (Join-Path $toRelative $child.Name)
    }
    [IO.Directory]::Delete($from, $false)
}
if ($Phase -eq 'ResumeArchive') {
    $manifest = @(Get-Content -LiteralPath (Join-Path $recordPath 'preserved-files.json') -Raw | ConvertFrom-Json)
    # The first preflight omitted tests from the move list. They are still at their original location.
    if (-not @($manifest | Where-Object {$_.Original -like 'tests\*'}).Count) {
        foreach ($file in @(Get-ChildItem -LiteralPath (Safe-Path 'tests' -Exists) -Recurse -File -Force)) {
            $relative = $file.FullName.Substring($workspacePath.Length+1)
            $manifest += File-Record $file (Join-Path $archiveRelative $relative)
        }
        Save-Json 'preserved-files.json' $manifest
    }
    $moves = @(Get-Content -LiteralPath (Join-Path $recordPath 'moves.json') -Raw | ConvertFrom-Json)
    foreach ($name in $moveNames) {
        $toRelative = Join-Path $archiveRelative $name
        if (Test-Path -LiteralPath (Safe-Path $name)) { Move-Tree $name $toRelative }
        elseif (-not (Test-Path -LiteralPath (Safe-Path $toRelative))) { throw "Missing both locations: $name" }
        if (-not @($moves | Where-Object {$_.From -eq $name}).Count) { $moves += [pscustomobject]@{From=$name;To=$toRelative} }
        Save-Json 'moves.json' $moves
    }
    foreach ($row in $manifest) {
        $to = Safe-Path $row.Archived -Exists
        if ((Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash -ne $row.Sha256) { throw "Archive mismatch: $to" }
    }
    $before = Get-Content -LiteralPath (Join-Path $recordPath 'git-before.json') -Raw | ConvertFrom-Json
    Save-Json 'archive-verification.json' @{Status='passed';Files=$manifest.Count;PreservedBytes=($manifest|Measure-Object Bytes -Sum).Sum;GitHead=$before.Head;VerifiedAt=(Get-Date).ToString('o')}
    Write-Output "Archive verified: $($manifest.Count) files. Cache deletion has not run."
    exit
}
if ($Phase -eq 'Archive') {
    $archivePath = Safe-Path $archiveRelative
    if (Test-Path -LiteralPath $archivePath) { throw 'Archive destination already exists.' }
    $gitHead = & git -c "core.excludesFile=$emptyIgnore" rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Cannot record Git HEAD.' }
    $gitStatus = @(& git -c "core.excludesFile=$emptyIgnore" status --porcelain=v1 -uall)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot record Git status.' }
    Save-Json 'git-before.json' @{Head=$gitHead;Status=$gitStatus;RecordedAt=(Get-Date).ToString('o')}
    $cacheRows = @()
    $retained = @()
    foreach ($relative in $cacheNames) {
        $full = Safe-Path $relative -Exists
        $files = @(Get-ChildItem -LiteralPath $full -Recurse -File -Force)
        if (@(Get-ChildItem -LiteralPath $full -Recurse -Force -Attributes ReparsePoint).Count) { throw "Cache contains links: $full" }
        $tracked = @(& git -c "core.excludesFile=$emptyIgnore" ls-files -- $relative)
        if ($LASTEXITCODE -ne 0 -or $tracked.Count) { throw "Cache has tracked content: $relative" }
        $cacheRows += [pscustomobject]@{Original=$relative;Files=$files.Count;Bytes=($files|Measure-Object Length -Sum).Sum;DeleteAfterVerification=$true}
        foreach ($file in $files) {
            $keep = $file.Name -in @('llm-serial.exe','LLM串口.exe','portable.flag','build-manifest.json','README.txt') -or $file.FullName.StartsWith((Join-Path $workspacePath 'dist-staging\releases')+'\',[StringComparison]::OrdinalIgnoreCase) -or ($relative -eq 'dist-staging' -and $file.Extension -eq '.log')
            if ($keep) {
                $to = Join-Path 'reference\retained-build-artifacts' $file.FullName.Substring($workspacePath.Length+1)
                $retained += File-Record $file $to
            }
        }
    }
    $manifest = @()
    foreach ($name in $moveNames) {
        $source = Safe-Path $name -Exists
        $item = Get-Item -LiteralPath $source -Force
        $files = if ($item.PSIsContainer) { @(Get-ChildItem -LiteralPath $source -File -Recurse -Force) } else { @($item) }
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($workspacePath.Length+1)
            $isCache = $false
            foreach ($cache in $cacheNames) { if ($relative -eq $cache -or $relative.StartsWith($cache+'\',[StringComparison]::OrdinalIgnoreCase)) { $isCache=$true; break } }
            if (-not $isCache) { $manifest += File-Record $file (Join-Path $archiveRelative $relative) }
        }
    }
    foreach ($name in @('.gitignore','.gitattributes')) {
        $manifest += File-Record (Get-Item -LiteralPath (Safe-Path $name -Exists) -Force) (Join-Path $archiveRelative $name)
    }
    Save-Json 'cache-plan.json' $cacheRows
    Save-Json 'preserved-files.json' @($manifest + $retained)
    foreach ($row in $retained) {
        $from = Safe-Path $row.Original -Exists
        $to = Safe-Path $row.Archived
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to)) | Out-Null
        Copy-Item -LiteralPath $from -Destination $to -ErrorAction Stop
        if ((Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash -ne $row.Sha256) { throw "Retained artifact mismatch: $to" }
    }
    [IO.Directory]::CreateDirectory($archivePath) | Out-Null
    foreach ($name in @('.gitignore','.gitattributes')) { Copy-Item -LiteralPath (Safe-Path $name -Exists) -Destination (Safe-Path (Join-Path $archiveRelative $name)) }
    $moves = @()
    foreach ($name in $moveNames) {
        $from = Safe-Path $name -Exists
        $to = Safe-Path (Join-Path $archiveRelative $name)
        if (Test-Path -LiteralPath $to) { throw "Move target exists: $to" }
        Move-Tree $name (Join-Path $archiveRelative $name)
        $moves += [pscustomobject]@{From=$name;To=(Join-Path $archiveRelative $name)}
        Save-Json 'moves.json' $moves
    }
    $verified = 0
    foreach ($row in @($manifest + $retained)) {
        $to = Safe-Path $row.Archived -Exists
        if ((Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash -ne $row.Sha256) { throw "Archive mismatch: $to" }
        $verified++
    }
    Save-Json 'archive-verification.json' @{Status='passed';Files=$verified;PreservedBytes=(@($manifest+$retained)|Measure-Object Bytes -Sum).Sum;GitHead=$gitHead;VerifiedAt=(Get-Date).ToString('o')}
    Write-Output "Archive verified: $verified files. Cache deletion has not run."
    exit
}
$archiveVerification = Get-Content -LiteralPath (Join-Path $recordPath 'archive-verification.json') -Raw | ConvertFrom-Json
if ($archiveVerification.Status -ne 'passed') { throw 'Archive verification must pass before deletion.' }
$manifest = @(Get-Content -LiteralPath (Join-Path $recordPath 'preserved-files.json') -Raw | ConvertFrom-Json)
foreach ($row in $manifest) {
    $to = Safe-Path $row.Archived -Exists
    if ((Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash -ne $row.Sha256) { throw "Preservation changed before deletion: $to" }
}
$plan = @(Get-Content -LiteralPath (Join-Path $recordPath 'cache-plan.json') -Raw | ConvertFrom-Json)
$deleted = @()
foreach ($row in $plan) {
    if ($row.Original -notin $cacheNames) { throw 'Unexpected deletion target.' }
    $relative = if ($row.Original -match '^(src-tauri|output)\\') { Join-Path $archiveRelative $row.Original } else { $row.Original }
    $full = Safe-Path $relative -Exists
    if (@(Get-ChildItem -LiteralPath $full -Recurse -Force -Attributes ReparsePoint).Count) { throw "Deletion tree contains links: $full" }
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $full) { throw "Deletion incomplete: $full" }
    $deleted += [pscustomobject]@{Original=$row.Original;DeletedPath=$relative;Files=$row.Files;Bytes=$row.Bytes;VerifiedAbsent=$true}
    Save-Json 'deleted-caches.json' $deleted
}
Save-Json 'cleanup-verification.json' @{Status='passed';Targets=$deleted.Count;RemovedBytes=($deleted|Measure-Object Bytes -Sum).Sum;FinishedAt=(Get-Date).ToString('o')}
Write-Output "Deleted and verified $($deleted.Count) cache trees."
