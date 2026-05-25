[CmdletBinding()]
param(
  [string[]]$WorkbookPath = @(
    'C:\Users\Suporte2\Desktop\RELATORIO SUPORTE\Fechamento 2023\Base Atendimentos 2023 - Reinaldo.xlsx',
    'C:\Users\Suporte2\Desktop\RELATORIO SUPORTE\Fechamento 2024\Base Atendimentos 2024 - Reinaldo V9.xlsx',
    'C:\Users\Suporte2\Desktop\RELATORIO SUPORTE\Fechamento 2025\Base Atendimentos 2025 - Reinaldo V11 oficial(Recuperado Automaticamente).xlsx'
  ),
  [string]$OutPath = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrWhiteSpace($OutPath)) { $OutPath = Join-Path $scriptDir 'historico-dashboard.js' }

function Get-YearFromPath([string]$Path) {
  $m = [regex]::Match($Path, '20\d{2}')
  if (!$m.Success) { throw "Não consegui identificar o ano no caminho: $Path" }
  return [int]$m.Value
}

function Get-Worksheet($Workbook, [string[]]$Names) {
  foreach ($name in $Names) {
    try { return $Workbook.Worksheets.Item($name) } catch {}
  }
  return $null
}

function MatrixText($Matrix, [int]$Row, [int]$Column) {
  $v = $Matrix[$Row, $Column]
  if ($null -eq $v) { return '' }
  return ([string]$v).Trim()
}

function MatrixSeconds($Matrix, [int]$Row, [int]$Column) {
  $v = $Matrix[$Row, $Column]
  if ($null -eq $v -or [string]::IsNullOrWhiteSpace([string]$v)) { return 0.0 }
  if ($v -is [double] -or $v -is [int]) {
    if ([double]$v -gt 0 -and [double]$v -lt 1) { return [double]$v * 86400.0 }
    return [double]$v
  }
  $ts = [TimeSpan]::Zero
  if ([TimeSpan]::TryParse([string]$v, [ref]$ts)) { return $ts.TotalSeconds }
  return 0.0
}

function HeaderMap($Matrix, [int]$MaxColumn) {
  $map = @{}
  for ($c = 1; $c -le $MaxColumn; $c++) {
    $name = MatrixText $Matrix 1 $c
    if (![string]::IsNullOrWhiteSpace($name) -and !$map.ContainsKey($name)) { $map[$name] = $c }
  }
  return $map
}

function Avg($Values) {
  $arr = @($Values | Where-Object { $null -ne $_ })
  if (!$arr.Count) { return 0.0 }
  return (($arr | Measure-Object -Average).Average)
}

function Round2($Value) { return [Math]::Round([double]$Value, 2) }

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$years = [ordered]@{}

