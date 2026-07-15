[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location -LiteralPath $scriptDir

$logDir = Join-Path $scriptDir 'logs'
if (!(Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}
$logPath = Join-Path $logDir 'neppo-rapido.log'
$lockPath = Join-Path $env:TEMP 'gestao-atendimento-neppo-rapido.lock'
$updateTimeoutMinutes = 25

function Write-NeppoLog {
  param([string]$Message)
  try {
    $Message | Add-Content -LiteralPath $logPath -Encoding UTF8
  } catch {
    Write-Host $Message
  }
}

function Stop-NeppoProcessTree {
  param([int]$ProcessId)

  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Stop-NeppoProcessTree -ProcessId ([int]$child.ProcessId)
  }

  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

$lockStream = $null
try {
  $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch {
  Write-NeppoLog "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Atualizacao ignorada: outra execucao ainda esta em andamento."
  exit 0
}

$month = [int](Get-Date).Month
Write-Host ''
Write-Host 'Atualizacao rapida NEPPO'
Write-Host 'Atualiza o mes atual, valida HTML x CSV e publica no Cloudflare.'
Write-Host 'Pula CMAX, mapa privado, commit e push para reduzir o tempo.'
Write-Host ''

try {
  Write-NeppoLog "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Inicio atualizacao rapida"

  $runId = Get-Date -Format 'yyyyMMddHHmmss'
  $stdoutPath = Join-Path $env:TEMP "gestao-neppo-update-$runId.out.log"
  $stderrPath = Join-Path $env:TEMP "gestao-neppo-update-$runId.err.log"
  $updateScript = Join-Path $scriptDir 'Update-LiveDashboard.ps1'
  $args = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $updateScript,
    '-Year', '2026',
    '-EndMonth', [string]$month,
    '-FastCurrentMonth',
    '-SkipCmax',
    '-SkipClientMap',
    '-NoCommit',
    '-DeployCloudflare',
    '-SkipPush'
  )

  $process = Start-Process `
    -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source `
    -ArgumentList $args `
    -WorkingDirectory $scriptDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

  $completed = $process.WaitForExit([TimeSpan]::FromMinutes($updateTimeoutMinutes).TotalMilliseconds)
  if (!$completed) {
    Write-NeppoLog "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ERRO: atualizacao excedeu $updateTimeoutMinutes minutos. Encerrando processo travado PID $($process.Id)."
    Stop-NeppoProcessTree -ProcessId $process.Id
    throw "Atualizacao NEPPO excedeu $updateTimeoutMinutes minutos e foi encerrada para liberar o proximo ciclo."
  }
  $process.WaitForExit()
  $process.Refresh()

  $stdout = ''
  if (Test-Path -LiteralPath $stdoutPath) {
    $stdout = Get-Content -LiteralPath $stdoutPath -Raw
    $stdout | Add-Content -LiteralPath $logPath -Encoding UTF8
  }
  $stderr = ''
  if (Test-Path -LiteralPath $stderrPath) {
    $stderr = Get-Content -LiteralPath $stderrPath -Raw
    if (![string]::IsNullOrWhiteSpace($stderr)) {
      $stderr | Add-Content -LiteralPath $logPath -Encoding UTF8
    }
  }

  $exitCode = $process.ExitCode
  $successMarker = $stdout -match 'Atualizacao rapida concluida'
  if ($null -eq $exitCode -and $successMarker -and [string]::IsNullOrWhiteSpace($stderr)) {
    Write-NeppoLog "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Aviso: processo terminou sem ExitCode, mas publicou com sucesso confirmado pelo log."
    $exitCode = 0
  }

  if ($exitCode -ne 0) {
    throw "Update-LiveDashboard falhou com codigo $exitCode."
  }

  Write-NeppoLog "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Fim atualizacao rapida"
}
catch {
  Write-NeppoLog "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ERRO: $($_.Exception.Message)"
  throw
}
finally {
  if ($lockStream) {
    $lockStream.Dispose()
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  }
}
