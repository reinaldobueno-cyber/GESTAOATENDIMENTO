[CmdletBinding()]
param(
  [string]$HtmlPath = '',
  [int]$Year = 2026,
  [int]$StartMonth = 1,
  [int]$EndMonth = 5,
  [int]$PageSize = 200,
  [string]$TreatmentsPath = '',
  [string]$ExportDir = '',
  [switch]$NoMirrorRoot
)

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$htmlPath = if ([string]::IsNullOrWhiteSpace($HtmlPath)) { Join-Path $scriptDir 'index.html' } else { $HtmlPath }
$treatmentsPath = if ([string]::IsNullOrWhiteSpace($TreatmentsPath)) { Join-Path $scriptDir 'tratamentos-neppo.csv' } else { $TreatmentsPath }
$exportDir = if ([string]::IsNullOrWhiteSpace($ExportDir)) { Join-Path $scriptDir 'exports' } else { $ExportDir }
$apiBase = 'https://api.neppo.com.br'
$authBase = 'https://api-auth.neppo.com.br'
$excludedGroups = @('Administrativo', 'Comercial', 'CSI')

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
    'Config. Balança' = 'Configuracao de balanca e bastao'
    'Configuracao de balanca e bastao' = 'Configuracao de balanca e bastao'
    'PMG e Comunic.' = 'PMG e Comunicacao para Associacao'
    'PMG e Comunicacao para Associacao' = 'PMG e Comunicacao para Associacao'
    'Reprodução' = 'Reproducao'
    'Reproducao' = 'Reproducao'
    'Ret. Envio Ativo' = 'Retorno envio ativo'
    'Retorno envio ativo' = 'Retorno envio ativo'
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
  return ('{0:00}:{1:00}:{2:00}' -f [Math]::Floor($ts.TotalHours), $ts.Minutes, $ts.Seconds)
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

function Get-NeppoToken {
  if (![string]::IsNullOrWhiteSpace($env:NEPPO_TOKEN)) { return $env:NEPPO_TOKEN }

  $required = @('NEPPO_CLIENT_KEY', 'NEPPO_CLIENT_SECRET', 'NEPPO_USERNAME', 'NEPPO_PASSWORD')
  foreach ($name in $required) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
      throw "Defina `$env:$name antes de executar, ou informe `$env:NEPPO_TOKEN."
    }
  }

  $pair = "$($env:NEPPO_CLIENT_KEY):$($env:NEPPO_CLIENT_SECRET)"
  $basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
  $response = Invoke-RestMethod `
    -Method Post `
    -Uri "$authBase/oauth2/token" `
    -Headers @{ Authorization = "Basic $basic" } `
    -ContentType 'application/x-www-form-urlencoded' `
    -Body @{ grant_type = 'password'; username = $env:NEPPO_USERNAME; password = $env:NEPPO_PASSWORD }

  if ([string]::IsNullOrWhiteSpace($response.access_token)) {
    throw 'A autenticação no NEPPO não retornou access_token.'
  }
  return $response.access_token
}

function Invoke-NeppoList([string]$Token, [string]$Endpoint, [int]$Page, [int]$Size, [array]$Conditions, [string]$SortColumn = 'createdAt') {
  $body = @{
    page = $Page
    size = $Size
    conditions = @($Conditions)
    sort = $true
    sortColumn = $SortColumn
    direction = 'DESC'
  } | ConvertTo-Json -Depth 20

  Invoke-RestMethod `
    -Method Post `
    -Uri "$apiBase/chatapi/1.0/api/$Endpoint" `
    -Headers @{ Authorization = "Bearer $Token" } `
    -ContentType 'application/json' `
    -Body $body
}

function Get-NeppoRowsUntil([string]$Token, [string]$Endpoint, [datetimeoffset]$Start, [datetimeoffset]$End, [array]$Conditions, [string]$DateField, [string]$SortColumn = 'createdAt') {
  $rows = New-Object System.Collections.Generic.List[object]
  for ($page = 0; ; $page++) {
    $response = Invoke-NeppoList -Token $Token -Endpoint $Endpoint -Page $page -Size $PageSize -Conditions $Conditions -SortColumn $SortColumn
    $batch = @($response.results)
    if ($batch.Count -eq 0) { break }

    $stop = $false
    foreach ($item in $batch) {
      $rawDate = [string]$item.$DateField
      if ([string]::IsNullOrWhiteSpace($rawDate)) { continue }
      $dt = [datetimeoffset]::Parse($rawDate)
      if ($dt -lt $Start) { $stop = $true; continue }
      if ($dt -ge $End) { continue }
      $rows.Add($item)
    }

    if ($stop) { break }
  }
  return $rows.ToArray()
}

