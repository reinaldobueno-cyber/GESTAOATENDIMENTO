[CmdletBinding()]
param(
  [string]$TaskName = 'Atualizar Dashboard NEPPO',
  [int]$IntervalMinutes = 5,
  [switch]$ResetToken
)

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$secretDir = Join-Path $scriptDir 'secrets'
$secretPath = Join-Path $secretDir 'neppo-token.clixml'
$credentialPath = Join-Path $secretDir 'neppo-credentials.clixml'
$updateScript = Join-Path $scriptDir 'Update-LiveDashboard.ps1'

if (!(Test-Path -LiteralPath $updateScript)) {
  throw "Atualizador não encontrado: $updateScript"
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

$powershell = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($powershell)) {
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
}

$argument = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -DeployCloudflare -SkipPush -SkipCmax -FastCurrentMonth' -f $updateScript
$action = New-ScheduledTaskAction -Execute $powershell -Argument $argument -WorkingDirectory $scriptDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$userId = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 12) `
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
Write-Host 'Fazendo uma primeira atualização agora e publicando no Cloudflare...'
& $updateScript -DeployCloudflare -SkipPush -SkipCmax -FastCurrentMonth
