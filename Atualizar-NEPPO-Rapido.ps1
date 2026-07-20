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

function Read-NewProcessOutput {
  param(
    [string]$Path,
    [long]$Offset
  )

  if (!(Test-Path -LiteralPath $Path)) {
    return [pscustomobject]@{ Text = ''; Offset = $Offset }
  }

  $stream = $null
  $reader = $null
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    if ($Offset -gt $stream.Length) { $Offset = 0 }
    $stream.Seek($Offset, [System.IO.SeekOrigin]::Begin) | Out-Null
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
    $text = $reader.ReadToEnd()
    return [pscustomobject]@{ Text = $text; Offset = $stream.Position }
  } catch {
    return [pscustomobject]@{ Text = ''; Offset = $Offset }
  } finally {
    if ($reader) { $reader.Dispose() }
    elseif ($stream) { $stream.Dispose() }
  }
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
Write-Host 'Atualiza o mes atual localmente. Publicacao automatica no Cloudflare fica bloqueada por padrao.'
Write-Host 'Pula CMAX, mapa privado, commit e push para reduzir o tempo.'
Write-Host ''

try {
  Write-NeppoLog "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Inicio atualizacao rapida"

  $runId = Get-Date -Format 'yyyyMMddHHmmss'
  $stdoutPath = Join-Path $env:TEMP "gestao-neppo-update-$runId.out.log"
  $stderrPath = Join-Path $env:TEMP "gestao-neppo-update-$runId.err.log"
  $updateScript = Join-Path $scriptDir 'Update-LiveDashboard.ps1'
  $allowCloudflareDeploy = [string]::Equals($env:GESTAO_AUTO_DEPLOY_CLOUDFLARE, '1', [System.StringComparison]::OrdinalIgnoreCase)
  $args = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $updateScript,
    '-Year', '2026',
    '-EndMonth', [string]$month,
    '-FastCurrentMonth',
    '-DashboardOnly',
    '-SkipDashboardValidation',
    '-SkipCmax',
    '-SkipClientMap',
    '-NoCommit',
    '-SkipPush'
  )
  if ($allowCloudflareDeploy) {
    Write-NeppoLog "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Deploy automatico Cloudflare habilitado por GESTAO_AUTO_DEPLOY_CLOUDFLARE=1."
    $args += '-DeployCloudflare'
  } else {
    Write-NeppoLog "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Deploy automatico Cloudflare bloqueado; coleta NEPPO nao publicara HTML sozinha."
    $args += '-DisableCloudflareDeploy'
  }

  $process = Start-Process `
    -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source `
    -ArgumentList $args `
    -WorkingDirectory $scriptDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

  Write-NeppoLog "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Subprocesso NEPPO iniciado. PID $($process.Id)."
  $stdoutOffset = 0L
  $stderrOffset = 0L
  $startedAt = Get-Date
  $deadline = $startedAt.AddMinutes($updateTimeoutMinutes)
  $firstOutputDeadline = $startedAt.AddMinutes(3)

  while (!$process.WaitForExit(10000)) {
    $outChunk = Read-NewProcessOutput -Path $stdoutPath -Offset $stdoutOffset
    $stdoutOffset = [long]$outChunk.Offset
    if (![string]::IsNullOrWhiteSpace($outChunk.Text)) {
      $outChunk.Text | Add-Content -LiteralPath $logPath -Encoding UTF8
    }

    $errChunk = Read-NewProcessOutput -Path $stderrPath -Offset $stderrOffset
    $stderrOffset = [long]$errChunk.Offset
    if (![string]::IsNullOrWhiteSpace($errChunk.Text)) {
      $errChunk.Text | Add-Content -LiteralPath $logPath -Encoding UTF8
    }

    $hasAnyOutput = ($stdoutOffset -gt 0 -or $stderrOffset -gt 0)
    if (!$hasAnyOutput -and (Get-Date) -gt $firstOutputDeadline) {
      Write-NeppoLog "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ERRO: subprocesso NEPPO sem saída inicial por 3 minutos. Encerrando PID $($process.Id)."
      Stop-NeppoProcessTree -ProcessId $process.Id
      throw 'Atualizacao NEPPO travou antes de iniciar a coleta e foi encerrada para liberar o proximo ciclo.'
    }

    if ((Get-Date) -gt $deadline) {
      Write-NeppoLog "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] ERRO: atualizacao excedeu $updateTimeoutMinutes minutos. Encerrando processo travado PID $($process.Id)."
      Stop-NeppoProcessTree -ProcessId $process.Id
      throw "Atualizacao NEPPO excedeu $updateTimeoutMinutes minutos e foi encerrada para liberar o proximo ciclo."
    }
  }
  $process.Refresh()

  $stdout = ''
  $outChunk = Read-NewProcessOutput -Path $stdoutPath -Offset $stdoutOffset
  if (![string]::IsNullOrWhiteSpace($outChunk.Text)) {
    $outChunk.Text | Add-Content -LiteralPath $logPath -Encoding UTF8
  }
  if (Test-Path -LiteralPath $stdoutPath) {
    $stdout = Get-Content -LiteralPath $stdoutPath -Raw
  }
  $stderr = ''
  $errChunk = Read-NewProcessOutput -Path $stderrPath -Offset $stderrOffset
  if (![string]::IsNullOrWhiteSpace($errChunk.Text)) {
    $errChunk.Text | Add-Content -LiteralPath $logPath -Encoding UTF8
  }
  if (Test-Path -LiteralPath $stderrPath) {
    $stderr = Get-Content -LiteralPath $stderrPath -Raw
  }

  $exitCode = $process.ExitCode
  $successMarker = $stdout -match 'Atualizacao rapida concluida'
  if ($null -eq $exitCode -and $successMarker -and [string]::IsNullOrWhiteSpace($stderr)) {
    Write-NeppoLog "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Aviso: processo terminou sem ExitCode, mas a conclusao foi confirmada pelo log."
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
