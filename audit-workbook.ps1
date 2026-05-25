[CmdletBinding()]
param(
  [string]$XlsxPath = 'c:\Users\Suporte2\Desktop\Base Atendimentos 2026 - Reinaldo V11 oficial(Recuperado Automaticamente) (Recuperado) (8).xlsx',
  [string]$HtmlPath = '',
  [string]$OutPath = ''
)

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$xlsx = $XlsxPath
$htmlPath = if ([string]::IsNullOrWhiteSpace($HtmlPath)) { Join-Path $scriptDir 'index.html' } else { $HtmlPath }
$outPath = if ([string]::IsNullOrWhiteSpace($OutPath)) { Join-Path $scriptDir 'AUDITORIA_PLANILHA.md' } else { $OutPath }

function V($data, $r, $c) { $data.GetValue($r, $c) }
function N([string]$s) { if ($null -eq $s) { return '' }; return ($s -replace '\s+', ' ').Trim() }
function Normalize-Agent([string]$s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return '' }
  $s = $s.Trim()
  if ($s -match '^Evelyn Gon.+alves$') { return 'Evelyn Gonçalves' }
  if ($s -match '^J.+lia Almeida$') { return 'Julia Almeida' }
  $map = @{
    'Evelyn GonÃ§alves' = 'Evelyn Gonçalves'
    'Evelyn Gon��alves' = 'Evelyn Gonçalves'
    'JÃºlia Almeida' = 'Julia Almeida'
    'J��lia Almeida' = 'Julia Almeida'
    'Júlia Almeida' = 'Julia Almeida'
    'LAÍS' = 'LAIS'
    'GABRIEL' = 'GABRIEL FREIRE'
    'MARCUS' = 'MARCUS SILVA'
  }
  if ($map.ContainsKey($s)) { return $map[$s] }
  return (Get-Culture).TextInfo.ToTitleCase($s.ToLower())
}
function ToSec($v) {
  if ($null -eq $v -or [string]$v -eq '') { return 0.0 }
  if ($v -is [double] -or $v -is [int]) { return [double]$v * 86400.0 }
  $ts = [TimeSpan]::Zero
  if ([TimeSpan]::TryParse([string]$v, [ref]$ts)) { return $ts.TotalSeconds }
  return 0.0
}
function Avg($arr) {
  if (!$arr -or $arr.Count -eq 0) { return $null }
  return (($arr | Measure-Object -Average).Average)
}
function FNum($v) {
  if ($null -eq $v) { return '-' }
  if ($v -is [double] -or $v -is [decimal]) { return ([math]::Round($v, 4)).ToString([Globalization.CultureInfo]::InvariantCulture) }
  return [string]$v
}

