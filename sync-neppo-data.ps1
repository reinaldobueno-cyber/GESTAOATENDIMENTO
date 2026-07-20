[CmdletBinding()]
param(
  [string]$HtmlPath = '',
  [int]$Year = 2026,
  [int]$StartMonth = 1,
  [int]$EndMonth = 5,
  [int]$PageSize = 200,
  [string]$TreatmentsPath = '',
  [string]$ExportDir = '',
  [switch]$ExportOnly,
  [switch]$NoMirrorRoot,
  [switch]$MergeExistingCsv,
  [switch]$SkipReviews,
  [switch]$DashboardOnly,
  [string]$ExistingCsvPath = ''
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
    -TimeoutSec 45 `
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

  $lastError = $null
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    try {
      return Invoke-RestMethod `
        -Method Post `
        -Uri "$apiBase/chatapi/1.0/api/$Endpoint" `
        -Headers @{ Authorization = "Bearer $Token" } `
        -ContentType 'application/json' `
        -TimeoutSec 45 `
        -Body $body
    }
    catch {
      $lastError = $_
      $statusCode = $null
      try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
      if (($statusCode -eq 401 -or $statusCode -eq 403) -and $attempt -lt 4) {
        Write-Warning "NEPPO recusou o token em $Endpoint pagina $Page. Vou renovar a autenticacao e tentar novamente."
        $env:NEPPO_TOKEN = ''
        $Token = Get-NeppoToken
        Start-Sleep -Seconds 2
        continue
      }
      if ($statusCode -eq 401 -or $statusCode -eq 403) { throw }
      if ($attempt -lt 4) {
        $delay = [Math]::Min(30, 2 * $attempt * $attempt)
        Write-Warning "Falha temporaria NEPPO em $Endpoint pagina $Page. Tentativa $attempt/4. Nova tentativa em ${delay}s. $($_.Exception.Message)"
        Start-Sleep -Seconds $delay
      }
    }
  }
  throw $lastError
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

function ConvertTo-BrazilOffset([datetimeoffset]$Value) {
  return $Value.ToOffset([TimeSpan]::FromHours(-3))
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

function Get-ClientIdentityWords([string]$Value) {
  $ignored = @(
    'AGRO', 'AGROPECUARIA', 'AGROPECUARIO', 'BOVINOS', 'CLIENTE', 'CPF',
    'DA', 'DAS', 'DE', 'DO', 'DOS', 'E', 'FAZ', 'FAZENDA', 'GRUPO',
    'LTDA', 'ME', 'OUTRO', 'OUTROS', 'PECUARIA', 'SA'
  )
  return @(
    (Normalize-Key $Value) -split '\s+' |
      Where-Object { $_.Length -ge 3 -and $ignored -notcontains $_ }
  )
}

function Test-SameClientIdentity([string]$Left, [string]$Right) {
  $leftWords = @(Get-ClientIdentityWords $Left)
  $rightWords = @(Get-ClientIdentityWords $Right)
  if ($leftWords.Count -eq 0 -or $rightWords.Count -eq 0) {
    return (Normalize-Key $Left) -eq (Normalize-Key $Right)
  }
  return @($leftWords | Where-Object { $rightWords -contains $_ }).Count -gt 0
}

function Remove-DuplicateProtocols($Records) {
  $deduplicated = New-Object System.Collections.Generic.List[object]
  $duplicateCount = 0
  foreach ($group in @($Records | Group-Object protocolo)) {
    if ([string]::IsNullOrWhiteSpace([string]$group.Name)) {
      foreach ($record in $group.Group) { $deduplicated.Add($record) }
      continue
    }
    $selected = $group.Group |
      Sort-Object @{ Expression = { if ([string]$_.status -eq 'CLOSED') { 0 } else { 1 } }; Ascending = $true },
                  @{ Expression = 'sessionId'; Descending = $true } |
      Select-Object -First 1
    $deduplicated.Add($selected)
    $duplicateCount += $group.Count - 1
  }
  if ($duplicateCount -gt 0) {
    Write-Warning "Protocolos duplicados removidos: $duplicateCount registro(s)."
  }
  return $deduplicated.ToArray()
}

function Resolve-DocumentClientConflicts($Records) {
  $conflictCount = 0
  foreach ($docGroup in @($Records | Where-Object { [string]$_.clienteChave -like 'DOC:*' } | Group-Object clienteChave)) {
    $contractGroups = @(
      $docGroup.Group |
        Where-Object { ![string]::IsNullOrWhiteSpace([string]$_.clienteContrato) } |
        Group-Object { Normalize-Key ([string]$_.clienteContrato) } |
        Where-Object { ![string]::IsNullOrWhiteSpace([string]$_.Name) } |
        Sort-Object @{ Expression = 'Count'; Descending = $true }, @{ Expression = 'Name'; Ascending = $true }
    )
    if ($contractGroups.Count -le 1) { continue }

    $dominantContract = [string]$contractGroups[0].Name
    $separated = $false
    foreach ($record in $docGroup.Group) {
      $contractKey = Normalize-Key ([string]$record.clienteContrato)
      if ([string]::IsNullOrWhiteSpace($contractKey) -or (Test-SameClientIdentity $dominantContract $contractKey)) { continue }
      $record.clienteChave = "$($docGroup.Name)|NOME:$contractKey"
      $separated = $true
    }
    if ($separated) {
      $conflictCount++
      Write-Warning "Documento compartilhado por clientes diferentes: $($docGroup.Name). Mantido no documento: $dominantContract; clientes incompatíveis foram separados."
    }
  }
  if ($conflictCount -gt 0) {
    Write-Host "Conflitos de identidade separados: $conflictCount documento(s)."
  }
  return @($Records)
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
    if ($t.PSObject.Properties.Name -contains 'ano' -and ![string]::IsNullOrWhiteSpace([string]$t.ano) -and [int]$t.ano -ne $Year) {
      continue
    }
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

function Write-DiaryExport([array]$Diary, [string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
  $diaryPath = Join-Path $Path 'diario-tratamentos.csv'
  @($Diary) | ForEach-Object {
    [pscustomobject]@{
      Ano = $Year
      Mes = $_.mes
      Data = $_.dt
      Agente = $_.ag
      Protocolo = $_.proto
      Acao = $_.ac
      Descricao = $_.desc
    }
  } | Export-Csv -LiteralPath $diaryPath -NoTypeInformation -Encoding UTF8
  Write-Output "Exports written: $diaryPath"
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
    $representativeContract = $items |
      Where-Object { ![string]::IsNullOrWhiteSpace([string]$_.clienteContrato) } |
      Group-Object clienteContrato |
      Sort-Object @{ Expression = 'Count'; Descending = $true }, @{ Expression = 'Name'; Ascending = $true } |
      Select-Object -First 1
    $representativeClient = $items |
      Where-Object { ![string]::IsNullOrWhiteSpace([string]$_.cliente) } |
      Group-Object cliente |
      Sort-Object @{ Expression = 'Count'; Descending = $true }, @{ Expression = 'Name'; Ascending = $true } |
      Select-Object -First 1
    $obj = [ordered]@{
      ChaveCliente = $group.Name
      CpfCnpjNeppo = ($items | Where-Object cpfCnpj | Select-Object -ExpandProperty cpfCnpj -First 1)
      CodigoExternoNeppo = ($items | Where-Object codigoExterno | Select-Object -ExpandProperty codigoExterno -First 1)
      ContratoExtraido = if ($null -ne $representativeContract) { [string]$representativeContract.Name } else { '' }
      ClienteExemplo = if ($null -ne $representativeClient) { [string]$representativeClient.Name } else { '' }
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

function Write-AttendanceExport($Records, [string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }

  $attendancePath = Join-Path $Path 'atendimentos-neppo.csv'
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
  Write-Output "Exports written: $attendancePath"
}

function To-NullableDouble([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -eq '—') { return $null }
  $normalized = $Value.Replace(',', '.')
  $parsed = 0.0
  if ([double]::TryParse($normalized, [System.Globalization.NumberStyles]::Any, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
    return [double]$parsed
  }
  return $null
}

function Import-RecordsFromCsv([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or !(Test-Path -LiteralPath $Path)) { return @() }
  $imported = New-Object System.Collections.Generic.List[object]
  foreach ($row in @(Import-Csv -LiteralPath $Path)) {
    $created = [datetime]::MinValue
    if (![datetime]::TryParse([string]$row.DataInicial, [ref]$created)) {
      $created = Get-Date -Year ([int]$Year) -Month ([int]$row.Mes) -Day ([int]$row.Dia) -Hour 0 -Minute 0 -Second 0
    }
    $rating = To-NullableDouble ([string]$row.Avaliacao)
    $atendSec = To-NullableDouble ([string]$row.TempoAtendimentoSeg)
    $esperaSec = To-NullableDouble ([string]$row.TempoEsperaSeg)
    $usuarioId = To-NullableDouble ([string]$row.UsuarioIdNeppo)
    $sessionId = To-NullableDouble ([string]$row.SessionId)
    $imported.Add([pscustomobject]@{
      mes = [int]$row.Mes
      dia = [int]$row.Dia
      semana = Get-WeekName ([datetimeoffset]$created)
      periodo = Get-PeriodName $created.Hour
      atendSec = if ($null -ne $atendSec) { [double]$atendSec } else { 0.0 }
      protocolo = [string]$row.Protocolo
      agente = Normalize-Agent ([string]$row.Agente)
      hora = $created.Hour
      esperaSec = if ($null -ne $esperaSec) { [double]$esperaSec } else { 0.0 }
      grupo = Normalize-Group ([string]$row.Grupo)
      avaliacao = $rating
      criadoEm = [string]$row.DataInicial
      encerradoEm = [string]$row.DataEncerramento
      cliente = [string]$row.ClienteOriginal
      clienteUsuario = [string]$row.UsuarioInformado
      clienteContrato = [string]$row.ContratoExtraido
      clienteChave = [string]$row.ChaveCliente
      cpfCnpj = [string]$row.CpfCnpjNeppo
      codigoExterno = [string]$row.CodigoExternoNeppo
      usuarioNeppo = [string]$row.UsuarioNeppo
      usuarioId = if ($null -ne $usuarioId) { [int]$usuarioId } else { 0 }
      telefone = [string]$row.Telefone
      chamada = [string]$row.Canal
      operacao = [string]$row.Operacao
      status = [string]$row.Status
      sessionId = if ($null -ne $sessionId) { [int]$sessionId } else { 0 }
    })
  }
  return $imported.ToArray()
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

  Write-Output "Buscando sessões operacionais no NEPPO..."
  $sessions = Get-NeppoRowsUntil `
    -Token $token `
    -Endpoint 'user-session' `
    -Start $start `
    -End $end `
    -Conditions @() `
    -DateField 'createdAt' `
    -SortColumn 'createdAt'

  $ratingBySession = @{}
  if ($SkipReviews) {
    Write-Output "Pulando avaliações no NEPPO nesta atualização rápida; preservando avaliações já salvas."
    $existingPathForRatings = if (![string]::IsNullOrWhiteSpace($ExistingCsvPath)) { $ExistingCsvPath } else { Join-Path $exportDir 'atendimentos-neppo.csv' }
    foreach ($existing in @(Import-RecordsFromCsv -Path $existingPathForRatings)) {
      if ($existing.sessionId -and $existing.sessionId -gt 0 -and $null -ne $existing.avaliacao) {
        $ratingBySession[[int]$existing.sessionId] = [double]$existing.avaliacao
      }
    }
  } else {
    Write-Output "Buscando avaliações no NEPPO..."
    $answers = Get-NeppoRowsUntil `
      -Token $token `
      -Endpoint 'chat-answer' `
      -Start $start `
      -End $end `
      -Conditions @() `
      -DateField 'createdAt' `
      -SortColumn 'createdAt'

    foreach ($answer in $answers) {
      if ([int]$answer.questionId -ne 1) { continue }
      $option = [int]$answer.optionAnswerId
      if ($option -lt 20 -or $option -gt 30) { continue }
      $ratingBySession[[int]$answer.sessionId] = [double]($option - 20)
    }
  }

  $records = New-Object System.Collections.Generic.List[object]
  foreach ($session in $sessions) {
    if ([bool]$session.onlyBot) { continue }
    $dt = ConvertTo-BrazilOffset ([datetimeoffset]::Parse([string]$session.createdAt))
    $closedDt = $null
    if (![string]::IsNullOrWhiteSpace([string]$session.closedAt)) {
      $closedDt = ConvertTo-BrazilOffset ([datetimeoffset]::Parse([string]$session.closedAt))
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

  if ($MergeExistingCsv) {
    $existingPath = if (![string]::IsNullOrWhiteSpace($ExistingCsvPath)) { $ExistingCsvPath } else { Join-Path $exportDir 'atendimentos-neppo.csv' }
    $replaceMonths = New-Object System.Collections.Generic.HashSet[int]
    foreach ($m in ($StartMonth..$EndMonth)) { [void]$replaceMonths.Add([int]$m) }
    $currentCount = $records.Count
    $preserved = @(Import-RecordsFromCsv -Path $existingPath | Where-Object { !$replaceMonths.Contains([int]$_.mes) })
    foreach ($older in $preserved) { $records.Add($older) }
    Write-Output "Merge incremental: atualizados=$currentCount preservados=$($preserved.Count)"
  }

  $records = @(Remove-DuplicateProtocols -Records $records.ToArray())

  if ($DashboardOnly) {
    Write-Output 'Modo dashboard: pulando reconciliação pesada de clientes e tratamentos auxiliares.'
    $diary = @()
  } else {
    $records = @(Resolve-DocumentClientConflicts -Records $records)

    $treatmentResult = Apply-Treatments -Records $records -Path $treatmentsPath
    $records = @($treatmentResult.Records)
    $diary = @($treatmentResult.Diary)
  }

  $months = if ($MergeExistingCsv) {
    @($records | Group-Object mes | Sort-Object { [int]$_.Name } | ForEach-Object { [int]$_.Name })
  } else {
    $StartMonth..$EndMonth
  }
  if ($DashboardOnly) {
    Write-AttendanceExport -Records @($records) -Path $exportDir
  } else {
    Write-Exports -Records @($records) -Path $exportDir -Months $months
    Write-DiaryExport -Diary @($diary) -Path $exportDir
  }
  if ($ExportOnly) {
    Write-Output "Export-only mode. records=$($records.Count) diary=$($diary.Count)"
    return
  }

  if ($SkipReviews -or $DashboardOnly) {
    $nodeCandidates = @()
    if (![string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
      $nodeCandidates += (Join-Path (Join-Path $env:LOCALAPPDATA 'CodexTools') (Join-Path 'node-v22' 'node.exe'))
    }
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $nodeCandidates += $nodeCommand.Source }
    $nodeCandidates = @($nodeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
    if ($nodeCandidates.Count -eq 0) {
      throw 'Node.js nao encontrado para montar o dashboard rapido.'
    }
    $builderPath = Join-Path $scriptDir 'tools\build-dashboard-data.js'
    if (!(Test-Path -LiteralPath $builderPath)) {
      throw "Construtor rapido nao encontrado: $builderPath"
    }
    $nodeExe = @($nodeCandidates)[0]
    & $nodeExe $builderPath "--html=$htmlPath" "--exports=$exportDir" "--year=$Year"
    if ($LASTEXITCODE -ne 0) {
      throw "Construtor rapido do dashboard falhou com codigo $LASTEXITCODE."
    }
    if (!$NoMirrorRoot) {
      $rootHtmlPath = Join-Path (Split-Path -Parent $scriptDir) 'index.html'
      if ((Test-Path -LiteralPath $rootHtmlPath) -and $rootHtmlPath -ne $htmlPath) {
        Copy-Item -LiteralPath $htmlPath -Destination $rootHtmlPath -Force
      }
    }
    return
  }

  $focusMonth = [int](($records | Group-Object mes | Sort-Object { [int]$_.Name } -Descending | Select-Object -First 1).Name)
  $recordsByMonth = @{}
  foreach ($monthGroup in ($records | Group-Object mes)) {
    $recordsByMonth[[int]$monthGroup.Name] = @($monthGroup.Group)
  }
  $monthShortNames = @('', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez')
  $monthFullNames = @('', 'Janeiro 2026', 'Fevereiro 2026', 'Março 2026', 'Abril 2026', 'Maio 2026', 'Junho 2026', 'Julho 2026', 'Agosto 2026', 'Setembro 2026', 'Outubro 2026', 'Novembro 2026', 'Dezembro 2026')
  $D = [ordered]@{
    meses = @($months | ForEach-Object { $monthShortNames[[int]$_] })
    mesNomes = @($months | ForEach-Object { $monthFullNames[[int]$_] })
    focusMonth = $focusMonth
    focusIndex = [array]::IndexOf([int[]]$months, $focusMonth)
    focusLabel = $monthFullNames[$focusMonth]
  }

  $D.atend = @()
  $D.aval = @()
  $D.closed = @()
  $D.open = @()
  $D.cobert = @()
  $D.sat = @()
  $D.tma = @()
  $D.tme = @()
  $D.sla = @()

  foreach ($m in $months) {
    $rs = @($recordsByMonth[[int]$m])
    $closed = @($rs | Where-Object { [string]$_.status -eq 'CLOSED' })
    $open = @($rs | Where-Object { [string]$_.status -ne 'CLOSED' })
    $ev = @($closed | Where-Object { $null -ne $_.avaliacao })
    $D.atend += $rs.Count
    $D.closed += $closed.Count
    $D.open += $open.Count
    $D.aval += $ev.Count
    $D.cobert += [Math]::Round(($ev.Count / [Math]::Max(1, $closed.Count)), 4)
    $D.sat += [Math]::Round((Avg @($ev | ForEach-Object avaliacao)), 3)
    $D.tma += (F-Time (Avg @($closed | ForEach-Object atendSec)))
    $D.tme += (F-Time (Avg @($closed | ForEach-Object esperaSec)))
    $D.sla += [Math]::Round((@($closed | Where-Object { $_.esperaSec -le 120 }).Count / [Math]::Max(1, $closed.Count)), 4)
  }

  $daily = [ordered]@{}
  foreach ($m in $months) {
    $daily[[string]$m] = [ordered]@{}
    foreach ($g in (@($recordsByMonth[[int]$m]) | Group-Object dia | Sort-Object { [int]$_.Name })) {
      $ev = @($g.Group | Where-Object { $null -ne $_.avaliacao })
      $c = if ($ev.Count) { [Math]::Round((Avg @($ev | ForEach-Object avaliacao)), 3) } else { $D.sat[$m - 1] }
      $daily[[string]$m][[string]$g.Name] = [ordered]@{ v = $g.Count; c = $c }
    }
  }
  $D.daily = $daily

  $dow = [ordered]@{}
  foreach ($m in $months) {
    $arr = @(0, 0, 0, 0, 0)
    foreach ($rec in @($recordsByMonth[[int]$m])) {
      $dt = Get-Date -Year 2026 -Month $m -Day $rec.dia
      $idx = @{ Monday = 0; Tuesday = 1; Wednesday = 2; Thursday = 3; Friday = 4 }[$dt.DayOfWeek.ToString()]
      if ($null -ne $idx) { $arr[$idx]++ }
    }
    $dow[[string]$m] = $arr
  }
  $D.dow = $dow

  $semAll = [ordered]@{}
  foreach ($m in $months) {
    $monthRecords = @($recordsByMonth[[int]$m])
    $keys = @($monthRecords | Select-Object -ExpandProperty semana -Unique | Sort-Object)
    $semAll[[string]$m] = @($keys | ForEach-Object {
      $wk = $_
      @($monthRecords | Where-Object { $_.semana -eq $wk }).Count
    })
  }
  $D.semanas = $semAll

  $semDow = [ordered]@{}
  foreach ($wk in @($recordsByMonth[[int]$focusMonth] | Select-Object -ExpandProperty semana -Unique | Sort-Object)) {
    $arr = @(0, 0, 0, 0, 0)
    foreach ($rec in @($recordsByMonth[[int]$focusMonth] | Where-Object { $_.semana -eq $wk })) {
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
      $arr += @($recordsByMonth[[int]$m] | Where-Object { $_.grupo -eq $gn }).Count
    }
    $gr[(MonthKey $m)] = $arr
  }
  $D.grupos = $gr

  $agents = @($records | Group-Object agente | Sort-Object Name | ForEach-Object Name)
  $ags = [ordered]@{}
  foreach ($a in $agents) {
    $vals = @()
    foreach ($m in $months) {
      $rs = @($recordsByMonth[[int]$m] | Where-Object { $_.agente -eq $a })
      $closed = @($rs | Where-Object { [string]$_.status -eq 'CLOSED' })
      $ev = @($closed | Where-Object { $null -ne $_.avaliacao })
      $tmaVal = if ($closed.Count) { F-Time (Avg @($closed | ForEach-Object atendSec)) } else { '—' }
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

  $focus = @($recordsByMonth[[int]$focusMonth])

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
    $monthRecords = @($recordsByMonth[[int]$m])
    foreach ($a in @($monthRecords | Group-Object agente | Sort-Object Name | ForEach-Object Name)) {
      $ht = [ordered]@{}
      foreach ($g in ($monthRecords | Where-Object { $_.agente -eq $a } | Group-Object dia | Sort-Object { [int]$_.Name })) {
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
      @($recordsByMonth[[int]$m] | Where-Object { $_.periodo -eq $pn }).Count
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
    $focusM = @($recordsByMonth[[int]$mm])
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

  function Get-DashboardDataBlock {
    param(
      [Parameter(Mandatory = $true)][string]$Html
    )

    $prefix = 'const D ='
    $prefixIndex = $Html.IndexOf($prefix)
    if ($prefixIndex -lt 0) { throw 'Bloco const D nao encontrado no HTML.' }

    $jsonStart = $Html.IndexOf('{', $prefixIndex)
    if ($jsonStart -lt 0) { throw 'Inicio do bloco const D nao encontrado no HTML.' }

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

    throw 'Fim do bloco const D nao encontrado no HTML.'
  }

  function Ensure-DashboardLiveRefresh {
    param(
      [Parameter(Mandatory = $true)][string]$Html
    )

    $refreshBlock = @'
// Atualiza os números quando a rotina NEPPO publicar uma nova versão do painel.
let dashboardAssetSignature='';
let dashboardAssetRefreshBusy=false;
function initializeDashboardAssetSignature(){
  if(!dashboardAssetSignature)dashboardAssetSignature=dashboardNumbersSignature(D);
}
function canReloadDashboardAsset(){
  if(document.visibilityState&&document.visibilityState!=='visible')return false;
  if(document.querySelector('.modal.open'))return false;
  return true;
}
function saoPauloNowParts(){
  const br=new Date(Date.now()-3*60*60*1000);
  return {year:br.getUTCFullYear(),month:br.getUTCMonth(),day:br.getUTCDate(),dow:br.getUTCDay(),hour:br.getUTCHours(),minute:br.getUTCMinutes()};
}
function nextNeppoBusinessStartMs(){
  const p=saoPauloNowParts();
  let brStart=Date.UTC(p.year,p.month,p.day,8,0,0);
  const brNow=Date.UTC(p.year,p.month,p.day,p.hour,p.minute,0);
  let dow=p.dow;
  if(dow>=1&&dow<=5&&p.hour<8)return brStart+3*60*60*1000;
  do{brStart+=24*60*60*1000;dow=(dow+1)%7;}while(dow===0||dow===6||brStart<=brNow);
  return brStart+3*60*60*1000;
}
function neppoBusinessOpen(){
  const p=saoPauloNowParts();
  return p.dow>=1&&p.dow<=5&&p.hour>=8&&p.hour<18;
}
function extractDashboardDataFromHtml(html){
  const marker='const D =';
  const markerIndex=html.indexOf(marker);
  if(markerIndex<0)return null;
  const start=html.indexOf('{',markerIndex);
  if(start<0)return null;
  let depth=0,inString=false,escaped=false;
  for(let i=start;i<html.length;i++){
    const ch=html[i];
    if(inString){
      if(escaped)escaped=false;
      else if(ch==='\\')escaped=true;
      else if(ch==='"')inString=false;
      continue;
    }
    if(ch==='"')inString=true;
    else if(ch==='{')depth++;
    else if(ch==='}'){
      depth--;
      if(depth===0){
        try{return JSON.parse(html.slice(start,i+1));}
        catch{return null;}
      }
    }
  }
  return null;
}
function dashboardNumbersSignature(data){
  if(!data)return '';
  const rows=Array.isArray(data.rows)?data.rows:[];
  return JSON.stringify({atend:data.atend||[],open:data.open||[],closed:data.closed||[],aval:data.aval||[],focusMonth:data.focusMonth||0,rowCount:rows.length,lastRows:rows.slice(-5)});
}
async function readDashboardLivePayload(force=false){
  const controller=new AbortController();
  const timeoutId=setTimeout(()=>controller.abort(),25000);
  try{
    const url=new URL('/api/neppo-live/dashboard',location.origin);
    url.searchParams.set('year','2026');
    url.searchParams.set('month',String(D.focusMonth||new Date().getMonth()+1));
    url.searchParams.set('_',Date.now());
    if(force)url.searchParams.set('force','1');
    const res=await fetch(url.toString(),{cache:'no-store',credentials:'same-origin',signal:controller.signal});
    const payload=await res.json().catch(()=>null);
    if(!res.ok||!payload?.ok||!payload?.data)return null;
    return {data:payload.data,signature:payload.signature||dashboardNumbersSignature(payload.data),meta:payload.meta||{},source:'neppo-live'};
  }catch{return null;}
  finally{clearTimeout(timeoutId);}
}
async function readDashboardAssetPayload(force=false){
  const controller=new AbortController();
  const timeoutId=setTimeout(()=>controller.abort(),12000);
  try{
    const live=await readDashboardLivePayload(force);
    if(live)return live;
    const url=new URL(location.href);
    url.searchParams.set('__dashboard_version',Date.now());
    const res=await fetch(url.toString(),{cache:'no-store',credentials:'same-origin',signal:controller.signal});
    if(!res.ok)return null;
    const html=await res.text();
    const data=extractDashboardDataFromHtml(html);
    const signature=dashboardNumbersSignature(data);
    return data&&signature?{data,signature}:null;
  }catch{return null;}
  finally{clearTimeout(timeoutId);}
}
function activeDashboardPaneId(){return document.querySelector('.pane.active')?.id?.replace(/^pane-/,'')||'visao';}
function replaceDashboardData(nextData){
  if(!nextData||!Array.isArray(nextData.meses))return false;
  const oldMonthCount=Array.isArray(D.meses)?D.meses.length:0;
  Object.keys(D).forEach(k=>delete D[k]);
  Object.assign(D,nextData);
  normalizeDashboardMonths();
  applyManualAdjustments();
  return oldMonthCount===D.meses.length;
}
function rebuildMonthButtons(){
  if($('ov-ms')){$('ov-ms').innerHTML='';buildOvMs();}
  if($('ag-ms')){$('ag-ms').innerHTML='';buildAgMs();}
  buildGlobalMonthSelect();
}
function renderCurrentDashboardPane(paneId){
  const month=Math.max(0,Math.min(appM,D.meses.length-1));
  rebuildMonthButtons();
  setGlobalMonth(month);
  if(paneId==='historico')renderHistorico();
  if(paneId==='atendimentos')renderAtendimentos();
  if(paneId==='tratamentos')renderTreatments();
  if(paneId==='bonificacao')renderBonus();
  if(paneId==='whatsapp-grupo')renderWhatsappGroupRecords();
  const stamp=new Date().toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'})+' · '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  if($('top-date'))$('top-date').textContent='Atualizado '+stamp;
  if($('footer-date'))$('footer-date').textContent='Exportado em '+stamp;
  renderNeppoRefreshStatus();
}
async function checkDashboardAssetUpdate(options={}){
  if(options===true)options={manual:true,force:true};
  const manual=!!options.manual;
  const force=!!options.force||manual;
  if(dashboardAssetRefreshBusy){if(manual)toast('Verificação NEPPO já está em andamento.');return false;}
  if(!manual&&!neppoBusinessOpen()){
    const nextStart=nextNeppoBusinessStartMs();
    dashboardLastCheckMessage='Fora do expediente NEPPO. Próxima tentativa na próxima janela útil.';
    scheduleDashboardNextCheck(Math.max(60000,nextStart-Date.now()));
    if(typeof loadNeppoLiveHealth==='function')loadNeppoLiveHealth();
    return false;
  }
  if(!force&&!canReloadDashboardAsset()){
    dashboardLastCheckMessage='Atualização aguardando a tela liberar. Nova tentativa em segundos.';
    scheduleDashboardNextCheck(5000);
    return false;
  }
  initializeDashboardAssetSignature();
  dashboardAssetRefreshBusy=true;
  if(manual){dashboardLastCheckMessage='Verificando agora...';renderNeppoRefreshStatus();}
  let payload=null;
  try{
    payload=await readDashboardAssetPayload(force);
  }finally{
    dashboardAssetRefreshBusy=false;
  }
  if(!payload){dashboardLastCheckMessage='Falha ao consultar a base NEPPO. Nova tentativa em 1 minuto.';scheduleDashboardNextCheck(DASHBOARD_REFRESH_RETRY_MS);if(manual)toast('Não consegui consultar a nova base agora.',true);return false;}
  const {data,signature}=payload;
  if(!dashboardAssetSignature){dashboardAssetSignature=signature;dashboardLastCheckMessage='Base conferida. Nenhuma mudança ainda.';if(!dashboardNextCheckAtMs||dashboardNextCheckAtMs<=Date.now())scheduleDashboardNextCheck(DASHBOARD_REFRESH_INTERVAL_MS);else renderNeppoRefreshStatus();if(manual)toast('Base conferida. Sem mudança ainda.');return false;}
  if(signature!==dashboardAssetSignature){
    const paneId=activeDashboardPaneId();
    sessionStorage.setItem('gestao-dashboard-auto-refresh',new Date().toISOString());
    const sameStructure=replaceDashboardData(data);
    dashboardAssetSignature=signature;
    dashboardPublishedAtMs=Date.now();
    dashboardLastCheckMessage='Base NEPPO atualizada agora.';
    scheduleDashboardNextCheck(DASHBOARD_REFRESH_INTERVAL_MS);
    if(!sameStructure){location.reload();return true;}
    renderCurrentDashboardPane(paneId);
    toast('Dados NEPPO atualizados automaticamente.');
    return true;
  }
  dashboardLastCheckMessage='Sem mudança na base NEPPO nesta verificação.';
  if(dashboardNextCheckAtMs<=Date.now())scheduleDashboardNextCheck(DASHBOARD_REFRESH_RETRY_MS);else renderNeppoRefreshStatus();
  if(manual)toast('Sem mudança na base NEPPO por enquanto.');
  return false;
}
async function runDashboardScheduledCheck(){
  if(document.hidden||dashboardAssetRefreshBusy)return false;
  if(!dashboardNextCheckAtMs)scheduleDashboardNextCheck(DASHBOARD_REFRESH_INTERVAL_MS);
  if(Date.now()<dashboardNextCheckAtMs)return false;
  dashboardLastCheckMessage='Consultando base NEPPO automaticamente...';
  renderNeppoRefreshStatus();
  return checkDashboardAssetUpdate({force:false});
}
function startDashboardAutoRefresh(){
  if(dashboardAutoRefreshTimer)return;
  initializeDashboardAssetSignature();
  scheduleDashboardNextCheck(DASHBOARD_REFRESH_INTERVAL_MS);
  setTimeout(()=>{if(!document.hidden&&neppoBusinessOpen())checkDashboardAssetUpdate({force:true});},15000);
  dashboardAutoRefreshTimer=setInterval(runDashboardScheduledCheck,30000);
  dashboardStatusTimer=setInterval(renderNeppoRefreshStatus,15000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){renderNeppoRefreshStatus();runDashboardScheduledCheck();}});
  window.addEventListener('focus',()=>{renderNeppoRefreshStatus();runDashboardScheduledCheck();});
  window.addEventListener('pageshow',()=>{renderNeppoRefreshStatus();});
}
'@
    $initMarker = '// ════════ INIT ════════'
    $blockStart = $Html.IndexOf('// Atualiza os números quando a rotina NEPPO publicar uma nova versão do painel.')
    if ($blockStart -lt 0) {
      $blockStart = $Html.IndexOf('// Recarrega a tela quando a rotina NEPPO publicar uma nova versão do painel.')
    }
    $initIndex = if ($blockStart -ge 0) { $Html.IndexOf($initMarker, $blockStart) } else { -1 }
    if ($blockStart -ge 0 -and $initIndex -gt $blockStart) {
      $Html = $Html.Substring(0, $blockStart) + $refreshBlock + "`r`n`r`n" + $Html.Substring($initIndex)
    } else {
      $fallbackInitIndex = $Html.IndexOf($initMarker)
      if ($fallbackInitIndex -ge 0) {
        $Html = $Html.Substring(0, $fallbackInitIndex) + $refreshBlock + "`r`n`r`n" + $Html.Substring($fallbackInitIndex)
      }
    }

    if ($Html -notmatch "function findNavTabButton\(id\)") {
      $goReplacement = @'
function findNavTabButton(id){
  return [...document.querySelectorAll('.ntab')].find(btn=>String(btn.getAttribute('onclick')||'').includes("go('" + id + "'"));
}
function go(id,el){
  if(id)sessionStorage.setItem('gestao-active-pane',id);
  if(!el)el=findNavTabButton(id);
'@
      $Html = [regex]::Replace($Html, 'function go\(id,el\)\{', $goReplacement, 1)
    }

    if ($Html -notmatch "const savedPane=sessionStorage\.getItem\('gestao-active-pane'\)") {
      $restorePane = @'
setGlobalMonth(urlMonth>=1&&urlMonth<=D.meses.length?urlMonth-1:F);
const savedPane=sessionStorage.getItem('gestao-active-pane');
if(savedPane&&$('pane-'+savedPane))go(savedPane);
'@
      $Html = $Html -replace 'setGlobalMonth\(urlMonth>=1&&urlMonth<=D\.meses\.length\?urlMonth-1:F\);', $restorePane
    }

    $Html = $Html -replace 'const DASHBOARD_REFRESH_INTERVAL_MS=5\*60\*1000;', 'const DASHBOARD_REFRESH_INTERVAL_MS=30*1000;'
    return $Html
  }

  $json = $D | ConvertTo-Json -Depth 30
  $html = Get-Content -LiteralPath $htmlPath -Raw
  $dataBlock = Get-DashboardDataBlock -Html $html
  $html = $html.Substring(0, $dataBlock.Start) + $json + $html.Substring($dataBlock.End)
  $html = Ensure-DashboardLiveRefresh -Html $html
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
