[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
$infraDir = Join-Path $repoRoot 'infrastructure'
$envPath = Join-Path $infraDir '.env'
$composePath = Join-Path $infraDir 'docker-compose.yml'
$runnerDockerfile = Join-Path $repoRoot 'execution\runners\python\Dockerfile'
$runnerContext = Join-Path $repoRoot 'execution\runners\python'
$runnerImage = 'codecollab-runner-python:latest'
$daemonArchivePath = '/tmp/codecollab-runner-python.tar'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI was not found. Install/start Docker Desktop, then retry.'
}
if (-not (Test-Path $envPath -PathType Leaf)) {
    throw 'infrastructure/.env is missing. Run .\setup.ps1 first.'
}
if (-not (Test-Path $composePath -PathType Leaf) -or -not (Test-Path $runnerDockerfile -PathType Leaf)) {
    throw 'Required Compose or Python runner files are missing. Save this script in the CodeCollab repository root.'
}

$envText = [System.IO.File]::ReadAllText($envPath)
foreach ($key in @('JWT_SECRET', 'MONGO_ROOT_PASSWORD', 'MONGO_APP_PASSWORD', 'REDIS_PASSWORD')) {
    if ($envText -notmatch "(?m)^$key=\s*(?!\s*$).+") {
        throw "infrastructure/.env has an empty or missing $key. Run .\setup.ps1 and check the local configuration."
    }
    if ($envText -match "(?m)^$key=\s*replace_with_") {
        throw "infrastructure/.env still has a placeholder for $key. Run .\setup.ps1 or replace the local secret before starting."
    }
}

$composeVersion = & docker compose version 2>&1
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Compose v2 is required. Update/install Docker Desktop, then retry.'
}
$dockerInfo = & docker info 2>&1
if ($LASTEXITCODE -ne 0) {
    throw 'Docker engine is not reachable. Start Docker Desktop and ensure it is using Linux containers, then retry.'
}

$composeBase = @('--env-file', $envPath, '-f', $composePath)
$tempArchive = Join-Path ([System.IO.Path]::GetTempPath()) ("codecollab-python-" + [guid]::NewGuid().ToString('N') + '.tar')
$copiedToDaemon = $false

Write-Host 'Starting CodeCollab local development stack...' -ForegroundColor Cyan
Write-Warning 'LOCAL DEVELOPMENT ONLY: this profile permits unenforced inner cgroup controls. Do not expose this stack publicly or treat it as production-qualified.'
$originalErrorActionPreference = $ErrorActionPreference
# Docker emits advisory stderr notices; use the explicit exit-code checks below.
$ErrorActionPreference = 'Continue'

try {
    # Explicitly target the app services and the nested daemon, but not the worker yet.
    & docker compose @composeBase up -d --build mongo redis backend frontend execution-daemon
    if ($LASTEXITCODE -ne 0) {
        throw 'Compose failed while starting MongoDB, Redis, the app, or execution-daemon. Inspect: docker compose logs.'
    }

    Write-Host 'Waiting for the nested execution daemon...' -ForegroundColor Cyan
    $daemonReady = $false
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        $null = & docker compose @composeBase exec -T execution-daemon docker -H tcp://127.0.0.1:2375 info 2>&1
        if ($LASTEXITCODE -eq 0) {
            $daemonReady = $true
            break
        }
        Start-Sleep -Seconds 3
    }
    if (-not $daemonReady) {
        & docker compose @composeBase logs --tail 80 execution-daemon
        throw 'Execution daemon did not become ready within 90 seconds. Worker was not started.'
    }

    Write-Host 'Building Python 3.11 runner image in the local Docker engine...' -ForegroundColor Cyan
    & docker build -t $runnerImage -f $runnerDockerfile $runnerContext
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to build the Python runner image.'
    }

    Write-Host 'Transferring the Python runner image into the isolated execution daemon...' -ForegroundColor Cyan
    & docker image save --output $tempArchive $runnerImage
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to save the Python runner image archive.'
    }

    & docker compose @composeBase cp $tempArchive "execution-daemon:$daemonArchivePath"
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not copy the Python runner image into execution-daemon.'
    }
    $copiedToDaemon = $true

    & docker compose @composeBase exec -T execution-daemon docker -H tcp://127.0.0.1:2375 load -i $daemonArchivePath
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not load the Python runner image into the isolated execution daemon.'
    }

    & docker compose @composeBase exec -T execution-daemon docker -H tcp://127.0.0.1:2375 image inspect $runnerImage
    if ($LASTEXITCODE -ne 0) {
        throw 'Python runner image verification failed inside the isolated execution daemon.'
    }

    # Start the worker only after its expected runner image is present.
    Write-Host 'Starting the execution worker...' -ForegroundColor Cyan
    & docker compose @composeBase up -d --build execution-worker
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to start execution-worker.'
    }

    Write-Host 'Waiting for backend health endpoint...' -ForegroundColor Cyan
    $backendReady = $false
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri 'http://localhost:5000/health' -TimeoutSec 3 -UseBasicParsing
            if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400) {
                $backendReady = $true
                break
            }
        } catch {
            # The backend may still be starting; retry briefly.
        }
        Start-Sleep -Seconds 2
    }
    if (-not $backendReady) {
        & docker compose @composeBase logs --tail 80 backend execution-worker
        throw 'Backend did not become healthy within 60 seconds. See logs above.'
    }

    Write-Host ''
    Write-Host 'CodeCollab services are up.' -ForegroundColor Green
    Write-Host 'Frontend: http://localhost:3000'
    Write-Host 'Backend:  http://localhost:5000/health'
    Write-Host "Python image verified in execution-daemon: $runnerImage" -ForegroundColor Green
    Write-Host 'Try running print("Hello from CodeCollab!") from a room.'
    Write-Host 'Reminder: this is a trusted local development profile, not production security qualification.' -ForegroundColor Yellow

    & docker compose @composeBase ps
} finally {
    $ErrorActionPreference = $originalErrorActionPreference
    if ($copiedToDaemon) {
        $null = & docker compose @composeBase exec -u 0 -T execution-daemon sh -lc "rm -f $daemonArchivePath" 2>&1
    }
    if (Test-Path $tempArchive -PathType Leaf) {
        Remove-Item -LiteralPath $tempArchive -Force -ErrorAction SilentlyContinue
    }
}