$monthNames = @('', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez')
$report = New-Object System.Collections.Generic.List[string]

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false

try {
  $wb = $excel.Workbooks.Open($xlsx, $null, $true)
  $wb.RefreshAll() | Out-Null
  $excel.CalculateFullRebuild() | Out-Null

  $report.Add("# Auditoria da Planilha e Dashboard")
  $report.Add("")
  $report.Add("Arquivo analisado: ``$xlsx``")
  $report.Add("Gerado em: $(Get-Date -Format 'dd/MM/yyyy HH:mm:ss')")
  $report.Add("")

  $report.Add("## Estrutura das abas")
  $report.Add("")
  $report.Add("| Aba | Linhas usadas | Colunas usadas | Fórmulas | Erros visíveis |")
  $report.Add("|---|---:|---:|---:|---:|")
  foreach ($ws in $wb.Worksheets) {
    $ur = $ws.UsedRange
    $formulas = 0
    $errors = 0
    try { $formulas = $ur.SpecialCells(-4123).Count } catch { $formulas = 0 } # xlCellTypeFormulas
    try { $errors = $ur.SpecialCells(-4123, 16).Count } catch { $errors = 0 } # xlErrors
    $report.Add("| $($ws.Name) | $($ur.Rows.Count) | $($ur.Columns.Count) | $formulas | $errors |")
  }
  $report.Add("")

  $base = $wb.Worksheets.Item('BASE COMPLETA')
  $ur = $base.UsedRange
  $data = $ur.Value2
  $rows = $ur.Rows.Count
  $cols = $ur.Columns.Count
  $h = @{}
  for ($c = 1; $c -le $cols; $c++) { $h[[string](V $data 1 $c)] = $c }

  $records = New-Object System.Collections.Generic.List[object]
  for ($r = 2; $r -le $rows; $r++) {
    $ano = [int](V $data $r $h['ANO'])
    if ($ano -ne 2026) { continue }
    $avRaw = V $data $r $h['Avaliação']
    $av = $null
    if ($null -ne $avRaw -and ([string]$avRaw) -ne '' -and ([string]$avRaw) -ne 'SEM AVALIAÇÃO') { $av = [double]$avRaw }
    $records.Add([pscustomobject]@{
      Mes = [int](V $data $r $h['MÊS'])
      Dia = [int](V $data $r $h['DIA'])
      Agente = Normalize-Agent ([string](V $data $r $h['Agente']))
      Grupo = [string](V $data $r $h['Nome do Grupo'])
      Periodo = [string](V $data $r $h['PERIODO'])
      TMA = ToSec (V $data $r $h['Tempo atend'])
      TME = ToSec (V $data $r $h['Tempo de Espera'])
      Avaliacao = $av
    })
  }

  $report.Add("## Métricas recalculadas da BASE COMPLETA")
  $report.Add("")
  $report.Add("| Mês | Atendimentos | Avaliações | Cobertura | CSAT | TMA min | TME seg | SLA <= 2min |")
  $report.Add("|---|---:|---:|---:|---:|---:|---:|---:|")
  foreach ($m in 1..12) {
    $rs = @($records | Where-Object Mes -eq $m)
    if ($rs.Count -eq 0) { continue }
    $ev = @($rs | Where-Object { $null -ne $_.Avaliacao })
    $csat = Avg @($ev | ForEach-Object Avaliacao)
    $tma = Avg @($rs | ForEach-Object TMA)
    $tme = Avg @($rs | ForEach-Object TME)
    $sla = @($rs | Where-Object { $_.TME -le 120 }).Count / [math]::Max(1, $rs.Count)
    $report.Add("| $($monthNames[$m]) | $($rs.Count) | $($ev.Count) | $([math]::Round($ev.Count/[math]::Max(1,$rs.Count)*100,1))% | $([math]::Round($csat,3)) | $([math]::Round($tma/60,2)) | $([math]::Round($tme,2)) | $([math]::Round($sla*100,2))% |")
  }
  $report.Add("")

  $report.Add("## Comparação com aba RESUMO")
  $report.Add("")
  $res = $wb.Worksheets.Item('RESUMO')
  $labels = @{
    'Qtd. Atendimentos' = 'Atendimentos'
    'Qtd. Avaliações' = 'Avaliações'
    'Satisfação Média' = 'CSAT'
    'TMA' = 'TMA'
    'TME' = 'TME'
  }
  $report.Add("| Métrica | Jan | Fev | Mar | Abr | Mai |")
  $report.Add("|---|---:|---:|---:|---:|---:|")
  foreach ($label in $labels.Keys) {
    $row = $null
    for ($r = 1; $r -le $res.UsedRange.Rows.Count; $r++) {
      if ((N $res.Cells.Item($r, 3).Text) -eq $label) { $row = $r; break }
    }
    if ($row) {
      $vals = @()
      foreach ($c in 4..8) { $vals += (N $res.Cells.Item($row, $c).Text) }
      $report.Add("| $label | $($vals -join ' | ') |")
    }
  }
  $report.Add("")

  $report.Add("## Top 10 grupos por mês na BASE COMPLETA")
  $report.Add("")
  foreach ($m in 1..5) {
    $report.Add("### $($monthNames[$m])")
    foreach ($g in @($records | Where-Object Mes -eq $m | Group-Object Grupo | Sort-Object Count -Descending | Select-Object -First 10)) {
      $report.Add("- $($g.Name): $($g.Count)")
    }
    $report.Add("")
  }

  $report.Add("## Top agentes em Maio")
  $report.Add("")
  foreach ($a in @($records | Where-Object Mes -eq 5 | Group-Object Agente | Sort-Object Count -Descending)) {
    $ev = @($a.Group | Where-Object { $null -ne $_.Avaliacao })
    $report.Add("- $($a.Name): $($a.Count) atend., $($ev.Count) aval., CSAT $(FNum (Avg @($ev | ForEach-Object Avaliacao)))")
  }
  $report.Add("")

  if (Test-Path $htmlPath) {
    $html = Get-Content -LiteralPath $htmlPath -Raw
    $m = [regex]::Match($html, 'const D = (?s)(.*?);\r?\n\r?\n// ════════ UTILS')
    if ($m.Success) {
      $D = $m.Groups[1].Value | ConvertFrom-Json
      $report.Add("## Dashboard HTML atual")
      $report.Add("")
      $report.Add("- Mês de foco: $($D.focusLabel)")
      $report.Add("- Atendimentos no array: $($D.atend -join ', ')")
      $report.Add("- Avaliações no array: $($D.aval -join ', ')")
      $report.Add("- CSAT no array: $($D.sat -join ', ')")
      $report.Add("- Diário no array: $($D.diary.Count) registros")
      $report.Add("")
    }
  }

  Set-Content -LiteralPath $outPath -Value ($report -join "`r`n") -Encoding UTF8
  Write-Output "Audit written: $outPath"
}
finally {
  if ($wb) { $wb.Close($false) | Out-Null }
  if ($excel) {
    $excel.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
  }
  Get-Process EXCEL -ErrorAction SilentlyContinue | Stop-Process -Force
}
