[CmdletBinding()]
param(
  [string]$XlsxPath = 'c:\Users\Suporte2\Desktop\Base Atendimentos 2026 - Reinaldo V11 oficial(Recuperado Automaticamente) (Recuperado) (8).xlsx',
  [string]$HtmlPath = ''
)

$ErrorActionPreference = 'Stop'

$xlsx = $XlsxPath
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$htmlPath = if ([string]::IsNullOrWhiteSpace($HtmlPath)) { Join-Path $scriptDir 'index.html' } else { $HtmlPath }

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

function Normalize-Group([string]$s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return '' }
  $s = $s.Trim()
  $map = @{
    'Agricola' = 'Agrícola'
    'Configuracao de balanca e bastao' = 'Config. Balança'
    'PMG e Comunicacao para Associacao' = 'PMG e Comunic.'
    'Reproducao' = 'Reprodução'
    'Retorno envio ativo' = 'Ret. Envio Ativo'
    'fila Suporte' = 'Fila Suporte'
  }
  if ($map.ContainsKey($s)) { return $map[$s] }
  return $s
}

function To-Sec($v) {
  if ($null -eq $v -or [string]$v -eq '') { return 0.0 }
  if ($v -is [double] -or $v -is [int]) { return [double]$v * 86400.0 }
  $ts = [TimeSpan]::Zero
  if ([TimeSpan]::TryParse([string]$v, [ref]$ts)) { return $ts.TotalSeconds }
  return 0.0
}

function To-Hour($v) {
  if ($null -eq $v) { return 0 }
  if ($v -is [double] -or $v -is [int]) { return [int][Math]::Floor(([double]$v * 24.0)) }
  $ts = [TimeSpan]::Zero
  if ([TimeSpan]::TryParse([string]$v, [ref]$ts)) { return $ts.Hours }
  return 0
}

function F-Time($sec) {
  $ts = [TimeSpan]::FromSeconds([Math]::Round($sec))
  return ('{0:00}:{1:00}' -f [Math]::Floor($ts.TotalMinutes), $ts.Seconds)
}

function Avg($arr) {
  if (!$arr -or $arr.Count -eq 0) { return 0.0 }
  return (($arr | Measure-Object -Average).Average)
}

function Median($arr) {
  if (!$arr -or $arr.Count -eq 0) { return 0.0 }
  $s = @($arr | Sort-Object)
  $n = $s.Count
  if ($n % 2) { return [double]$s[[int][Math]::Floor($n / 2)] }
  return ([double]$s[$n / 2 - 1] + [double]$s[$n / 2]) / 2.0
}

function MonthKey($m) {
  @('', 'jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez')[$m]
}

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false

