# 生成扩展图标
# 双击运行或在 PowerShell 中执行: .\generate-icons.ps1

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sizes = @(16, 32, 48, 128)

Add-Type -AssemblyName System.Drawing

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    # 蓝色圆角背景
    $bgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0, 120, 212))
    $radius = [int]($size * 0.18)
    $g.FillRectangle($bgBrush, 0, 0, $size, $size)

    # 白色对话气泡
    $whiteBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $bx = [int]($size * 0.2)
    $by = [int]($size * 0.22)
    $bw = [int]($size * 0.6)
    $bh = [int]($size * 0.38)
    $g.FillRectangle($whiteBrush, $bx, $by, $bw, $bh)

    # 黄色文件夹
    $folderBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 215, 0))
    $fx = [int]($size * 0.25)
    $fy = [int]($size * 0.62)
    $fw = [int]($size * 0.5)
    $fh = [int]($size * 0.22)
    $g.FillRectangle($folderBrush, $fx, $fy, $fw, $fh)

    $path = Join-Path $scriptDir "icon$size.png"
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

    $g.Dispose()
    $bmp.Dispose()
    Write-Host "Created: $path"
}

Write-Host "Done! All icons generated."
