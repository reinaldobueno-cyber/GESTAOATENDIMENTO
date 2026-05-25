[CmdletBinding()]
param(
  [string[]]$WorkbookPath = @(
    'C:\Users\Suporte2\Desktop\RELATORIO SUPORTE\Fechamento 2023\Base Atendimentos 2023 - Reinaldo.xlsx',
    'C:\Users\Suporte2\Desktop\RELATORIO SUPORTE\Fechamento 2024\Base Atendimentos 2024 - Reinaldo V9.xlsx',
    'C:\Users\Suporte2\Desktop\RELATORIO SUPORTE\Fechamento 2025\Base Atendimentos 2025 - Reinaldo V11 oficial(Recuperado Automaticamente).xlsx'
  ),
  [string]$TreatmentsOutPath = '',
  [string]$DiaryOutPath = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrWhiteSpace($TreatmentsOutPath)) { $TreatmentsOutPath = Join-Path $scriptDir 'tratamentos-neppo-historico.csv' }
if ([string]::IsNullOrWhiteSpace($DiaryOutPath)) { $DiaryOutPath = Join-Path $scriptDir 'diario-historico.csv' }

function Get-YearFromPath([string]$Path) {
  $m = [regex]::Match($Path, '20\d{2}')
  if (!$m.Success) { throw "Não consegui identificar o ano no caminho: $Path" }
  return [int]$m.Value
}

function To-SecText($Value) {
  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return '' }
  if ($Value -is [double] -or $Value -is [int]) {
    if ([double]$Value -gt 0 -and [double]$Value -lt 1) { return [Math]::Round([double]$Value * 86400, 0) }
    return [Math]::Round([double]$Value, 0)
  }
  $Value = [string]$Value
  $ts = [TimeSpan]::Zero
  if ([TimeSpan]::TryParse($Value, [ref]$ts)) { return [Math]::Round($ts.TotalSeconds, 0) }
  $num = 0.0
  if ([double]::TryParse($Value.Replace(',', '.'), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$num)) {
    if ($num -gt 0 -and $num -lt 1) { return [Math]::Round($num * 86400, 0) }
    return [Math]::Round($num, 0)
  }
  return ''
}

function Read-CellText($Worksheet, [int]$Row, [int]$Column) {
  return ([string]$Worksheet.Cells.Item($Row, $Column).Text).Trim()
}

function Get-MatrixValue($Matrix, [int]$Row, [int]$Column) {
  $value = $Matrix[$Row, $Column]
  if ($null -eq $value) { return '' }
  return $value
}

function Get-MatrixText($Matrix, [int]$Row, [int]$Column) {
  return ([string](Get-MatrixValue $Matrix $Row $Column)).Trim()
}

function Get-Worksheet($Workbook, [string[]]$Names) {
  foreach ($name in $Names) {
    try { return $Workbook.Worksheets.Item($name) } catch {}
  }
  return $null
}

function Get-HeaderMap($Worksheet, [int]$HeaderRow, [int]$MaxColumn) {
  $map = @{}
  for ($c = 1; $c -le $MaxColumn; $c++) {
    $name = Read-CellText $Worksheet $HeaderRow $c
    if (![string]::IsNullOrWhiteSpace($name) -and !$map.ContainsKey($name)) { $map[$name] = $c }
  }
  return $map
}

function Get-HeaderMapFromMatrix($Matrix, [int]$HeaderRow, [int]$MaxColumn) {
  $map = @{}
  for ($c = 1; $c -le $MaxColumn; $c++) {
    $name = Get-MatrixText $Matrix $HeaderRow $c
    if (![string]::IsNullOrWhiteSpace($name) -and !$map.ContainsKey($name)) { $map[$name] = $c }
  }
  return $map
}

$treatments = New-Object System.Collections.Generic.List[object]
$diary = New-Object System.Collections.Generic.List[object]
$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false

try {
  foreach ($path in $WorkbookPath) {
    if (!(Test-Path -LiteralPath $path)) {
      Write-Warning "Planilha não encontrada: $path"
      continue
    }
    $year = Get-YearFromPath $path
    Write-Output "Lendo tratamentos históricos: $path"
    $workbook = $excel.Workbooks.Open($path, $null, $true)
    try {
      $base = Get-Worksheet $workbook @('BASE COMPLETA', 'Base Completa')
      if ($null -ne $base) {
        $range = $base.UsedRange
        $values = $range.Value2
        $h = Get-HeaderMapFromMatrix $values 1 $range.Columns.Count
        for ($r = 2; $r -le $range.Rows.Count; $r++) {
          $protocol = Get-MatrixText $values $r $h['Protocolo']
          if ([string]::IsNullOrWhiteSpace($protocol)) { continue }
          $ratingText = Get-MatrixText $values $r $h['Avaliação']
          $rating = if ($ratingText -match '^\d+([,.]\d+)?$') { $ratingText.Replace(',', '.') } else { '' }
          $treatments.Add([pscustomobject]@{
            ano = $year
            protocolo = $protocol
            ignorar = ''
            avaliacao = $rating
            atendSec = To-SecText (Get-MatrixValue $values $r $h['Tempo atend'])
            esperaSec = To-SecText (Get-MatrixValue $values $r $h['Tempo de Espera'])
            agente = Get-MatrixText $values $r $h['Agente']
            grupo = Get-MatrixText $values $r $h['Nome do Grupo']
            periodo = Get-MatrixText $values $r $h['PERIODO']
            motivo = "Tratamento importado da planilha oficial $year."
            acao = 'Aplicar tratamento histórico da planilha'
          })
        }
      }

      $diarySheet = Get-Worksheet $workbook @('DIÁRIO', 'DIÁRIO DE BORDO')
      if ($null -ne $diarySheet) {
        $range = $diarySheet.UsedRange
        for ($r = 4; $r -le $range.Rows.Count; $r++) {
          $data = Read-CellText $diarySheet $r 3
          $impacto = Read-CellText $diarySheet $r 7
          $motivo = Read-CellText $diarySheet $r 6
          $acao = Read-CellText $diarySheet $r 8
          $obs = Read-CellText $diarySheet $r 10
          if ([string]::IsNullOrWhiteSpace(($data + $impacto + $motivo + $acao + $obs))) { continue }
          $diary.Add([pscustomobject]@{
            ano = $year
            data = $data
            horario = Read-CellText $diarySheet $r 4
            duracao = Read-CellText $diarySheet $r 5
            motivo = $motivo
            impacto = $impacto
            acao = $acao
            responsavel = Read-CellText $diarySheet $r 9
            observacoes = $obs
          })
        }
      }
    }
    finally {
      $workbook.Close($false)
    }
  }
}
finally {
  $excel.Quit()
  [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
}

$treatments | Sort-Object ano, protocolo | Export-Csv -LiteralPath $TreatmentsOutPath -NoTypeInformation -Encoding UTF8
$diary | Sort-Object ano, data | Export-Csv -LiteralPath $DiaryOutPath -NoTypeInformation -Encoding UTF8
Write-Output "Tratamentos exportados: $TreatmentsOutPath ($($treatments.Count))"
Write-Output "Diário exportado: $DiaryOutPath ($($diary.Count))"
