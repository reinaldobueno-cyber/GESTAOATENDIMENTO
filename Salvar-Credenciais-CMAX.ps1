[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$secretDir = Join-Path $scriptDir 'secrets'
$tokenPath = Join-Path $secretDir 'cmax-jwt.clixml'

if (!(Test-Path -LiteralPath $secretDir)) {
  New-Item -ItemType Directory -Path $secretDir | Out-Null
}

Write-Host ''
Write-Host 'Vamos salvar o token JWT do CMAX WEB.'
Write-Host 'Ele fica criptografado para o seu usuário do Windows e não entra no Git.'
Write-Host 'Cole apenas o valor depois de "JWT", sem escrever "JWT" no início.'
Write-Host ''

$token = Read-Host 'CMAX_JWT_TOKEN' -AsSecureString
if ($token.Length -eq 0) { throw 'Token vazio. Operação cancelada.' }

$token | Export-Clixml -LiteralPath $tokenPath

Write-Host ''
Write-Host 'Token CMAX salvo.'
Write-Host 'Agora vou tentar exportar contatos para validar o acesso.'
& (Join-Path $scriptDir 'Export-CmaxContacts.ps1')
