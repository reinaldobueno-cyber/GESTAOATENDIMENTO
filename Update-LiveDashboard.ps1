[CmdletBinding()]
param(
  [int]$Year = 2026,
  [int]$StartMonth = 1,
  [int]$EndMonth = 0,
  [string]$ExportDir = 'exports',
  [switch]$DeployCloudflare,
  [switch]$SkipPush,
  [switch]$SkipCmax,
  [switch]$FastCurrentMonth
)

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location -LiteralPath $scriptDir

$credentialPath = Join-Path $scriptDir 'secrets\neppo-credentials.clixml'
if (Test-Path -LiteralPath $credentialPath) {
  $credentials = Import-Clixml -LiteralPath $credentialPath
  foreach ($name in @('NEPPO_CLIENT_KEY', 'NEPPO_CLIENT_SECRET', 'NEPPO_USERNAME', 'NEPPO_PASSWORD')) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process')) -and $credentials.$name) {
      [Environment]::SetEnvironmentVariable($name, [System.Net.NetworkCredential]::new('', $credentials.$name).Password, 'Process')
    }
  }
  $env:NEPPO_TOKEN = ''
}

$secretPath = Join-Path $scriptDir 'secrets\neppo-token.clixml'
if ([string]::IsNullOrWhiteSpace($env:NEPPO_TOKEN) -and !(Test-Path -LiteralPath $credentialPath) -and (Test-Path -LiteralPath $secretPath)) {
  $secureToken = Import-Clixml -LiteralPath $secretPath
  $env:NEPPO_TOKEN = [System.Net.NetworkCredential]::new('', $secureToken).Password
}

if ($EndMonth -le 0) {
  $EndMonth = [int](Get-Date).Month
}
if ($FastCurrentMonth) {
  $StartMonth = $EndMonth
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
  -MergeExistingCsv:$FastCurrentMonth `
  -NoMirrorRoot

Write-Host 'Atualizando mapa privado de clientes...'
$cmaxContacts = Join-Path $scriptDir 'exports\cmax-contatos.csv'
$cmaxTokenPath = Join-Path $scriptDir 'secrets\cmax-jwt.clixml'
if ($SkipCmax) {
  Write-Host 'Pulando CMAX nesta atualização rápida. Usando o último arquivo CMAX disponível, se existir.'
} elseif ((Test-Path -LiteralPath $cmaxTokenPath) -or ![string]::IsNullOrWhiteSpace($env:CMAX_JWT_TOKEN)) {
  try {
    Write-Host 'Exportando contatos CMAX para apoio de identificação...'
    & (Join-Path $scriptDir 'Export-CmaxContacts.ps1') -OutputPath $cmaxContacts
  }
  catch {
    Write-Warning "Não consegui exportar CMAX agora. Vou seguir sem travar a atualização. $($_.Exception.Message)"
  }
}

$auxContacts = if (Test-Path -LiteralPath $cmaxContacts) {
  $cmaxContacts
} else {
  Join-Path $env:USERPROFILE 'Downloads\Contatos_xzxix85h06jiflnt0emoi.csv'
}
$mapArgs = @{
  ClientMonthPath = (Join-Path $ExportDir 'clientes-por-mes.csv')
}
if (Test-Path -LiteralPath $auxContacts) {
  $mapArgs.AuxContactsPath = $auxContacts
}
& (Join-Path $scriptDir 'Atualizar-Mapa-Clientes-Privados.ps1') @mapArgs

Write-Host 'Mascarando dados sensíveis do HTML público...'
& (Join-Path $scriptDir 'Protect-PublicDashboardData.ps1') -HtmlPath (Join-Path $scriptDir 'index.html')

Write-Host 'Verificando alterações para publicar...'
& $git add index.html src/private-client-map.js cliente-map-privado.csv cliente-map-privado.js exports/atendimentos-neppo.csv exports/clientes-por-mes.csv exports/clientes-identificacao-relatorio.csv
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
