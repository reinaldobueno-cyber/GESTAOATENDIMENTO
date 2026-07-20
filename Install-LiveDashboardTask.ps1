[CmdletBinding()]
param(
  [string]$TaskName = 'Atualizar Dashboard NEPPO',
  [int]$IntervalMinutes = 5,
  [switch]$RunNow,
  [switch]$ResetToken
)

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$secretDir = Join-Path $scriptDir 'secrets'
$secretPath = Join-Path $secretDir 'neppo-token.clixml'
$credentialPath = Join-Path $secretDir 'neppo-credentials.clixml'
$updateScript = Join-Path $scriptDir 'Atualizar-NEPPO-Rapido.ps1'
$hiddenRunner = Join-Path $scriptDir 'Run-NEPPORapidoHidden.vbs'

if (!(Test-Path -LiteralPath $updateScript)) {
  throw "Atualizador não encontrado: $updateScript"
}
if (!(Test-Path -LiteralPath $hiddenRunner)) {
  throw "Executor oculto não encontrado: $hiddenRunner"
}

if (!(Test-Path -LiteralPath $secretDir)) {
  New-Item -ItemType Directory -Path $secretDir | Out-Null
}

if ($ResetToken -and (Test-Path -LiteralPath $secretPath)) {
  Remove-Item -LiteralPath $secretPath -Force
}

if (!(Test-Path -LiteralPath $secretPath) -and !(Test-Path -LiteralPath $credentialPath)) {
  Write-Host ''
  Write-Host 'Cole o NEPPO_TOKEN quando a janela pedir.'
  Write-Host 'Ele será salvo criptografado para o seu usuário do Windows.'
  $secureToken = Read-Host 'NEPPO_TOKEN' -AsSecureString
  if ($secureToken.Length -eq 0) {
    throw 'Token vazio. Instalação cancelada.'
  }
  $secureToken | Export-Clixml -LiteralPath $secretPath
} elseif (Test-Path -LiteralPath $credentialPath) {
  Write-Host 'Credenciais NEPPO locais encontradas. Vou reutilizar as credenciais salvas.'
} else {
  Write-Host 'Token local já encontrado. Vou reutilizar o token salvo.'
}

$wscript = (Get-Command wscript.exe -ErrorAction Stop).Source

$argument = '"{0}"' -f $hiddenRunner
$action = New-ScheduledTaskAction -Execute $wscript -Argument $argument -WorkingDirectory $scriptDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$userId = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 35) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

Write-Host ''
Write-Host "Tarefa instalada: $TaskName"
Write-Host "Intervalo: a cada $IntervalMinutes minutos"
if ($RunNow) {
  Write-Host 'Fazendo uma primeira atualização rápida agora sem publicar automaticamente no Cloudflare...'
  & $updateScript
} else {
  Write-Host 'Primeira execução agendada para daqui a aproximadamente 1 minuto.'
}

