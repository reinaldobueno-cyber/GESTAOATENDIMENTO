[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$secretDir = Join-Path $scriptDir 'secrets'
$credentialPath = Join-Path $secretDir 'neppo-credentials.clixml'
$tokenPath = Join-Path $secretDir 'neppo-token.clixml'

if (!(Test-Path -LiteralPath $secretDir)) {
  New-Item -ItemType Directory -Path $secretDir | Out-Null
}

Write-Host ''
Write-Host 'Vamos salvar as 4 credenciais do NEPPO.'
Write-Host 'Elas ficam criptografadas para o seu usuário do Windows.'
Write-Host ''

$clientKey = Read-Host 'NEPPO_CLIENT_KEY' -AsSecureString
$clientSecret = Read-Host 'NEPPO_CLIENT_SECRET' -AsSecureString
$username = Read-Host 'NEPPO_USERNAME' -AsSecureString
$password = Read-Host 'NEPPO_PASSWORD' -AsSecureString

foreach ($item in @($clientKey, $clientSecret, $username, $password)) {
  if ($item.Length -eq 0) { throw 'Uma das credenciais veio vazia. Operação cancelada.' }
}

[pscustomobject]@{
  NEPPO_CLIENT_KEY = $clientKey
  NEPPO_CLIENT_SECRET = $clientSecret
  NEPPO_USERNAME = $username
  NEPPO_PASSWORD = $password
} | Export-Clixml -LiteralPath $credentialPath

if (Test-Path -LiteralPath $tokenPath) {
  Remove-Item -LiteralPath $tokenPath -Force
}

Write-Host ''
Write-Host 'Credenciais salvas. O token antigo foi removido para evitar 401.'
Write-Host 'Testando e publicando uma atualização agora...'
& (Join-Path $scriptDir 'Update-LiveDashboard.ps1')
