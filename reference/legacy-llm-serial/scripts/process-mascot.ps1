Add-Type -AssemblyName System.Drawing

$srcPath = "C:\Users\35475\.gemini\antigravity\brain\da4525d0-dd3f-49d2-b210-477de3d1d6b0\.user_uploaded\media_1790166670902.jpg"
$baseDir = Split-Path -Parent $PSScriptRoot
$iconsDir = Join-Path $baseDir "src-tauri\icons"
$assetsDir = Join-Path $baseDir "src\assets"
$publicDir = Join-Path $baseDir "public"

if (!(Test-Path $iconsDir)) { New-Item -ItemType Directory -Path $iconsDir -Force }
if (!(Test-Path $assetsDir)) { New-Item -ItemType Directory -Path $assetsDir -Force }
if (!(Test-Path $publicDir)) { New-Item -ItemType Directory -Path $publicDir -Force }

$origImg = [System.Drawing.Image]::FromFile($srcPath)

function Resize-Image($source, $targetPath, [int]$width, [int]$height) {
    $bmp = New-Object System.Drawing.Bitmap $width, $height
    $graph = [System.Drawing.Graphics]::FromImage($bmp)
    $graph.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graph.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graph.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graph.DrawImage($source, 0, 0, $width, $height)
    $bmp.Save($targetPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $graph.Dispose()
    $bmp.Dispose()
}

# 1. 保存清晰头像
Resize-Image $origImg (Join-Path $assetsDir "avatar.png") 512 512
Resize-Image $origImg (Join-Path $publicDir "avatar.png") 512 512

# 2. 生成 Tauri 标准尺寸 PNG
Resize-Image $origImg (Join-Path $iconsDir "32x32.png") 32 32
Resize-Image $origImg (Join-Path $iconsDir "128x128.png") 128 128
Resize-Image $origImg (Join-Path $iconsDir "128x128@2x.png") 256 256
Resize-Image $origImg (Join-Path $iconsDir "icon.png") 512 512

# 3. 生成多尺寸打包规范图片
Resize-Image $origImg (Join-Path $iconsDir "Square30x30Logo.png") 30 30
Resize-Image $origImg (Join-Path $iconsDir "Square44x44Logo.png") 44 44
Resize-Image $origImg (Join-Path $iconsDir "Square71x71Logo.png") 71 71
Resize-Image $origImg (Join-Path $iconsDir "Square89x89Logo.png") 89 89
Resize-Image $origImg (Join-Path $iconsDir "Square107x107Logo.png") 107 107
Resize-Image $origImg (Join-Path $iconsDir "Square142x142Logo.png") 142 142
Resize-Image $origImg (Join-Path $iconsDir "Square150x150Logo.png") 150 150
Resize-Image $origImg (Join-Path $iconsDir "Square284x284Logo.png") 284 284
Resize-Image $origImg (Join-Path $iconsDir "Square310x310Logo.png") 310 310
Resize-Image $origImg (Join-Path $iconsDir "StoreLogo.png") 50 50

# 4. 生成多分辨率 Windows icon.ico
$icoSizes = 16, 32, 48, 64, 128, 256
$icoPngBuffers = New-Object System.Collections.ArrayList

foreach ($sz in $icoSizes) {
    $bmp = New-Object System.Drawing.Bitmap $sz, $sz
    $graph = [System.Drawing.Graphics]::FromImage($bmp)
    $graph.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graph.DrawImage($origImg, 0, 0, $sz, $sz)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    [void]$icoPngBuffers.Add(@($sz, $ms.ToArray()))
    $graph.Dispose()
    $bmp.Dispose()
    $ms.Dispose()
}

$icoPath = Join-Path $iconsDir "icon.ico"
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter $fs

$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$icoPngBuffers.Count)

$offset = 6 + ($icoPngBuffers.Count * 16)
foreach ($elem in $icoPngBuffers) {
    $sz = $elem[0]
    $data = $elem[1]
    
    $bWidth = if ($sz -ge 256) { [byte]0 } else { [byte]$sz }
    $bHeight = if ($sz -ge 256) { [byte]0 } else { [byte]$sz }
    $bw.Write($bWidth)
    $bw.Write($bHeight)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$data.Length)
    $bw.Write([uint32]$offset)
    
    $offset += $data.Length
}

foreach ($elem in $icoPngBuffers) {
    $data = $elem[1]
    $bw.Write($data)
}

$bw.Close()
$fs.Close()
$origImg.Dispose()

Write-Output "ALL_DONE_SUCCESS"
