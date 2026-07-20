[CmdletBinding()]
param(
  [int]$Year = 2026,
  [int]$StartMonth = 1,
  [int]$EndMonth = 0,
  [string]$ExportDir = 'exports',
  [switch]$DeployCloudflare,
  [switch]$SkipPush,
  [switch]$SkipCmax,
  [switch]$FastCurrentMonth,
  [switch]$DashboardOnly,
  [switch]$SkipClientMap,
  [switch]$SkipReviews,
  [switch]$SkipDashboardValidation,
  [switch]$DisableCloudflareDeploy,
  [switch]$NoCommit
)

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location -LiteralPath $scriptDir

$credentialPath = Join-Path (Join-Path $scriptDir 'secrets') 'neppo-credentials.clixml'
if (Test-Path -LiteralPath $credentialPath) {
  $credentials = Import-Clixml -LiteralPath $credentialPath
  foreach ($name in @('NEPPO_CLIENT_KEY', 'NEPPO_CLIENT_SECRET', 'NEPPO_USERNAME', 'NEPPO_PASSWORD')) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process')) -and $credentials.$name) {
      [Environment]::SetEnvironmentVariable($name, [System.Net.NetworkCredential]::new('', $credentials.$name).Password, 'Process')
    }
  }
  $env:NEPPO_TOKEN = ''
}

$secretPath = Join-Path (Join-Path $scriptDir 'secrets') 'neppo-token.clixml'
if ([string]::IsNullOrWhiteSpace($env:NEPPO_TOKEN) -and !(Test-Path -LiteralPath $credentialPath) -and (Test-Path -LiteralPath $secretPath)) {
  $secureToken = Import-Clixml -LiteralPath $secretPath
  $env:NEPPO_TOKEN = [System.Net.NetworkCredential]::new('', $secureToken).Password
}

if ($EndMonth -le 0) {
  $EndMonth = [int](Get-Date).Month
}
if ($FastCurrentMonth) {
  $StartMonth = $EndMonth
  $existingCsv = Join-Path $ExportDir 'atendimentos-neppo.csv'
  if (Test-Path -LiteralPath $existingCsv) {
    $requiredMonths = @()
    if ($EndMonth -gt 1) { $requiredMonths = @(1..($EndMonth - 1)) }
    if ($requiredMonths.Count -gt 0) {
      $existingMonths = @{}
      Import-Csv -LiteralPath $existingCsv | Group-Object Mes | ForEach-Object {
        if (![string]::IsNullOrWhiteSpace([string]$_.Name)) {
          $existingMonths[[int]$_.Name] = $_.Count
        }
      }
      $missingMonths = @($requiredMonths | Where-Object { !$existingMonths.ContainsKey([int]$_) })
      if ($missingMonths.Count -gt 0) {
        Write-Warning "CSV incremental sem meses anteriores ($($missingMonths -join ', ')). Vou fazer atualização completa para evitar publicar dashboard parcial."
        $FastCurrentMonth = $false
        $StartMonth = 1
      }
    }
  }
}

