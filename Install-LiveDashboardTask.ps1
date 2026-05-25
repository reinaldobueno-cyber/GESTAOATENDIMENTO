[CmdletBinding()]
param(
  [string]$TaskName = 'Atualizar Dashboard NEPPO',
  [int]$IntervalMinutes = 30
)

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$secretDir = Join-Path $scriptDir 'secrets'
$secretPath = Join-Path $secretDir 'neppo-token.clixml'
$updateScript = Join-Path $scriptDir 'Update-LiveDashboard.ps1'

if (!(Test-Path -LiteralPath $updateScript)) {
  throw "Atualizador não encontrado: $updateScript"
}

if (!(Test-Path -LiteralPath $secretDir)) {
  New-Item -ItemType Directory -Path $secretDir | Out-Null
}

Write-Host ''
Write-Host 'Cole o NEPPO_TOKEN quando a janela pedir.'
Write-Host 'Ele será salvo criptografado para o seu usuário do Windows.'
$secureToken = Read-Host 'NEPPO_TOKEN' -AsSecureString
if ($secureToken.Length -eq 0) {
  throw 'Token vazio. Instalação cancelada.'
}
$secureToken | Export-Clixml -LiteralPath $secretPath

$powershell = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($powershell)) {
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
}

$argument = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $updateScript
$action = New-ScheduledTaskAction -Execute $powershell -Argument $argument -WorkingDirectory $scriptDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel LeastPrivilege
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
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
Write-Host 'Fazendo uma primeira atualização agora...'
& $updateScript
