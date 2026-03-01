$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$localInstaller = Join-Path $scriptDir "install.mjs"

if (Test-Path $localInstaller) {
  node $localInstaller @args
  exit $LASTEXITCODE
}

# Support remote execution
$tmpRoot = Join-Path $env:TEMP ("openclaw-memory-system-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmpRoot | Out-Null

try {
  $zipPath = Join-Path $tmpRoot "repo.zip"
  Invoke-WebRequest -Uri "https://github.com/nghialbt/openclaw-memory-system/archive/refs/heads/main.zip" -OutFile $zipPath
  Expand-Archive -Path $zipPath -DestinationPath $tmpRoot -Force
  $installer = Join-Path $tmpRoot "openclaw-memory-system-main\install.mjs"
  node $installer @args
  exit $LASTEXITCODE
}
finally {
  Remove-Item -Path $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
}
