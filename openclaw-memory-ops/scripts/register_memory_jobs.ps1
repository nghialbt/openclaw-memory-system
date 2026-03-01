$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
node "$scriptDir/memory_ops.mjs" register-jobs @args