function Find-Git {
  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  if (!$IsWindows) {
    throw 'Git nao encontrado. Instale o Git antes de executar a atualizacao.'
  }

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
$targetHtmlPath = Join-Path $scriptDir 'index.html'
$tempRoot = if (![string]::IsNullOrWhiteSpace($env:TEMP)) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$syncHtmlPath = Join-Path $tempRoot ('gestao-dashboard-sync-{0}.html' -f (Get-Date -Format 'yyyyMMddHHmmss'))
Copy-Item -LiteralPath $targetHtmlPath -Destination $syncHtmlPath -Force

function Get-DashboardDataBlock {
  param(
    [Parameter(Mandatory = $true)][string]$Html
  )

  $prefix = 'const D ='
  $prefixIndex = $Html.IndexOf($prefix)
  if ($prefixIndex -lt 0) { throw 'Atualizacao interrompida: bloco const D nao encontrado no HTML.' }

  $jsonStart = $Html.IndexOf('{', $prefixIndex)
  if ($jsonStart -lt 0) { throw 'Atualizacao interrompida: inicio do bloco const D nao encontrado no HTML.' }

  $depth = 0
  $inString = $false
  $escaped = $false
  for ($i = $jsonStart; $i -lt $Html.Length; $i++) {
    $ch = $Html[$i]
    if ($inString) {
      if ($escaped) {
        $escaped = $false
      } elseif ($ch -eq [char]92) {
        $escaped = $true
      } elseif ($ch -eq [char]34) {
        $inString = $false
      }
      continue
    }

    if ($ch -eq [char]34) {
      $inString = $true
    } elseif ($ch -eq '{') {
      $depth++
    } elseif ($ch -eq '}') {
      $depth--
      if ($depth -eq 0) {
        $jsonEnd = $i + 1
        return [pscustomobject]@{
          Start = $jsonStart
          End = $jsonEnd
          Json = $Html.Substring($jsonStart, $jsonEnd - $jsonStart)
        }
      }
    }
  }

  throw 'Atualizacao interrompida: fim do bloco const D nao encontrado no HTML.'
}

function Assert-DashboardHtmlMonths {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][int]$ExpectedEndMonth
  )

  $html = Get-Content -LiteralPath $Path -Raw
  $dataBlock = Get-DashboardDataBlock -Html $html
  $data = $dataBlock.Json | ConvertFrom-Json
  $monthsInRows = @{}
  foreach ($row in @($data.rows)) {
    if ($row -and $row.Count -gt 0) { $monthsInRows[[int]$row[0]] = $true }
  }
  $missing = @(1..$ExpectedEndMonth | Where-Object { !$monthsInRows.ContainsKey([int]$_) })
  if ($missing.Count -gt 0) {
    throw "Atualizacao interrompida: o HTML gerado ficaria sem os meses $($missing -join ', '). O arquivo publicado foi preservado."
  }
  return $data
}

function Assert-DashboardMatchesCsv {
  param(
    [Parameter(Mandatory = $true)]$DashboardData,
    [Parameter(Mandatory = $true)][string]$CsvPath
  )

  if (!(Test-Path -LiteralPath $CsvPath)) {
    throw "Atualizacao interrompida: CSV do NEPPO nao encontrado em $CsvPath."
  }

  $csvRows = @(Import-Csv -LiteralPath $CsvPath)
  $months = @($DashboardData.meses)
  for ($i = 0; $i -lt $months.Count; $i++) {
    $monthNumber = $i + 1
    $monthRows = @($csvRows | Where-Object { [int]$_.Mes -eq $monthNumber })
    $closedRows = @($monthRows | Where-Object { [string]$_.Status -eq 'CLOSED' })
    $openRows = @($monthRows | Where-Object { [string]$_.Status -ne 'CLOSED' })

    $htmlTotal = [int]$DashboardData.atend[$i]
    $htmlClosed = [int]$DashboardData.closed[$i]
    $htmlOpen = [int]$DashboardData.open[$i]

    if ($htmlTotal -ne $monthRows.Count -or $htmlClosed -ne $closedRows.Count -or $htmlOpen -ne $openRows.Count) {
      throw "Atualizacao interrompida: HTML e CSV divergiram no mes $monthNumber. HTML total/fechado/aberto=$htmlTotal/$htmlClosed/$htmlOpen; CSV=$($monthRows.Count)/$($closedRows.Count)/$($openRows.Count)."
    }
  }
}

