[CmdletBinding()]
param([ValidateRange(1024,65535)][int]$Port = 8000)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonExe = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) {
    throw 'Missing .venv. Follow README to create a Python environment and install apps/api/requirements.lock.'
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'apps\web\dist\index.html'))) {
    throw 'Frontend build missing. Run npm ci and npm run build in apps/web first.'
}
Push-Location -LiteralPath $projectRoot
try {
    Write-Host "AgentOps RCA: http://127.0.0.1:$Port  (Ctrl+C to stop)"
    & $pythonExe -m uvicorn apps.api.main:app --host 127.0.0.1 --port $Port
    if ($LASTEXITCODE -ne 0) { throw 'Server exited with an error. Check whether the port is already in use.' }
} finally { Pop-Location }
