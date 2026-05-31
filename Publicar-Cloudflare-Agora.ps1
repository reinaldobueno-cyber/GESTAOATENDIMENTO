[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location -LiteralPath $scriptDir

Write-Host ''
Write-Host 'Publicacao direta no Cloudflare Worker.'
Write-Host 'O token digitado ficara oculto e nao sera salvo no Git.'
Write-Host ''

$secureToken = Read-Host 'CLOUDFLARE_API_TOKEN' -AsSecureString
if ($secureToken.Length -eq 0) {
  throw 'Token vazio. Operacao cancelada.'
}

$token = [System.Net.NetworkCredential]::new('', $secureToken).Password
$env:CLOUDFLARE_API_TOKEN = $token
$env:PATH = "$env:LOCALAPPDATA\CodexTools\node-v22;$env:PATH"

Write-Host ''
Write-Host 'Validando token...'
npm exec --yes wrangler@latest -- whoami

Write-Host ''
Write-Host 'Publicando Worker...'
npm exec --yes wrangler@latest -- deploy

Write-Host ''
Write-Host 'Publicado com sucesso:'
Write-Host 'https://gestaoatendimento.reinaldo-bueno.workers.dev/bonificacao.html'
