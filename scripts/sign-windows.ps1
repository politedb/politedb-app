param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PATH)) {
  throw "Missing WINDOWS_CERTIFICATE_PATH for Windows code signing."
}

if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PASSWORD)) {
  throw "Missing WINDOWS_CERTIFICATE_PASSWORD for Windows code signing."
}

if (!(Test-Path -LiteralPath $env:WINDOWS_CERTIFICATE_PATH)) {
  throw "Windows signing certificate not found: $env:WINDOWS_CERTIFICATE_PATH"
}

if (!(Test-Path -LiteralPath $Path)) {
  throw "File to sign not found: $Path"
}

$timestampUrl = if ([string]::IsNullOrWhiteSpace($env:WINDOWS_TIMESTAMP_URL)) {
  "http://timestamp.digicert.com"
} else {
  $env:WINDOWS_TIMESTAMP_URL
}

$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
  Sort-Object FullName -Descending |
  Select-Object -First 1

if ($null -eq $signtool) {
  throw "signtool.exe not found in Windows SDK."
}

Write-Host "Signing $Path"
& $signtool.FullName sign `
  /f $env:WINDOWS_CERTIFICATE_PATH `
  /p $env:WINDOWS_CERTIFICATE_PASSWORD `
  /fd SHA256 `
  /tr $timestampUrl `
  /td SHA256 `
  $Path

if ($LASTEXITCODE -ne 0) {
  throw "signtool failed with exit code $LASTEXITCODE."
}