Write-Host "Atualizando dashboard NEPPO ao vivo ($Year/$StartMonth até $Year/$EndMonth)..."
& (Join-Path $scriptDir 'sync-neppo-data.ps1') `
  -HtmlPath $syncHtmlPath `
  -Year $Year `
  -StartMonth $StartMonth `
  -EndMonth $EndMonth `
  -ExportDir $ExportDir `
  -MergeExistingCsv:$FastCurrentMonth `
  -DashboardOnly:$DashboardOnly `
  -SkipReviews:$SkipReviews `
  -NoMirrorRoot

if ($SkipDashboardValidation) {
  Write-Host 'Validação pesada do HTML pulada nesta execução VPS.'
} else {
  $dashboardData = Assert-DashboardHtmlMonths -Path $syncHtmlPath -ExpectedEndMonth $EndMonth
  Write-Host "HTML temporario validado: $($dashboardData.rows.Count) atendimentos em $($dashboardData.meses.Count) mes(es)."

  $mergedCsv = Join-Path $ExportDir 'atendimentos-neppo.csv'
  Assert-DashboardMatchesCsv -DashboardData $dashboardData -CsvPath $mergedCsv
  Write-Host 'HTML temporario confere com o CSV do NEPPO.'
  if (($StartMonth -eq 1 -or $FastCurrentMonth) -and (Test-Path -LiteralPath $mergedCsv)) {
    $expectedMonths = @(1..$EndMonth)
    $publishedMonths = @{}
    Import-Csv -LiteralPath $mergedCsv | Group-Object Mes | ForEach-Object {
      if (![string]::IsNullOrWhiteSpace([string]$_.Name)) {
        $publishedMonths[[int]$_.Name] = $_.Count
      }
    }
    $missingPublishedMonths = @($expectedMonths | Where-Object { !$publishedMonths.ContainsKey([int]$_) })
    if ($missingPublishedMonths.Count -gt 0) {
      throw "Atualizacao interrompida: o dashboard ficaria sem os meses $($missingPublishedMonths -join ', '). Nada foi publicado."
    }
  }
}

if ($SkipClientMap) {
  Write-Host 'Pulando mapa privado de clientes nesta atualização rápida.'
} else {
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
    if (![string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
      Join-Path (Join-Path $env:USERPROFILE 'Downloads') 'Contatos_xzxix85h06jiflnt0emoi.csv'
    } else {
      ''
    }
  }
  $mapArgs = @{
    ClientMonthPath = (Join-Path $ExportDir 'clientes-por-mes.csv')
  }
  if (Test-Path -LiteralPath $auxContacts) {
    $mapArgs.AuxContactsPath = $auxContacts
  }
  & (Join-Path $scriptDir 'Atualizar-Mapa-Clientes-Privados.ps1') @mapArgs
}

Write-Host 'Mascarando dados sensíveis do HTML público...'
& (Join-Path $scriptDir 'Protect-PublicDashboardData.ps1') -HtmlPath $syncHtmlPath
if ($DisableCloudflareDeploy) {
  Write-Host "HTML atualizado mantido apenas no temporario; index.html preservado em $targetHtmlPath."
} else {
  Copy-Item -LiteralPath $syncHtmlPath -Destination $targetHtmlPath -Force
}

Write-Host 'Verificando alterações para publicar...'
if ($NoCommit) {
  $hasChanges = $true
} else {
  if ($SkipClientMap) {
    & $git add index.html
  } else {
    & $git add index.html src/private-client-map.js
    foreach ($maybeTracked in @('cliente-map-privado.csv', 'cliente-map-privado.js')) {
      if (Test-Path -LiteralPath (Join-Path $scriptDir $maybeTracked)) {
        & $git add -f $maybeTracked
      }
    }
  }
$hasChanges = $true
& $git diff --cached --quiet
if ($LASTEXITCODE -eq 0) { $hasChanges = $false }
}

if (-not $hasChanges) {
  Write-Host 'Sem alterações para publicar.'
  exit 0
}

if ($NoCommit) {
  Write-Host 'Commit ignorado nesta atualização rápida.'
} else {
  & $git config user.name 'reinaldobueno-cyber'
  & $git config user.email 'actions@users.noreply.github.com'
  & $git commit -m 'Atualiza dashboard NEPPO ao vivo'
}

if ($DisableCloudflareDeploy) {
  Write-Host 'Deploy Cloudflare bloqueado nesta execução automatica.'
} elseif ($DeployCloudflare) {
  & (Join-Path $scriptDir 'Test-DashboardRelease.ps1') -HtmlPath $targetHtmlPath
  Write-Host 'Publicando dashboard atualizado no Cloudflare...'
  $env:CLOUDFLARE_API_KEY = ''
  $env:CLOUDFLARE_EMAIL = ''
  if (![string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $env:PATH = (Join-Path (Join-Path $env:LOCALAPPDATA 'CodexTools') 'node-v22') + [System.IO.Path]::PathSeparator + $env:PATH
  }
  & npm exec --yes wrangler@latest -- deploy
  if ($LASTEXITCODE -ne 0) {
    throw "Deploy Cloudflare falhou com codigo $LASTEXITCODE."
  }
} elseif (-not [string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) {
  Write-Host 'Token Cloudflare encontrado no ambiente, mas deploy automatico foi bloqueado. Use -DeployCloudflare para publicar.'
}

if ($SkipPush) {
  if ($NoCommit) {
    Write-Host 'Atualizacao rapida concluida. Commit e push ignorados.'
  } else {
    Write-Host 'Commit criado. Push ignorado por -SkipPush.'
  }
  exit 0
}

if ($NoCommit) {
  Write-Host 'Atualizacao rapida concluida. Nao ha commit para enviar ao GitHub.'
  exit 0
}

& $git push
Write-Host 'Dashboard publicado no GitHub Pages.'