try {
  foreach ($path in $WorkbookPath) {
    if (!(Test-Path -LiteralPath $path)) {
      Write-Warning "Planilha não encontrada: $path"
      continue
    }
    $year = Get-YearFromPath $path
    Write-Output "Gerando agregados do site: $year"
    $workbook = $excel.Workbooks.Open($path, $null, $true)
    try {
      $base = Get-Worksheet $workbook @('BASE COMPLETA', 'Base Completa')
      if ($null -eq $base) { continue }
      $range = $base.UsedRange
      $values = $range.Value2
      $h = HeaderMap $values $range.Columns.Count
      $rows = New-Object System.Collections.Generic.List[object]
      for ($r = 2; $r -le $range.Rows.Count; $r++) {
        $protocol = MatrixText $values $r $h['Protocolo']
        if ([string]::IsNullOrWhiteSpace($protocol)) { continue }
        $ratingText = MatrixText $values $r $h['Avaliação']
        $rating = $null
        $parsed = 0.0
        if ([double]::TryParse($ratingText.Replace(',', '.'), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) { $rating = $parsed }
        $rows.Add([pscustomobject]@{
          mes = [int](MatrixText $values $r $h['MÊS'])
          dia = [int](MatrixText $values $r $h['DIA'])
          agente = MatrixText $values $r $h['Agente']
          grupo = MatrixText $values $r $h['Nome do Grupo']
          tma = MatrixSeconds $values $r $h['Tempo atend']
          tme = MatrixSeconds $values $r $h['Tempo de Espera']
          avaliacao = $rating
        })
      }

      $months = 1..12 | ForEach-Object {
        $m = $_
        $rs = @($rows | Where-Object mes -eq $m)
        $ev = @($rs | Where-Object { $null -ne $_.avaliacao })
        [ordered]@{
          mes = $m
          atend = $rs.Count
          aval = $ev.Count
          csat = if ($ev.Count) { Round2 (Avg @($ev | ForEach-Object avaliacao)) } else { 0 }
          tmaMin = if ($rs.Count) { Round2 ((Avg @($rs | ForEach-Object tma)) / 60.0) } else { 0 }
          tmeSec = if ($rs.Count) { Round2 (Avg @($rs | ForEach-Object tme)) } else { 0 }
          sla = if ($rs.Count) { Round2 ((@($rs | Where-Object { $_.tme -le 120 }).Count / $rs.Count) * 100.0) } else { 0 }
        }
      }

      $topGroups = @($rows | Group-Object grupo | Sort-Object Count -Descending | Select-Object -First 12 | ForEach-Object {
        [ordered]@{ nome = $_.Name; total = $_.Count }
      })
      $topAgents = @($rows | Group-Object agente | Sort-Object Count -Descending | Select-Object -First 12 | ForEach-Object {
        $items = @($_.Group)
        $ev = @($items | Where-Object { $null -ne $_.avaliacao })
        [ordered]@{ nome = $_.Name; total = $_.Count; csat = if ($ev.Count) { Round2 (Avg @($ev | ForEach-Object avaliacao)) } else { 0 } }
      })

      $diarySheet = Get-Worksheet $workbook @('DIÁRIO', 'DIÁRIO DE BORDO')
      $diary = @()
      if ($null -ne $diarySheet) {
        $dr = $diarySheet.UsedRange
        $dv = $dr.Value2
        $diary = @(for ($r = 4; $r -le $dr.Rows.Count; $r++) {
          $data = MatrixText $dv $r 3
          $motivo = MatrixText $dv $r 6
          $impacto = MatrixText $dv $r 7
          $acao = MatrixText $dv $r 8
          $resp = MatrixText $dv $r 9
          $obs = MatrixText $dv $r 10
          if (![string]::IsNullOrWhiteSpace(($data + $motivo + $impacto + $acao + $resp + $obs))) {
            [ordered]@{ data = $data; motivo = $motivo; impacto = $impacto; acao = $acao; responsavel = $resp; observacoes = $obs }
          }
        })
      }

      $years[[string]$year] = [ordered]@{
        total = $rows.Count
        aval = @($rows | Where-Object { $null -ne $_.avaliacao }).Count
        csat = Round2 (Avg @($rows | Where-Object { $null -ne $_.avaliacao } | ForEach-Object avaliacao))
        tmaMin = Round2 ((Avg @($rows | ForEach-Object tma)) / 60.0)
        tmeSec = Round2 (Avg @($rows | ForEach-Object tme))
        sla = Round2 ((@($rows | Where-Object { $_.tme -le 120 }).Count / [Math]::Max(1, $rows.Count)) * 100.0)
        months = $months
        topGroups = $topGroups
        topAgents = $topAgents
        diary = $diary
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

$payload = [ordered]@{
  anos = @($years.Keys)
  meses = @('Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez')
  years = $years
}
$json = $payload | ConvertTo-Json -Depth 40
[System.IO.File]::WriteAllText($OutPath, "window.HISTORICO = $json;`n", [System.Text.Encoding]::UTF8)
Write-Output "Histórico do site exportado: $OutPath"
