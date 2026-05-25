[CmdletBinding()]
param(
  [int]$Year = 2026,
  [int]$StartMonth = 1,
  [int]$EndMonth = 0,
  [string]$ExportDir = 'exports',
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

if ($SkipPush) {
  Write-Host 'Commit criado. Push ignorado por -SkipPush.'
  exit 0
}

& $git push
Write-Host 'Dashboard publicado no GitHub Pages.'
