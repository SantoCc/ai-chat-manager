# 干净打包：生成 Edge 上架用 zip
# 用法: powershell -ExecutionPolicy Bypass -File .\store\pack-extension.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not (Test-Path (Join-Path $root "manifest.json"))) {
  $root = "c:\Users\Administrator\Desktop\ai-chat-manager"
}

$manifest = Get-Content (Join-Path $root "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
$outDir = [Environment]::GetFolderPath("Desktop")
$zipPath = Join-Path $outDir ("ai-chat-manager-edge-{0}.zip" -f $version)
$stage = Join-Path $env:TEMP ("acm-edge-pack-" + [guid]::NewGuid().ToString("N"))

$includeDirs = @("background", "content", "icons", "lib", "sidepanel", "utils")
$includeFiles = @("manifest.json", "LICENSE")

# icons 内排除生成器
$iconExclude = @("generate-icons.html", "generate-icons.ps1")

New-Item -ItemType Directory -Path $stage | Out-Null

foreach ($d in $includeDirs) {
  $src = Join-Path $root $d
  if (-not (Test-Path $src)) { continue }
  $dest = Join-Path $stage $d
  Copy-Item $src $dest -Recurse
}

foreach ($f in $includeFiles) {
  $src = Join-Path $root $f
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $stage $f)
  }
}

foreach ($name in $iconExclude) {
  $p = Join-Path $stage "icons\$name"
  if (Test-Path $p) { Remove-Item $p -Force }
}

# 校验关键文件
$required = @(
  "manifest.json",
  "icons\icon16.png",
  "icons\icon32.png",
  "icons\icon48.png",
  "icons\icon128.png",
  "background\service-worker.js",
  "sidepanel\panel.html"
)
foreach ($r in $required) {
  $p = Join-Path $stage $r
  if (-not (Test-Path $p)) {
    throw "Missing required file in package: $r"
  }
}

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath)

Remove-Item $stage -Recurse -Force

Write-Host "OK: $zipPath"
Write-Host "Tip: Unzip and confirm manifest.json is at the ZIP root (not inside a subfolder)."
