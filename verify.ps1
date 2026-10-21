[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$envPath = Join-Path $PSScriptRoot 'infrastructure\.env'
$composePath = Join-Path $PSScriptRoot 'infrastructure\docker-compose.yml'
$issues = [System.Collections.Generic.List[string]]::new()
$services = @('mongo', 'redis', 'backend', 'frontend', 'execution-daemon', 'execution-worker')
$images = @('codecollab-runner-python:latest', 'codecollab-runner-cpp:latest', 'codecollab-runner-java:latest')
$states = @{}

Write-Host 'CodeCollab local verification' -ForegroundColor Cyan
Write-Warning 'Local development only. This does not qualify cgroup enforcement or gVisor for production.'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker CLI not found. Install/start Docker Desktop.'
}
if (-not (Test-Path $envPath -PathType Leaf)) {
    throw 'infrastructure\.env is missing. Run .\setup.ps1 first.'
}
if (-not (Test-Path $composePath -PathType Leaf)) {
    throw 'infrastructure\docker-compose.yml is missing. Run this from the repository root.'
}

$null = & docker compose version 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose is unavailable. Check Docker Desktop.' }
$null = & docker info 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Docker engine is unreachable. Start Docker Desktop and select Linux containers.' }

$argsForCompose = @('--env-file', $envPath, '-f', $composePath)

Write-Host "`nServices" -ForegroundColor Cyan
foreach ($service in $services) {
    $idLines = @(& docker compose @argsForCompose ps -q $service 2>$null)
    $composeExitCode = $LASTEXITCODE
    $id = $idLines | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -First 1
    if ($composeExitCode -ne 0 -or [string]::IsNullOrWhiteSpace([string]$id)) {
        $issues.Add("$service container is missing; run .\start.ps1.")
        Write-Host "FAIL $service - missing; run .\start.ps1" -ForegroundColor Red
        continue
    }

    $detail = & docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' $id 2>&1
    if ($LASTEXITCODE -ne 0) {
        $issues.Add("Could not inspect $service.")
        Write-Host "FAIL $service - inspect failed" -ForegroundColor Red
        continue
    }

    $parts = ([string](@($detail)[0])) -split '\|', 2
    if ($parts.Count -lt 2) {
        $issues.Add("Unexpected status for $service.")
        Write-Host "FAIL $service - status could not be parsed" -ForegroundColor Red
        continue
    }

    $status = $parts[0]
    $health = $parts[1]
    $states[$service] = @{ Status = $status; Health = $health }

    if ($status -ne 'running' -or $health -in @('unhealthy', 'starting')) {
        $issues.Add("$service is status=$status health=$health.")
        Write-Host "FAIL $service - status=$status health=$health" -ForegroundColor Red
    } elseif ($health -eq 'no-healthcheck') {
        Write-Host "PASS $service - running (no healthcheck configured)" -ForegroundColor Green
    } else {
        Write-Host "PASS $service - $health" -ForegroundColor Green
    }
}

Write-Host "`nHTTP endpoints" -ForegroundColor Cyan
foreach ($endpoint in @(
    [pscustomobject]@{ Name = 'Frontend'; Uri = 'http://localhost:3000' },
    [pscustomobject]@{ Name = 'Backend health'; Uri = 'http://localhost:5000/health' }
)) {
    try {
        $response = Invoke-WebRequest -Uri $endpoint.Uri -TimeoutSec 5 -UseBasicParsing
        if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400) {
            Write-Host "PASS $($endpoint.Name) - HTTP $($response.StatusCode)" -ForegroundColor Green
        } else {
            $issues.Add("$($endpoint.Name) returned HTTP $($response.StatusCode).")
            Write-Host "FAIL $($endpoint.Name) - HTTP $($response.StatusCode)" -ForegroundColor Red
        }
    } catch {
        $issues.Add("$($endpoint.Name) is unreachable at $($endpoint.Uri).")
        Write-Host "FAIL $($endpoint.Name) - unreachable" -ForegroundColor Red
    }
}

Write-Host "`nRunner images in isolated execution daemon" -ForegroundColor Cyan
$daemon = $states['execution-daemon']
if ($null -eq $daemon -or $daemon.Status -ne 'running' -or $daemon.Health -in @('unhealthy', 'starting')) {
    $issues.Add('Runner image checks skipped because execution-daemon is not healthy.')
} else {
    foreach ($image in $images) {
        $result = & docker compose @argsForCompose exec -T execution-daemon docker -H tcp://127.0.0.1:2375 image inspect --format '{{.Id}}' $image 2>&1
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string](@($result)[0]))) {
            $issues.Add("$image is missing from execution-daemon; run .\start.ps1.")
            Write-Host "FAIL $image - missing; run .\start.ps1" -ForegroundColor Red
        } else {
            Write-Host "PASS $image - present" -ForegroundColor Green
        }
    }
}

Write-Host "`nSummary" -ForegroundColor Cyan
if ($issues.Count -gt 0) {
    foreach ($issue in $issues) { Write-Host "- $issue" -ForegroundColor Yellow }
    throw "Verification failed: $($issues.Count) check(s) need attention."
}
Write-Host 'PASS: services, endpoints, and runner images are available.' -ForegroundColor Green
Write-Host 'Production sandbox qualification remains a separate process.' -ForegroundColor Yellow