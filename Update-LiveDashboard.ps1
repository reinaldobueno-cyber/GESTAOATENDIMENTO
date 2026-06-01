[CmdletBinding()]
param(
  [int]$Year = 2026,
  [int]$StartMonth = 1,
  [int]$EndMonth = 0,
  [string]$ExportDir = 'exports',
  [switch]$DeployCloudflare,
  [switch]$SkipPush
)

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location -LiteralPath $scriptDir

$secretPath = Join-Path $scriptDir 'secrets\neppo-token.clixml'
if ([string]::IsNullOrWhiteSpace($env:NEPPO_TOKEN) -and (Test-Path -LiteralPath $secretPath)) {
  $secureToken = Import-Clixml -LiteralPath $secretPath
  $env:NEPPO_TOKEN = [System.Net.NetworkCredential]::new('', $secureToken).Password
}

$credentialPath = Join-Path $scriptDir 'secrets\neppo-credentials.clixml'
if (Test-Path -LiteralPath $credentialPath) {
  $credentials = Import-Clixml -LiteralPath $credentialPath
  foreach ($name in @('NEPPO_CLIENT_KEY', 'NEPPO_CLIENT_SECRET', 'NEPPO_USERNAME', 'NEPPO_PASSWORD')) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process')) -and $credentials.$name) {
      [Environment]::SetEnvironmentVariable($name, [System.Net.NetworkCredential]::new('', $credentials.$name).Password, 'Process')
    }
  }
}

if ($EndMonth -le 0) {
  $EndMonth = [int](Get-Date).Month
}

function Find-Git {
  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $candidates = @(
    "$env:LOCALAPPDATA\GitHubDesktop\app-3.5.8\resources\app\git\cmd\git.exe",
    "$env:ProgramFiles\Git\cmd\git.exe",
    "${env:ProgramFiles(x86)}\Git\cmd\git.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }

  throw 'Git não encontrado. Instale o Git ou abra pelo GitHub Desktop.'
}

$git = Find-Git

Write-Host "Atualizando dashboard NEPPO ao vivo ($Year/$StartMonth até $Year/$EndMonth)..."
& (Join-Path $scriptDir 'sync-neppo-data.ps1') `
  -Year $Year `
  -StartMonth $StartMonth `
  -EndMonth $EndMonth `
  -ExportDir $ExportDir `
  -NoMirrorRoot

Write-Host 'Mascarando dados sensíveis do HTML público...'
& (Join-Path $scriptDir 'Protect-PublicDashboardData.ps1') -HtmlPath (Join-Path $scriptDir 'index.html')

Write-Host 'Verificando alterações para publicar...'
& $git add index.html
$hasChanges = $true
& $git diff --cached --quiet
if ($LASTEXITCODE -eq 0) { $hasChanges = $false }

if (-not $hasChanges) {
  Write-Host 'Sem alterações para publicar.'
  exit 0
}

& $git config user.name 'reinaldobueno-cyber'
& $git config user.email 'actions@users.noreply.github.com'
& $git commit -m 'Atualiza dashboard NEPPO ao vivo'

if ($DeployCloudflare -or -not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) {
  Write-Host 'Publicando dashboard atualizado no Cloudflare...'
  $env:CLOUDFLARE_API_KEY = ''
  $env:CLOUDFLARE_EMAIL = ''
  $env:PATH = "$env:LOCALAPPDATA\CodexTools\node-v22;$env:PATH"
  & npm exec --yes wrangler@latest -- deploy
  if ($LASTEXITCODE -ne 0) {
    throw "Deploy Cloudflare falhou com codigo $LASTEXITCODE."
  }
}

if ($SkipPush) {
  Write-Host 'Commit criado. Push ignorado por -SkipPush.'
  exit 0
}

& $git push
Write-Host 'Dashboard publicado no GitHub Pages.'