try {
  $wb = $excel.Workbooks.Open($xlsx, $null, $true)
  $ws = $wb.Worksheets.Item('BASE COMPLETA')
  $ur = $ws.UsedRange
  $data = $ur.Value2
  $rows = $ur.Rows.Count
  $cols = $ur.Columns.Count
  function V($r, $c) { $script:data.GetValue($r, $c) }

  $h = @{}
  for ($c = 1; $c -le $cols; $c++) { $h[[string](V 1 $c)] = $c }

  $records = New-Object System.Collections.Generic.List[object]
  for ($r = 2; $r -le $rows; $r++) {
    $m = [int](V $r $h['MÊS'])
    $ano = [int](V $r $h['ANO'])
    if ($ano -ne 2026 -or $m -lt 1 -or $m -gt 5) { continue }

    $avRaw = V $r $h['Avaliação']
    $av = $null
    if ($null -ne $avRaw -and ([string]$avRaw) -ne '' -and ([string]$avRaw) -ne 'SEM AVALIAÇÃO') {
      $av = [double]$avRaw
    }

    $records.Add([pscustomobject]@{
      mes = $m
      dia = [int](V $r $h['DIA'])
      semana = [string](V $r $h['Semana_MES'])
      periodo = [string](V $r $h['PERIODO'])
      atendSec = (To-Sec (V $r $h['Tempo atend']))
      protocolo = [string](V $r $h['Protocolo'])
      agente = (Normalize-Agent ([string](V $r $h['Agente'])))
      hora = (To-Hour (V $r $h['Hora']))
      esperaSec = (To-Sec (V $r $h['Tempo de Espera']))
      grupo = (Normalize-Group ([string](V $r $h['Nome do Grupo'])))
      avaliacao = $av
    })
  }

  $months = 1..5
  $focusMonth = [int](($records | Group-Object mes | Sort-Object { [int]$_.Name } -Descending | Select-Object -First 1).Name)
  $D = [ordered]@{
    meses = @('Jan', 'Fev', 'Mar', 'Abr', 'Mai')
    mesNomes = @('Janeiro 2026', 'Fevereiro 2026', 'Março 2026', 'Abril 2026', 'Maio 2026')
    focusMonth = $focusMonth
    focusIndex = $focusMonth - 1
    focusLabel = (@('', 'Janeiro 2026', 'Fevereiro 2026', 'Março 2026', 'Abril 2026', 'Maio 2026'))[$focusMonth]
  }

  $D.atend = @()
  $D.aval = @()
  $D.cobert = @()
  $D.sat = @()
  $D.tma = @()
  $D.tme = @()
  $D.sla = @()

  foreach ($m in $months) {
    $rs = @($records | Where-Object mes -eq $m)
    $ev = @($rs | Where-Object { $null -ne $_.avaliacao })
    $D.atend += $rs.Count
    $D.aval += $ev.Count
    $D.cobert += [Math]::Round(($ev.Count / [Math]::Max(1, $rs.Count)), 4)
    $D.sat += [Math]::Round((Avg @($ev | ForEach-Object avaliacao)), 3)
    $D.tma += (F-Time (Avg @($rs | ForEach-Object atendSec)))
    $D.tme += (F-Time (Avg @($rs | ForEach-Object esperaSec)))
    $D.sla += [Math]::Round((@($rs | Where-Object { $_.esperaSec -le 120 }).Count / [Math]::Max(1, $rs.Count)), 4)
  }

  $daily = [ordered]@{}
  foreach ($m in $months) {
    $daily[[string]$m] = [ordered]@{}
    foreach ($g in ($records | Where-Object mes -eq $m | Group-Object dia | Sort-Object { [int]$_.Name })) {
      $ev = @($g.Group | Where-Object { $null -ne $_.avaliacao })
      $c = if ($ev.Count) { [Math]::Round((Avg @($ev | ForEach-Object avaliacao)), 3) } else { $D.sat[$m - 1] }
      $daily[[string]$m][[string]$g.Name] = [ordered]@{ v = $g.Count; c = $c }
    }
  }
  $D.daily = $daily

  $dow = [ordered]@{}
  foreach ($m in $months) {
    $arr = @(0, 0, 0, 0, 0)
    foreach ($rec in @($records | Where-Object mes -eq $m)) {
      $dt = Get-Date -Year 2026 -Month $m -Day $rec.dia
      $idx = @{ Monday = 0; Tuesday = 1; Wednesday = 2; Thursday = 3; Friday = 4 }[$dt.DayOfWeek.ToString()]
      if ($null -ne $idx) { $arr[$idx]++ }
    }
    $dow[[string]$m] = $arr
  }
  $D.dow = $dow

  $semAll = [ordered]@{}
  foreach ($m in $months) {
    $keys = @($records | Where-Object mes -eq $m | Select-Object -ExpandProperty semana -Unique | Sort-Object)
    $semAll[[string]$m] = @($keys | ForEach-Object {
      $wk = $_
      @($records | Where-Object { $_.mes -eq $m -and $_.semana -eq $wk }).Count
    })
  }
  $D.semanas = $semAll

  $semDow = [ordered]@{}
  foreach ($wk in @($records | Where-Object mes -eq $focusMonth | Select-Object -ExpandProperty semana -Unique | Sort-Object)) {
    $arr = @(0, 0, 0, 0, 0)
    foreach ($rec in @($records | Where-Object { $_.mes -eq $focusMonth -and $_.semana -eq $wk })) {
      $dt = Get-Date -Year 2026 -Month $focusMonth -Day $rec.dia
      $idx = @{ Monday = 0; Tuesday = 1; Wednesday = 2; Thursday = 3; Friday = 4 }[$dt.DayOfWeek.ToString()]
      if ($null -ne $idx) { $arr[$idx]++ }
    }
    $semDow[$wk] = $arr
  }
  $D.semDow = $semDow

  $groupNames = @($records | Group-Object grupo | Sort-Object Count -Descending | ForEach-Object Name)
  $gr = [ordered]@{ nomes = $groupNames }
  foreach ($m in $months) {
    $arr = @()
    foreach ($gn in $groupNames) {
      $arr += @($records | Where-Object { $_.mes -eq $m -and $_.grupo -eq $gn }).Count
    }
    $gr[(MonthKey $m)] = $arr
  }
  $D.grupos = $gr

  $agents = @($records | Group-Object agente | Sort-Object Name | ForEach-Object Name)
  $ags = [ordered]@{}
  foreach ($a in $agents) {
    $vals = @()
    foreach ($m in $months) {
      $rs = @($records | Where-Object { $_.agente -eq $a -and $_.mes -eq $m })
      $ev = @($rs | Where-Object { $null -ne $_.avaliacao })
      $tmaVal = if ($rs.Count) { F-Time (Avg @($rs | ForEach-Object atendSec)) } else { '—' }
      $vals += ,@($rs.Count, $ev.Count, [Math]::Round((Avg @($ev | ForEach-Object avaliacao)), 2), $tmaVal)
    }
    $ags[$a] = $vals
  }
  $D.agentes = $ags
  $D.agentList = $agents
  $D.groupList = $groupNames
  $D.rows = @($records | ForEach-Object {
    ,@(
      $_.mes,
      $_.dia,
      $_.agente,
      $_.grupo,
      [Math]::Round($_.atendSec, 0),
      [Math]::Round($_.esperaSec, 0),
      $(if ($null -ne $_.avaliacao) { [double]$_.avaliacao } else { $null }),
      $_.protocolo,
      $_.periodo,
      $_.hora
    )
  })

  $focus = @($records | Where-Object mes -eq $focusMonth)

  $tmaAg = [ordered]@{}
  foreach ($g in ($focus | Group-Object agente | Sort-Object Name)) {
    $mins = @($g.Group | ForEach-Object { $_.atendSec / 60.0 })
    $tmaAg[$g.Name] = @(
      [Math]::Round((Avg $mins), 1),
      [Math]::Round((Median $mins), 1),
      [Math]::Round((($mins | Measure-Object -Maximum).Maximum), 1),
      $g.Count
    )
  }
  $D.tmaAg = $tmaAg

  $bins = @(0, 0, 0, 0, 0, 0)
  foreach ($rec in $focus) {
    $min = $rec.atendSec / 60.0
    if ($min -lt 10) { $bins[0]++ }
    elseif ($min -lt 20) { $bins[1]++ }
    elseif ($min -lt 30) { $bins[2]++ }
    elseif ($min -lt 45) { $bins[3]++ }
    elseif ($min -lt 60) { $bins[4]++ }
    else { $bins[5]++ }
  }
  $D.tmaDist = $bins

  $avDist = [ordered]@{}
  foreach ($g in ($focus | Where-Object { $null -ne $_.avaliacao } | Group-Object { [int]$_.avaliacao } | Sort-Object { [int]$_.Name })) {
    $avDist[[string]$g.Name] = $g.Count
  }
  $D.avDist = $avDist

  $low = [ordered]@{}
  foreach ($g in ($focus | Where-Object { $null -ne $_.avaliacao -and $_.avaliacao -lt 9 } | Group-Object agente | Sort-Object Count -Descending)) {
    $low[$g.Name] = $g.Count
  }
  $D.avBaixa = $low

  $hours = 8..17
  $D.hours = @($hours)
  $hourDow = @()
  foreach ($hr in $hours) {
    $row = @(0, 0, 0, 0, 0)
    foreach ($rec in @($focus | Where-Object hora -eq $hr)) {
      $dt = Get-Date -Year 2026 -Month $focusMonth -Day $rec.dia
      $idx = @{ Monday = 0; Tuesday = 1; Wednesday = 2; Thursday = 3; Friday = 4 }[$dt.DayOfWeek.ToString()]
      if ($null -ne $idx) { $row[$idx]++ }
    }
    $hourDow += ,$row
  }
  $D.hourDow = $hourDow
  $D.tmeHora = @($hours | ForEach-Object {
    $hr = $_
    [Math]::Round((Avg @($focus | Where-Object hora -eq $hr | ForEach-Object esperaSec)), 1)
  })

  $topGroups = @($focus | Group-Object grupo | Sort-Object Count -Descending | Select-Object -First 5 | ForEach-Object Name)
  $grpHora = [ordered]@{}
  foreach ($gn in $topGroups) {
    $grpHora[$gn] = @($hours | ForEach-Object {
      $hr = $_
      @($focus | Where-Object { $_.grupo -eq $gn -and $_.hora -eq $hr }).Count
    })
  }
  $D.grpHora = $grpHora

  $agGrp = [ordered]@{}
  foreach ($a in @($focus | Group-Object agente | Sort-Object Count -Descending | ForEach-Object Name)) {
    $ht = [ordered]@{}
    foreach ($g in ($focus | Where-Object agente -eq $a | Group-Object grupo | Sort-Object Count -Descending)) {
      $ht[$g.Name] = $g.Count
    }
    $agGrp[$a] = $ht
  }
  $D.agGrp = $agGrp

  $agDay = [ordered]@{}
  foreach ($m in $months) {
    $byAg = [ordered]@{}
    foreach ($a in @($records | Where-Object mes -eq $m | Group-Object agente | Sort-Object Name | ForEach-Object Name)) {
      $ht = [ordered]@{}
      foreach ($g in ($records | Where-Object { $_.mes -eq $m -and $_.agente -eq $a } | Group-Object dia | Sort-Object { [int]$_.Name })) {
        $ht[[string]$g.Name] = $g.Count
      }
      $byAg[$a] = $ht
    }
    $agDay[[string]$m] = $byAg
  }
  $D.agDay = $agDay
  $D.agDayMar = $agDay['3']

  $periodOrder = @(
    '1º Periodo da manhã', '2º Periodo da manhã', '3º Periodo da manhã', '4º Periodo da manhã',
    'Almoço 1', 'Almoço 2',
    '1º Periodo da tarde', '2º Periodo da tarde', '3º Periodo da tarde', '4º Periodo da tarde'
  )
  $periodHours = @{
    '1º Periodo da manhã' = '07–09h'
    '2º Periodo da manhã' = '09–10h'
    '3º Periodo da manhã' = '10–11h'
    '4º Periodo da manhã' = '11–12h'
    'Almoço 1' = '12–13h'
    'Almoço 2' = '13–14h'
    '1º Periodo da tarde' = '14–15h'
    '2º Periodo da tarde' = '15–16h'
    '3º Periodo da tarde' = '16–17h'
    '4º Periodo da tarde' = '17–18:30h'
  }
  $pers = @()
  foreach ($pname in $periodOrder) {
    $rs = @($focus | Where-Object periodo -eq $pname)
    $ev = @($rs | Where-Object { $null -ne $_.avaliacao })
    $pers += [ordered]@{
      n = ($pname -replace ' Periodo', ' Período')
      h = $periodHours[$pname]
      at = $rs.Count
      pct = [Math]::Round($rs.Count / [Math]::Max(1, $focus.Count), 3)
      av = $ev.Count
      cob = [Math]::Round($ev.Count / [Math]::Max(1, $rs.Count), 3)
      sat = [Math]::Round((Avg @($ev | ForEach-Object avaliacao)), 3)
      tma = (F-Time (Avg @($rs | ForEach-Object atendSec)))
      tme = (F-Time (Avg @($rs | ForEach-Object esperaSec)))
    }
  }
  $D.periodos = $pers

  $perMes = [ordered]@{}
  foreach ($m in $months) {
    $perMes[(MonthKey $m)] = @($periodOrder | ForEach-Object {
      $pn = $_
      @($records | Where-Object { $_.mes -eq $m -and $_.periodo -eq $pn }).Count
    })
  }
  $D.perMes = $perMes

  $csatDow = @()
  foreach ($di in 0..4) {
    $evs = @()
    foreach ($rec in $focus) {
      $dt = Get-Date -Year 2026 -Month $focusMonth -Day $rec.dia
      $idx = @{ Monday = 0; Tuesday = 1; Wednesday = 2; Thursday = 3; Friday = 4 }[$dt.DayOfWeek.ToString()]
      if ($idx -eq $di -and $null -ne $rec.avaliacao) { $evs += $rec.avaliacao }
    }
    $csatDow += [Math]::Round((Avg $evs), 3)
  }
  $D.csatDow = $csatDow

  $csatWeek = [ordered]@{ labels = @(); data = @() }
  foreach ($wk in @($focus | Select-Object -ExpandProperty semana -Unique | Sort-Object)) {
    $ev = @($focus | Where-Object { $_.semana -eq $wk -and $null -ne $_.avaliacao })
    $csatWeek.labels += $wk
    $csatWeek.data += [Math]::Round((Avg @($ev | ForEach-Object avaliacao)), 3)
  }
  $D.csatWeek = $csatWeek

  $byMonth = [ordered]@{}
  foreach ($mm in $months) {
    $focusM = @($records | Where-Object mes -eq $mm)
    $mk = MonthKey $mm

    $tmaAgM = [ordered]@{}
    foreach ($g in ($focusM | Group-Object agente | Sort-Object Name)) {
      $mins = @($g.Group | ForEach-Object { $_.atendSec / 60.0 })
      $tmaAgM[$g.Name] = @(
        [Math]::Round((Avg $mins), 1),
        [Math]::Round((Median $mins), 1),
        [Math]::Round((($mins | Measure-Object -Maximum).Maximum), 1),
        $g.Count
      )
    }

    $binsM = @(0, 0, 0, 0, 0, 0)
    foreach ($rec in $focusM) {
      $min = $rec.atendSec / 60.0
      if ($min -lt 10) { $binsM[0]++ }
      elseif ($min -lt 20) { $binsM[1]++ }
      elseif ($min -lt 30) { $binsM[2]++ }
      elseif ($min -lt 45) { $binsM[3]++ }
      elseif ($min -lt 60) { $binsM[4]++ }
      else { $binsM[5]++ }
    }

    $avDistM = [ordered]@{}
    foreach ($g in ($focusM | Where-Object { $null -ne $_.avaliacao } | Group-Object { [int]$_.avaliacao } | Sort-Object { [int]$_.Name })) {
      $avDistM[[string]$g.Name] = $g.Count
    }

    $lowM = [ordered]@{}
    foreach ($g in ($focusM | Where-Object { $null -ne $_.avaliacao -and $_.avaliacao -lt 9 } | Group-Object agente | Sort-Object Count -Descending)) {
      $lowM[$g.Name] = $g.Count
    }

    $hourDowM = @()
    foreach ($hr in $hours) {
      $row = @(0, 0, 0, 0, 0)
      foreach ($rec in @($focusM | Where-Object hora -eq $hr)) {
        $dt = Get-Date -Year 2026 -Month $mm -Day $rec.dia
        $idx = @{ Monday = 0; Tuesday = 1; Wednesday = 2; Thursday = 3; Friday = 4 }[$dt.DayOfWeek.ToString()]
        if ($null -ne $idx) { $row[$idx]++ }
      }
      $hourDowM += ,$row
    }

    $grpHoraM = [ordered]@{}
    foreach ($gn in @($focusM | Group-Object grupo | Sort-Object Count -Descending | Select-Object -First 5 | ForEach-Object Name)) {
      $grpHoraM[$gn] = @($hours | ForEach-Object {
        $hr = $_
        @($focusM | Where-Object { $_.grupo -eq $gn -and $_.hora -eq $hr }).Count
      })
    }

    $agGrpM = [ordered]@{}
    foreach ($a in @($focusM | Group-Object agente | Sort-Object Count -Descending | ForEach-Object Name)) {
      $ht = [ordered]@{}
      foreach ($g in ($focusM | Where-Object agente -eq $a | Group-Object grupo | Sort-Object Count -Descending)) {
        $ht[$g.Name] = $g.Count
      }
      $agGrpM[$a] = $ht
    }

    $persM = @()
    foreach ($pname in $periodOrder) {
      $rs = @($focusM | Where-Object periodo -eq $pname)
      $ev = @($rs | Where-Object { $null -ne $_.avaliacao })
      $persM += [ordered]@{
        n = ($pname -replace ' Periodo', ' Período')
        h = $periodHours[$pname]
        at = $rs.Count
        pct = [Math]::Round($rs.Count / [Math]::Max(1, $focusM.Count), 3)
        av = $ev.Count
        cob = [Math]::Round($ev.Count / [Math]::Max(1, $rs.Count), 3)
        sat = [Math]::Round((Avg @($ev | ForEach-Object avaliacao)), 3)
        tma = (F-Time (Avg @($rs | ForEach-Object atendSec)))
        tme = (F-Time (Avg @($rs | ForEach-Object esperaSec)))
      }
    }

    $csatDowM = @()
    foreach ($di in 0..4) {
      $evs = @()
      foreach ($rec in $focusM) {
        $dt = Get-Date -Year 2026 -Month $mm -Day $rec.dia
        $idx = @{ Monday = 0; Tuesday = 1; Wednesday = 2; Thursday = 3; Friday = 4 }[$dt.DayOfWeek.ToString()]
        if ($idx -eq $di -and $null -ne $rec.avaliacao) { $evs += $rec.avaliacao }
      }
      $csatDowM += [Math]::Round((Avg $evs), 3)
    }

    $csatWeekM = [ordered]@{ labels = @(); data = @() }
    foreach ($wk in @($focusM | Select-Object -ExpandProperty semana -Unique | Sort-Object)) {
      $ev = @($focusM | Where-Object { $_.semana -eq $wk -and $null -ne $_.avaliacao })
      $csatWeekM.labels += $wk
      $csatWeekM.data += [Math]::Round((Avg @($ev | ForEach-Object avaliacao)), 3)
    }

    $semDowM = [ordered]@{}
    foreach ($wk in @($focusM | Select-Object -ExpandProperty semana -Unique | Sort-Object)) {
      $arr = @(0, 0, 0, 0, 0)
      foreach ($rec in @($focusM | Where-Object semana -eq $wk)) {
        $dt = Get-Date -Year 2026 -Month $mm -Day $rec.dia
        $idx = @{ Monday = 0; Tuesday = 1; Wednesday = 2; Thursday = 3; Friday = 4 }[$dt.DayOfWeek.ToString()]
        if ($null -ne $idx) { $arr[$idx]++ }
      }
      $semDowM[$wk] = $arr
    }

    $byMonth[$mk] = [ordered]@{
      tmaAg = $tmaAgM
      tmaDist = $binsM
      avDist = $avDistM
      avBaixa = $lowM
      hourDow = $hourDowM
      tmeHora = @($hours | ForEach-Object {
        $hr = $_
        [Math]::Round((Avg @($focusM | Where-Object hora -eq $hr | ForEach-Object esperaSec)), 1)
      })
      grpHora = $grpHoraM
      agGrp = $agGrpM
      periodos = $persM
      csatDow = $csatDowM
      csatWeek = $csatWeekM
      semDow = $semDowM
    }
  }
  $D.byMonth = $byMonth

  $wsd = $wb.Worksheets.Item('DIÁRIO')
  $urd = $wsd.UsedRange
  $diary = @()
  for ($r = 87; $r -le $urd.Rows.Count; $r++) {
    $date = $wsd.Cells.Item($r, 3).Text
    $ag = $wsd.Cells.Item($r, 4).Text
    $proto = $wsd.Cells.Item($r, 5).Text
    $desc = $wsd.Cells.Item($r, 6).Text
    $ac = $wsd.Cells.Item($r, 7).Text
    if ([string]::IsNullOrWhiteSpace($date) -or [string]::IsNullOrWhiteSpace($ag)) { continue }
    try { $dtp = [datetime]::Parse($date) } catch { continue }
    $diary += [ordered]@{
      dt = $dtp.ToString('dd/MM')
      ag = (Normalize-Agent $ag).ToUpper()
      proto = $proto
      desc = $desc
      ac = $ac.Trim()
      mes = $dtp.Month
    }
  }
  $D.diary = $diary

  $json = $D | ConvertTo-Json -Depth 30
  $newBlock = "const D = $json;"
  $html = Get-Content -LiteralPath $htmlPath -Raw
  $html = [regex]::Replace(
    $html,
    'const D = \{[\s\S]*?\n\};\r?\n\r?\n// ════════ UTILS ════════',
    ($newBlock + "`r`n`r`n// ════════ UTILS ════════"),
    1
  )
  Set-Content -LiteralPath $htmlPath -Value $html -Encoding UTF8

  Write-Output "Updated D block. records=$($records.Count) diary=$($diary.Count)"
}
finally {
  if ($wb) { $wb.Close($false) | Out-Null }
  if ($excel) {
    $excel.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
  }
  Get-Process EXCEL -ErrorAction SilentlyContinue | Stop-Process -Force
}
