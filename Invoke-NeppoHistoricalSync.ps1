[CmdletBinding()]
param(
  [int[]]$Years = @(2023, 2024, 2025, 2026),
  [int]$DefaultStartMonth = 1,
  [int]$DefaultEndMonth = 12,
  [int]$CurrentYearEndMonth = 5,
  [int]$PageSize = 200,
  [switch]$SkipWorkbookExtraction
)

$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$historicalTreatments = Join-Path $scriptDir 'tratamentos-neppo-historico.csv'
$historicalDiary = Join-Path $scriptDir 'diario-historico.csv'
$multiDir = Join-Path $scriptDir 'exports\multi-year'

if (!$SkipWorkbookExtraction) {
  & (Join-Path $scriptDir 'Export-HistoricalWorkbookTreatments.ps1') `
    -TreatmentsOutPath $historicalTreatments `
    -DiaryOutPath $historicalDiary
}

if (!(Test-Path -LiteralPath $multiDir)) {
  New-Item -ItemType Directory -Path $multiDir | Out-Null
}

$allAttendance = New-Object System.Collections.Generic.List[object]
$allDiary = New-Object System.Collections.Generic.List[object]

foreach ($year in $Years) {
  $startMonth = $DefaultStartMonth
  $endMonth = if ($year -eq 2026) { $CurrentYearEndMonth } else { $DefaultEndMonth }
  $yearExportDir = Join-Path $scriptDir ("exports\{0}" -f $year)

  Write-Output "Sincronizando NEPPO $year ($startMonth-$endMonth)..."
  & (Join-Path $scriptDir 'sync-neppo-data.ps1') `
    -Year $year `
    -StartMonth $startMonth `
    -EndMonth $endMonth `
    -PageSize $PageSize `
    -TreatmentsPath $historicalTreatments `
    -ExportDir $yearExportDir `
    -ExportOnly

  $attendancePath = Join-Path $yearExportDir 'atendimentos-neppo.csv'
  if (Test-Path -LiteralPath $attendancePath) {
    foreach ($row in @(Import-Csv -LiteralPath $attendancePath)) {
      $allAttendance.Add([pscustomobject]@{
        Ano = $year
        Mes = $row.Mes
        Dia = $row.Dia
        DataInicial = $row.DataInicial
        DataEncerramento = $row.DataEncerramento
        Protocolo = $row.Protocolo
        Agente = $row.Agente
        Grupo = $row.Grupo
        ClienteOriginal = $row.ClienteOriginal
        UsuarioInformado = $row.UsuarioInformado
        ContratoExtraido = $row.ContratoExtraido
        ChaveCliente = $row.ChaveCliente
        CpfCnpjNeppo = $row.CpfCnpjNeppo
        CodigoExternoNeppo = $row.CodigoExternoNeppo
        UsuarioNeppo = $row.UsuarioNeppo
        UsuarioIdNeppo = $row.UsuarioIdNeppo
        Telefone = $row.Telefone
        TempoAtendimentoSeg = $row.TempoAtendimentoSeg
        TempoEsperaSeg = $row.TempoEsperaSeg
        Avaliacao = $row.Avaliacao
        Canal = $row.Canal
        Operacao = $row.Operacao
        Status = $row.Status
        SessionId = $row.SessionId
      })
    }
  }

  $diaryPath = Join-Path $yearExportDir 'diario-tratamentos.csv'
  if (Test-Path -LiteralPath $diaryPath) {
    foreach ($row in @(Import-Csv -LiteralPath $diaryPath)) { $allDiary.Add($row) }
  }
}

if (Test-Path -LiteralPath $historicalDiary) {
  foreach ($row in @(Import-Csv -LiteralPath $historicalDiary)) {
    $allDiary.Add([pscustomobject]@{
      Ano = $row.ano
      Mes = ''
      Data = $row.data
      Agente = $row.responsavel
      Protocolo = ''
      Acao = $row.acao
      Descricao = (($row.motivo, $row.impacto, $row.observacoes) | Where-Object { $_ }) -join ' | '
    })
  }
}

$allAttendance |
  Sort-Object Ano, Mes, Dia, DataInicial, Protocolo |
  Export-Csv -LiteralPath (Join-Path $multiDir 'atendimentos-neppo-todos-anos.csv') -NoTypeInformation -Encoding UTF8

$allDiary |
  Sort-Object Ano, Data, Protocolo |
  Export-Csv -LiteralPath (Join-Path $multiDir 'diario-tratamentos-todos-anos.csv') -NoTypeInformation -Encoding UTF8

Write-Output "Base multi-ano: $(Join-Path $multiDir 'atendimentos-neppo-todos-anos.csv') ($($allAttendance.Count))"
Write-Output "Diário multi-ano: $(Join-Path $multiDir 'diario-tratamentos-todos-anos.csv') ($($allDiary.Count))"
