# Windows.Media.Ocr 本地批量 OCR (zh-Hans-CN) — 零配额离线提取图片文字
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File winocr.ps1 -ImgDir <目录> -OutFile <输出txt> [-Recurse]
param(
  [Parameter(Mandatory=$true)][string]$ImgDir,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [switch]$Recurse
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

[Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait()
  return $task.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language('zh-Hans-CN')))
if (-not $engine) { Write-Error 'OCR 引擎不可用(zh-Hans-CN)'; exit 1 }

$gciParams = @{ Path = $ImgDir; File = $true }
if ($Recurse) { $gciParams.Recurse = $true }
$files = Get-ChildItem @gciParams | Where-Object { $_.Extension -match '\.(jpg|jpeg|png|bmp|webp)$' } | Sort-Object FullName
$total = $files.Count
Write-Output "OCR_DIR=$ImgDir FILES=$total"

$sw = [System.IO.StreamWriter]::new($OutFile, $false, [Text.Encoding]::UTF8)
$i = 0
foreach ($f in $files) {
  $i++
  try {
    $sf = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($f.FullName)) ([Windows.Storage.StorageFile])
    $stream = Await ($sf.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $sw.WriteLine("=== FILE: " + $f.FullName + " ===")
    foreach ($line in $res.Lines) { $sw.WriteLine($line.Text) }
    $sw.WriteLine()
    $stream.Dispose()
  } catch {
    $sw.WriteLine("=== FILE: " + $f.FullName + " [OCR_ERROR: " + $_.Exception.Message + "] ===")
  }
  if ($i % 50 -eq 0) { Write-Output ("progress " + $i + "/" + $total) }
}
$sw.Close()
Write-Output "DONE $i files -> $OutFile"
