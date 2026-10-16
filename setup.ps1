[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
$infraDir = Join-Path $repoRoot 'infrastructure'
$examplePath = Join-Path $infraDir '.env.example'
$envPath = Join-Path $infraDir '.env'
$composePath = Join-Path $infraDir 'docker-compose.yml'

Write-Host 'CodeCollab local development setup' -ForegroundColor Cyan
Write-Host "Repository: $repoRoot"

if (-not (Test-Path $composePath -PathType Leaf)) {
    throw "Could not find infrastructure/docker-compose.yml. Save setup.ps1 in the CodeCollab repository root."
}
if (-not (Test-Path $examplePath -PathType Leaf)) {
    throw "Could not find infrastructure/.env.example. No files were changed."
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
    Write-Warning 'Docker CLI was not found. Install Docker Desktop before running start.ps1.'
} else {
    $composeVersion = & docker compose version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Docker Compose v2 was not found. Update/install Docker Desktop before running start.ps1.'
    } else {
        Write-Host "Found $composeVersion" -ForegroundColor Green
    }
}

function New-CodeCollabSecret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return [System.BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

if (Test-Path $envPath -PathType Leaf) {
    Write-Host 'infrastructure/.env already exists; preserving it.' -ForegroundColor Yellow
    $envText = [System.IO.File]::ReadAllText($envPath)
    $placeholderKeys = @('JWT_SECRET', 'MONGO_ROOT_PASSWORD', 'MONGO_APP_PASSWORD', 'REDIS_PASSWORD')
    $unresolved = @()
    foreach ($key in $placeholderKeys) {
        if ($envText -match "(?m)^$key=\s*replace_with_") {
            $unresolved += $key
        }
    }
    if ($unresolved.Count -gt 0) {
        throw "infrastructure/.env still contains template placeholders for: $($unresolved -join ', '). Replace those values, then rerun setup.ps1. Existing configuration was not overwritten."
    }
} else {
    $envText = [System.IO.File]::ReadAllText($examplePath)
    $secretValues = @{
        JWT_SECRET = New-CodeCollabSecret
        MONGO_ROOT_PASSWORD = New-CodeCollabSecret
        MONGO_APP_PASSWORD = New-CodeCollabSecret
        REDIS_PASSWORD = New-CodeCollabSecret
    }

    foreach ($key in $secretValues.Keys) {
        $envText = [System.Text.RegularExpressions.Regex]::Replace(
            $envText,
            "(?m)^$key=.*$",
            "$key=$($secretValues[$key])"
        )
    }

    [System.IO.Directory]::CreateDirectory($infraDir) | Out-Null
    [System.IO.File]::WriteAllText($envPath, $envText, [System.Text.UTF8Encoding]::new($false))
    Write-Host 'Created infrastructure/.env with unique local secrets.' -ForegroundColor Green
    Write-Host 'Secret values were not printed. Keep this file local and never commit it.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Setup complete.' -ForegroundColor Green
Write-Host 'Next: run .\start.ps1 from this repository root.'
Write-Host 'This configuration is for trusted local development only; it does not qualify production sandbox security.' -ForegroundColor Yellow