function Get-PeriodName([int]$Hour) {
  if ($Hour -lt 10) { return '1 Periodo' }
  if ($Hour -lt 12) { return '2 Periodo' }
  if ($Hour -lt 14) { return '3 Periodo' }
  if ($Hour -lt 16) { return '4 Periodo' }
  return '5 Periodo'
}

function Get-WeekName([datetimeoffset]$Date) {
  return ('Sem.{0}' -f ([int][Math]::Ceiling($Date.Day / 7.0)))
}

function Normalize-Key([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  return (($Value.ToUpperInvariant() -replace '[^\p{L}\p{Nd}]+', ' ') -replace '\s+', ' ').Trim()
}

function Normalize-Document([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  return ($Value -replace '\D+', '')
}

function Split-ClientName([string]$Value) {
  $out = [ordered]@{ usuario = ''; contrato = '' }
  if ([string]::IsNullOrWhiteSpace($Value)) { return $out }
  $parts = $Value -split '\s+-\s+', 2
  if ($parts.Count -gt 1) {
    $out.usuario = $parts[0].Trim()
    $out.contrato = $parts[1].Trim()
  }
  else {
    $out.contrato = $Value.Trim()
  }
  return $out
}

function Test-Truthy([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  return @('1', 'sim', 's', 'true', 'verdadeiro', 'yes', 'y') -contains $Value.Trim().ToLower()
}

function Read-OptionalDouble([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $normalized = $Value.Trim().Replace(',', '.')
  $parsed = 0.0
  if ([double]::TryParse($normalized, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
    return $parsed
  }
  return $null
}

function Apply-Treatments($Records, [string]$Path) {
  $diary = New-Object System.Collections.Generic.List[object]
  if (!(Test-Path -LiteralPath $Path)) {
    return @{ Records = @($Records); Diary = @() }
  }

  $byProtocol = @{}
  foreach ($record in $Records) {
    if (![string]::IsNullOrWhiteSpace($record.protocolo)) {
      $byProtocol[$record.protocolo] = $record
    }
  }

  $remove = New-Object System.Collections.Generic.HashSet[string]
  foreach ($t in @(Import-Csv -LiteralPath $Path)) {
    $protocol = [string]$t.protocolo
    if ([string]::IsNullOrWhiteSpace($protocol) -or !$byProtocol.ContainsKey($protocol)) { continue }

    $record = $byProtocol[$protocol]
    $actions = New-Object System.Collections.Generic.List[string]

    if (Test-Truthy ([string]$t.ignorar)) {
      [void]$remove.Add($protocol)
      [void]$actions.Add('Ignorei o atendimento')
    }

    $newRating = Read-OptionalDouble ([string]$t.avaliacao)
    if ($null -ne $newRating) {
      $record.avaliacao = [double]$newRating
      [void]$actions.Add('Ajustei a avaliação')
    }

    $newTma = Read-OptionalDouble ([string]$t.atendSec)
    if ($null -ne $newTma) {
      $record.atendSec = [double]$newTma
      [void]$actions.Add('Ajustei o tempo de atendimento')
    }

    $newTme = Read-OptionalDouble ([string]$t.esperaSec)
    if ($null -ne $newTme) {
      $record.esperaSec = [double]$newTme
      [void]$actions.Add('Ajustei o tempo de espera')
    }

    if (![string]::IsNullOrWhiteSpace([string]$t.agente)) {
      $record.agente = Normalize-Agent ([string]$t.agente)
      [void]$actions.Add('Ajustei o agente')
    }

    if (![string]::IsNullOrWhiteSpace([string]$t.grupo)) {
      $record.grupo = Normalize-Group ([string]$t.grupo)
      [void]$actions.Add('Ajustei o grupo')
    }

    if (![string]::IsNullOrWhiteSpace([string]$t.periodo)) {
      $record.periodo = [string]$t.periodo
      [void]$actions.Add('Ajustei o período')
    }

    $desc = if (![string]::IsNullOrWhiteSpace([string]$t.motivo)) { [string]$t.motivo } else { 'Tratamento manual aplicado ao atendimento importado do NEPPO.' }
    $actionText = if (![string]::IsNullOrWhiteSpace([string]$t.acao)) { [string]$t.acao } elseif ($actions.Count) { ($actions -join '; ') } else { 'Tratamento registrado' }
    $diary.Add([ordered]@{
      dt = ('{0:00}/{1:00}' -f $record.dia, $record.mes)
      ag = $record.agente.ToUpper()
      proto = $protocol
      desc = $desc
      ac = $actionText
      mes = $record.mes
    })
  }

  $kept = @($Records | Where-Object { !$remove.Contains($_.protocolo) })
  return @{ Records = $kept; Diary = $diary.ToArray() }
}

function Write-Exports($Records, [string]$Path, [array]$Months) {
  if (!(Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }

  $attendancePath = Join-Path $Path 'atendimentos-neppo.csv'
  $clientMonthPath = Join-Path $Path 'clientes-por-mes.csv'
  $pendingMapPath = Join-Path $Path 'clientes-sem-cpf-cnpj.csv'

  $Records | Sort-Object mes, dia, criadoEm, protocolo | ForEach-Object {
    [pscustomobject]@{
      Mes = $_.mes
      Dia = $_.dia
      DataInicial = $_.criadoEm
      DataEncerramento = $_.encerradoEm
      Protocolo = $_.protocolo
      Agente = $_.agente
      Grupo = $_.grupo
      ClienteOriginal = $_.cliente
      UsuarioInformado = $_.clienteUsuario
      ContratoExtraido = $_.clienteContrato
      ChaveCliente = $_.clienteChave
      CpfCnpjNeppo = $_.cpfCnpj
      CodigoExternoNeppo = $_.codigoExterno
      UsuarioNeppo = $_.usuarioNeppo
      UsuarioIdNeppo = $_.usuarioId
      Telefone = $_.telefone
      TempoAtendimentoSeg = [Math]::Round($_.atendSec, 0)
      TempoEsperaSeg = [Math]::Round($_.esperaSec, 0)
      Avaliacao = $_.avaliacao
      Canal = $_.chamada
      Operacao = $_.operacao
      Status = $_.status
      SessionId = $_.sessionId
    }
  } | Export-Csv -LiteralPath $attendancePath -NoTypeInformation -Encoding UTF8

  $clientRows = foreach ($group in ($Records | Group-Object clienteChave)) {
    $items = @($group.Group)
    $first = $items | Select-Object -First 1
    $obj = [ordered]@{
      ChaveCliente = $group.Name
      CpfCnpjNeppo = ($items | Where-Object cpfCnpj | Select-Object -ExpandProperty cpfCnpj -First 1)
      CodigoExternoNeppo = ($items | Where-Object codigoExterno | Select-Object -ExpandProperty codigoExterno -First 1)
      ContratoExtraido = ($items | Where-Object clienteContrato | Select-Object -ExpandProperty clienteContrato -First 1)
      ClienteExemplo = $first.cliente
      Telefones = (($items | Select-Object -ExpandProperty telefone -Unique | Where-Object { $_ }) -join ' | ')
      Total = $items.Count
    }
    foreach ($m in $Months) {
      $obj[("Mes{0:00}" -f $m)] = @($items | Where-Object mes -eq $m).Count
    }
    [pscustomobject]$obj
  }

  $clientRows | Sort-Object -Property @{ Expression = 'Total'; Descending = $true }, 'ContratoExtraido' | Export-Csv -LiteralPath $clientMonthPath -NoTypeInformation -Encoding UTF8

  $clientRows |
    Where-Object { [string]::IsNullOrWhiteSpace($_.CpfCnpjNeppo) } |
    Sort-Object -Property @{ Expression = 'Total'; Descending = $true }, 'ContratoExtraido' |
    Export-Csv -LiteralPath $pendingMapPath -NoTypeInformation -Encoding UTF8

  Write-Output "Exports written: $attendancePath"
  Write-Output "Exports written: $clientMonthPath"
  Write-Output "Exports written: $pendingMapPath"
}

try {
  $start = [datetimeoffset]::new($Year, $StartMonth, 1, 0, 0, 0, [TimeSpan]::FromHours(-3))
  $endBase = [datetimeoffset]::new($Year, $EndMonth, 1, 0, 0, 0, [TimeSpan]::FromHours(-3))
  $end = $endBase.AddMonths(1)
  $token = Get-NeppoToken

  Write-Output "Buscando agentes no NEPPO..."
  $agentRows = @()
  for ($page = 0; ; $page++) {
    $batch = @((Invoke-NeppoList -Token $token -Endpoint 'agent' -Page $page -Size 200 -Conditions @() -SortColumn 'createdAt').results)
    if ($batch.Count -eq 0) { break }
    $agentRows += $batch
  }

  $agentByUserName = @{}
  foreach ($agentRow in $agentRows) {
    $user = $agentRow.user
    if ($null -eq $user) { continue }
    if ([string]$user.typeUser -ne 'AGENT') { continue }
    $display = Normalize-Agent ([string]$user.displayName)
    if ($display -match '@Botserver|Pesquisa|Fluxo') { continue }
    foreach ($key in @($user.userName, $agentRow.loginAttendance, $user.name)) {
      if (![string]::IsNullOrWhiteSpace([string]$key)) { $agentByUserName[[string]$key] = $display }
    }
  }

  Write-Output "Buscando sessões fechadas no NEPPO..."
  $sessions = Get-NeppoRowsUntil `
    -Token $token `
    -Endpoint 'user-session' `
    -Start $start `
    -End $end `
    -Conditions @(@{ key = 'status'; value = 'CLOSED'; operator = 'EQ'; logic = 'AND' }) `
    -DateField 'createdAt' `
    -SortColumn 'createdAt'

  Write-Output "Buscando avaliações no NEPPO..."
  $answers = Get-NeppoRowsUntil `
    -Token $token `
    -Endpoint 'chat-answer' `
    -Start $start `
    -End $end `
    -Conditions @() `
    -DateField 'createdAt' `
    -SortColumn 'createdAt'

  $ratingBySession = @{}
  foreach ($answer in $answers) {
    if ([int]$answer.questionId -ne 1) { continue }
    $option = [int]$answer.optionAnswerId
    if ($option -lt 20 -or $option -gt 30) { continue }
    $ratingBySession[[int]$answer.sessionId] = [double]($option - 20)
  }

  $records = New-Object System.Collections.Generic.List[object]
  foreach ($session in $sessions) {
    if ([bool]$session.onlyBot) { continue }
    $dt = [datetimeoffset]::Parse([string]$session.createdAt)
    $closedDt = $null
    if (![string]::IsNullOrWhiteSpace([string]$session.closedAt)) {
      $closedDt = [datetimeoffset]::Parse([string]$session.closedAt)
    }
    $lastAgent = [string]$session.lastAgent
    $agentName = ''
    if (![string]::IsNullOrWhiteSpace($lastAgent) -and $agentByUserName.ContainsKey($lastAgent)) {
      $agentName = $agentByUserName[$lastAgent]
    }
    elseif (![string]::IsNullOrWhiteSpace([string]$session.agent.displayName)) {
      $agentName = Normalize-Agent ([string]$session.agent.displayName)
    }
    elseif (![string]::IsNullOrWhiteSpace($lastAgent) -and $lastAgent -ne 'queue') {
      $agentName = Normalize-Agent $lastAgent
    }
    else {
      $agentName = 'Sem agente'
    }
    $rating = if ($ratingBySession.ContainsKey([int]$session.id)) { $ratingBySession[[int]$session.id] } else { $null }
    $clientName = [string]$session.user.displayName
    if ([string]::IsNullOrWhiteSpace($clientName)) { $clientName = [string]$session.user.name }
    if ([string]::IsNullOrWhiteSpace($clientName)) { $clientName = [string]$session.user.userName }
    $clientParts = Split-ClientName $clientName
    $cpfCnpj = Normalize-Document ([string]$session.user.cpf)
    $externalCode = [string]$session.user.externalCode
    $clientKey = if (![string]::IsNullOrWhiteSpace($cpfCnpj)) {
      "DOC:$cpfCnpj"
    }
    elseif (![string]::IsNullOrWhiteSpace($externalCode)) {
      "EXT:$externalCode"
    }
    elseif (![string]::IsNullOrWhiteSpace([string]$clientParts.contrato)) {
      "NOME:$(Normalize-Key ([string]$clientParts.contrato))"
    }
    else {
      "NOME:$(Normalize-Key $clientName)"
    }
    $phone = [string]$session.user.phone
    if ([string]::IsNullOrWhiteSpace($phone)) { $phone = [string]$session.externalProtocol }
    $groupName = Normalize-Group ([string]$session.groupConf.name)
    if ($excludedGroups -contains $groupName) { continue }

    $records.Add([pscustomobject]@{
      mes = $dt.Month
      dia = $dt.Day
      semana = Get-WeekName $dt
      periodo = Get-PeriodName $dt.Hour
      atendSec = [double]$session.tma
      protocolo = [string]$session.protocol
      agente = $agentName
      hora = $dt.Hour
      esperaSec = [double]$session.tme
      grupo = $groupName
      avaliacao = $rating
      criadoEm = $dt.ToString('dd/MM/yyyy HH:mm')
      encerradoEm = if ($null -ne $closedDt) { $closedDt.ToString('dd/MM/yyyy HH:mm') } else { '' }
      cliente = $clientName
      clienteUsuario = [string]$clientParts.usuario
      clienteContrato = [string]$clientParts.contrato
      clienteChave = $clientKey
      cpfCnpj = $cpfCnpj
      codigoExterno = $externalCode
      usuarioNeppo = [string]$session.user.userName
      usuarioId = [int]$session.user.id
      telefone = $phone
      chamada = [string]$session.user.originUser
      operacao = if (![string]::IsNullOrWhiteSpace([string]$session.groupConf.operation.operationName)) { [string]$session.groupConf.operation.operationName } else { 'MODELO' }
      status = [string]$session.status
      sessionId = [int]$session.id
    })
  }

  $treatmentResult = Apply-Treatments -Records $records.ToArray() -Path $treatmentsPath
  $records = @($treatmentResult.Records)
  $diary = @($treatmentResult.Diary)

  $months = $StartMonth..$EndMonth
  Write-Exports -Records @($records) -Path $exportDir -Months $months
  $focusMonth = [int](($records | Group-Object mes | Sort-Object { [int]$_.Name } -Descending | Select-Object -First 1).Name)
  $D = [ordered]@{
    meses = @('Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez')[($StartMonth - 1)..($EndMonth - 1)]
    mesNomes = @('Janeiro 2026', 'Fevereiro 2026', 'Março 2026', 'Abril 2026', 'Maio 2026', 'Junho 2026', 'Julho 2026', 'Agosto 2026', 'Setembro 2026', 'Outubro 2026', 'Novembro 2026', 'Dezembro 2026')[($StartMonth - 1)..($EndMonth - 1)]
    focusMonth = $focusMonth
    focusIndex = $focusMonth - $StartMonth
    focusLabel = (@('', 'Janeiro 2026', 'Fevereiro 2026', 'Março 2026', 'Abril 2026', 'Maio 2026', 'Junho 2026', 'Julho 2026', 'Agosto 2026', 'Setembro 2026', 'Outubro 2026', 'Novembro 2026', 'Dezembro 2026'))[$focusMonth]
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
      $_.hora,
      $_.criadoEm,
      $_.encerradoEm,
      $_.cliente,
      $_.telefone,
      $_.chamada,
      $_.status,
      $_.sessionId,
      $_.operacao,
      $_.clienteUsuario,
      $_.clienteContrato,
      $_.clienteChave,
      $_.cpfCnpj,
      $_.codigoExterno,
      $_.usuarioNeppo,
      $_.usuarioId
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
  if (!$NoMirrorRoot) {
    $rootHtmlPath = Join-Path (Split-Path -Parent $scriptDir) 'index.html'
    if ((Test-Path -LiteralPath $rootHtmlPath) -and $rootHtmlPath -ne $htmlPath) {
      Copy-Item -LiteralPath $htmlPath -Destination $rootHtmlPath -Force
    }
  }

  Write-Output "Updated D block. records=$($records.Count) diary=$($diary.Count)"
}
catch {
  throw
}
