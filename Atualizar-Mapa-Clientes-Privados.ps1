[CmdletBinding()]
param(
  [string]$ClientMonthPath = 'exports\clientes-por-mes.csv',
  [string]$AuxContactsPath = '',
  [string]$MrrOverridesPath = 'mrr-overrides.csv',
  [string]$PrivateCsvPath = 'cliente-map-privado.csv',
  [string]$PrivateJsPath = 'cliente-map-privado.js',
  [string]$PrivateModulePath = 'src\private-client-map.js',
  [string]$ReportPath = 'exports\clientes-identificacao-relatorio.csv',
  [double]$MaxLegacyMrr = 10000
)

$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location -LiteralPath $scriptDir

function Normalize-Document([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  return ($Value -replace '\D', '')
}

function Normalize-Money([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  $v = $Value.Trim() -replace '[R$\s]', ''
  if ([string]::IsNullOrWhiteSpace($v)) { return '' }
  if ($v -match ',') {
    $v = $v -replace '\.', ''
    $v = $v -replace ',', '.'
  }
  $number = 0.0
  if ([double]::TryParse($v, [System.Globalization.NumberStyles]::Any, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
    return $number.ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture)
  }
  return ''
}

function Get-MrrDivisor([string]$PaymentForm, [string]$ExplicitDivisor = '') {
  $parsed = 0.0
  if ([double]::TryParse($ExplicitDivisor, [System.Globalization.NumberStyles]::Any, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed) -and $parsed -gt 0) {
    return $parsed
  }
  $form = ([string]$PaymentForm).Normalize([System.Text.NormalizationForm]::FormD) -replace '\p{Mn}', ''
  switch -Regex ($form.ToUpperInvariant()) {
    'ANUAL' { return 12 }
    'SEMESTRAL' { return 6 }
    'QUADRIMESTRAL' { return 4 }
    'TRIMESTRAL' { return 3 }
    'BIMESTRAL' { return 2 }
    default { return 1 }
  }
}

function Convert-ContractToMrr([string]$ContractValue, [string]$PaymentForm, [string]$ExplicitDivisor = '') {
  $normalized = Normalize-Money $ContractValue
  if ([string]::IsNullOrWhiteSpace($normalized)) { return '' }
  $number = [double]::Parse($normalized, [System.Globalization.CultureInfo]::InvariantCulture)
  $divisor = Get-MrrDivisor $PaymentForm $ExplicitDivisor
  return ($number / $divisor).ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture)
}

function Use-LegacyMrr([string]$Value, [double]$MaxValue) {
  $normalized = Normalize-Money $Value
  if ([string]::IsNullOrWhiteSpace($normalized)) { return '' }
  $number = [double]::Parse($normalized, [System.Globalization.CultureInfo]::InvariantCulture)
  if ($number -le 0 -or $number -gt $MaxValue) { return '' }
  return $normalized
}

function Is-GenericName([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $true }
  $v = $Value.Trim()
  return $v -match '^(voice_|whatsapp_|cliente\s*#|sem cliente|cliente nao informado|\.+$)' -or $v.Length -lt 3
}

function Repair-Mojibake([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '[ÃÂâ]') { return $Value }
  foreach ($encodingId in @(28591, 1252)) {
    try {
      $bytes = [System.Text.Encoding]::GetEncoding($encodingId).GetBytes($Value)
      $fixed = [System.Text.Encoding]::UTF8.GetString($bytes)
      if ($fixed -notmatch [char]0xFFFD) { return $fixed }
    } catch {}
  }
  return $Value
}

function Escape-JsString([string]$Value) {
  if ($null -eq $Value) { return '' }
  return ($Value -replace '\\', '\\' -replace "'", "\'" -replace "`r", ' ' -replace "`n", ' ')
}

$clientPath = Join-Path $scriptDir $ClientMonthPath
if (!(Test-Path -LiteralPath $clientPath)) {
  throw "Arquivo de clientes por mes nao encontrado: $clientPath"
}

$privateCsv = Join-Path $scriptDir $PrivateCsvPath
$privateJs = Join-Path $scriptDir $PrivateJsPath
$privateModule = Join-Path $scriptDir $PrivateModulePath
$report = Join-Path $scriptDir $ReportPath

$existingByKey = @{}
$existingRowByKey = @{}
$usedCodes = New-Object System.Collections.Generic.HashSet[string]
$maxCode = 0
if (Test-Path -LiteralPath $privateCsv) {
  foreach ($client in @(Import-Csv -LiteralPath $privateCsv)) {
    $key = [string]$client.ChaveCliente
    $code = [string]$client.Codigo
    if (![string]::IsNullOrWhiteSpace($key) -and ![string]::IsNullOrWhiteSpace($code)) {
      $existingByKey[$key] = $code
      $existingRowByKey[$key] = $client
      [void]$usedCodes.Add($code)
      $m = [regex]::Match($code, 'Cliente #(\d+)')
      if ($m.Success) { $maxCode = [Math]::Max($maxCode, [int]$m.Groups[1].Value) }
    }
  }
}

$auxByDoc = @{}
if (![string]::IsNullOrWhiteSpace($AuxContactsPath)) {
  $auxPath = if ([System.IO.Path]::IsPathRooted($AuxContactsPath)) { $AuxContactsPath } else { Join-Path $scriptDir $AuxContactsPath }
  if (Test-Path -LiteralPath $auxPath) {
    foreach ($contact in @(Import-Csv -LiteralPath $auxPath)) {
      $doc = Normalize-Document ([string]$contact.Documento)
      if ([string]::IsNullOrWhiteSpace($doc)) {
        $doc = Normalize-Document (([string]$contact.CPF) + ([string]$contact.CNPJ))
      }
      if (![string]::IsNullOrWhiteSpace($doc) -and !$auxByDoc.ContainsKey($doc)) {
        $auxByDoc[$doc] = $contact
      }
    }
  }
}

$mrrOverrideByDoc = @{}
$mrrOverrideByCode = @{}
if (![string]::IsNullOrWhiteSpace($MrrOverridesPath)) {
  $overridePath = if ([System.IO.Path]::IsPathRooted($MrrOverridesPath)) { $MrrOverridesPath } else { Join-Path $scriptDir $MrrOverridesPath }
  if (Test-Path -LiteralPath $overridePath) {
    foreach ($override in @(Import-Csv -LiteralPath $overridePath)) {
      $doc = Normalize-Document ([string]$override.CpfCnpj)
      $codeOverride = [string]$override.Codigo
      if (![string]::IsNullOrWhiteSpace($doc)) { $mrrOverrideByDoc[$doc] = $override }
      if (![string]::IsNullOrWhiteSpace($codeOverride)) { $mrrOverrideByCode[$codeOverride] = $override }
    }
  }
}

$clients = @(Import-Csv -LiteralPath $clientPath)
$ordered = $clients | Sort-Object -Property @{ Expression = { [int]($_.Total) }; Descending = $true }, 'ChaveCliente'
$outRows = New-Object System.Collections.Generic.List[object]
$reportRows = New-Object System.Collections.Generic.List[object]
$newCount = 0
$auxMatches = 0

foreach ($client in $ordered) {
  $key = [string]$client.ChaveCliente
  if ([string]::IsNullOrWhiteSpace($key)) { continue }

  $code = $existingByKey[$key]
  if ([string]::IsNullOrWhiteSpace($code)) {
    do {
      $maxCode++
      $code = ('Cliente #{0:000}' -f $maxCode)
    } while ($usedCodes.Contains($code))
    $newCount++
  }
  [void]$usedCodes.Add($code)

  $doc = Normalize-Document ([string]$client.CpfCnpjNeppo)
  $aux = if (![string]::IsNullOrWhiteSpace($doc) -and $auxByDoc.ContainsKey($doc)) { $auxByDoc[$doc] } else { $null }
  $existing = if ($existingRowByKey.ContainsKey($key)) { $existingRowByKey[$key] } else { $null }
  if ($null -ne $aux) { $auxMatches++ }
  $auxMonthlyFee = if ($null -ne $aux) { Normalize-Money ([string]$aux.Mensalidade) } else { '' }
  $auxContractValue = if ($null -ne $aux) { Normalize-Money ([string]$aux.ValorContrato) } else { '' }
  $legacyMonthlyFee = if ($null -ne $existing) { Use-LegacyMrr ([string]$existing.Mensalidade) $MaxLegacyMrr } else { '' }
  $monthlyFee = if (![string]::IsNullOrWhiteSpace($auxMonthlyFee)) { $auxMonthlyFee } elseif (![string]::IsNullOrWhiteSpace($legacyMonthlyFee)) { $legacyMonthlyFee } else { '' }
  $contractValue = if (![string]::IsNullOrWhiteSpace($auxContractValue)) { $auxContractValue } elseif (![string]::IsNullOrWhiteSpace($legacyMonthlyFee) -and $null -ne $existing) { Normalize-Money ([string]$existing.ValorContrato) } elseif ($null -eq $aux -and $null -ne $existing) { Normalize-Money ([string]$existing.ValorContrato) } else { '' }
  $paymentForm = if ($null -ne $aux -and ![string]::IsNullOrWhiteSpace([string]$aux.FormaPagamento)) { [string]$aux.FormaPagamento } elseif (![string]::IsNullOrWhiteSpace($legacyMonthlyFee) -and $null -ne $existing) { [string]$existing.FormaPagamento } elseif ($null -eq $aux -and $null -ne $existing) { [string]$existing.FormaPagamento } else { '' }
  $mrrDivisor = if ($null -ne $aux -and ![string]::IsNullOrWhiteSpace([string]$aux.DivisorMRR)) { [string]$aux.DivisorMRR } elseif (![string]::IsNullOrWhiteSpace($legacyMonthlyFee) -and $null -ne $existing -and ![string]::IsNullOrWhiteSpace([string]$existing.DivisorMRR)) { [string]$existing.DivisorMRR } elseif ($null -eq $aux -and $null -ne $existing -and ![string]::IsNullOrWhiteSpace([string]$existing.DivisorMRR)) { [string]$existing.DivisorMRR } else { '' }
  $mrrOverride = if (![string]::IsNullOrWhiteSpace($doc) -and $mrrOverrideByDoc.ContainsKey($doc)) { $mrrOverrideByDoc[$doc] } elseif ($mrrOverrideByCode.ContainsKey($code)) { $mrrOverrideByCode[$code] } else { $null }
  if ($null -ne $mrrOverride) {
    $contractValue = Normalize-Money ([string]$mrrOverride.ValorContrato)
    $paymentForm = [string]$mrrOverride.FormaPagamento
    $mrrDivisor = [string](Get-MrrDivisor $paymentForm ([string]$mrrOverride.DivisorMRR))
    $monthlyFee = Convert-ContractToMrr $contractValue $paymentForm $mrrDivisor
    if ([string]::IsNullOrWhiteSpace($monthlyFee)) { $monthlyFee = Normalize-Money ([string]$mrrOverride.Mensalidade) }
  }

  $baseName = Repair-Mojibake ([string]$client.ContratoExtraido)
  if (Is-GenericName $baseName) { $baseName = Repair-Mojibake ([string]$client.ClienteExemplo) }
  $auxName = if ($null -ne $aux) { Repair-Mojibake ([string]$aux.Nome) } else { '' }
  $name = if ((Is-GenericName $baseName) -and ![string]::IsNullOrWhiteSpace($auxName)) { $auxName } else { $baseName }
  if (Is-GenericName $name) { $name = $key -replace '^NOME:', '' }
  if (Is-GenericName $name) { $name = 'Cliente sem nome cadastrado no NEPPO' }
  if ($null -ne $mrrOverride -and ![string]::IsNullOrWhiteSpace([string]$mrrOverride.Cliente)) { $name = [string]$mrrOverride.Cliente }
  $name = Repair-Mojibake $name

  $source = if (![string]::IsNullOrWhiteSpace($doc)) {
    if ($null -ne $aux) { 'neppo_doc+base_auxiliar' } else { 'neppo_doc' }
  } elseif ($key -like 'NOME:*') {
    'neppo_nome_sem_documento'
  } else {
    'neppo_chave'
  }
  if ($null -ne $mrrOverride) { $source = "$source+mrr_override" }

  $row = [pscustomobject]@{
    Codigo = $code
    TotalAtendimentos = [int]$client.Total
    ChaveCliente = $key
    Cliente = $name
    Exemplo = Repair-Mojibake ([string]$client.ClienteExemplo)
    CpfCnpj = $doc
    Mensalidade = $monthlyFee
    ValorContrato = $contractValue
    FormaPagamento = $paymentForm
    DivisorMRR = $mrrDivisor
    Telefones = [string]$client.Telefones
    OrigemIdentificacao = $source
  }
  $outRows.Add($row)
  $reportRows.Add([pscustomobject]@{
    Codigo = $code
    Cliente = $name
    ChaveCliente = $key
    CpfCnpj = $doc
    Mensalidade = $monthlyFee
    ValorContrato = $row.ValorContrato
    FormaPagamento = $row.FormaPagamento
    DivisorMRR = $row.DivisorMRR
    BaseAuxiliar = if ($null -ne $aux) { 'SIM' } else { 'NAO' }
    OrigemIdentificacao = $source
    Total = [int]$client.Total
  })
}

$outRows |
  Sort-Object { [int]([regex]::Match($_.Codigo, '\d+').Value) } |
  Export-Csv -LiteralPath $privateCsv -NoTypeInformation -Encoding UTF8

$jsItems = @($outRows | Sort-Object { [int]([regex]::Match($_.Codigo, '\d+').Value) } | ForEach-Object {
  $fee = if (![string]::IsNullOrWhiteSpace([string]$_.Mensalidade)) { [string]$_.Mensalidade } else { '0' }
  $contractValue = if (![string]::IsNullOrWhiteSpace([string]$_.ValorContrato)) { [string]$_.ValorContrato } else { '0' }
  $divisor = if (![string]::IsNullOrWhiteSpace([string]$_.DivisorMRR)) { [string]$_.DivisorMRR } else { '1' }
  "  {codigo:'$(Escape-JsString $_.Codigo)',nome:'$(Escape-JsString $_.Cliente)',total:$([int]$_.TotalAtendimentos),doc:'$(Escape-JsString $_.CpfCnpj)',mensalidade:$fee,valorContrato:$contractValue,formaPagamento:'$(Escape-JsString $_.FormaPagamento)',divisorMRR:$divisor,chave:'$(Escape-JsString $_.ChaveCliente)',origem:'$(Escape-JsString $_.OrigemIdentificacao)'}"
})

$js = @"
window.CLIENTE_PRIVADO = {};
[
$($jsItems -join ",`r`n")
].forEach(function(c){
  var item = { codigo: c.codigo, nome: c.nome, total: c.total, doc: c.doc, mensalidade: c.mensalidade || 0, valorContrato: c.valorContrato || 0, formaPagamento: c.formaPagamento || '', divisorMRR: c.divisorMRR || 1, chave: c.chave, origem: c.origem };
  window.CLIENTE_PRIVADO[c.codigo] = item;
  if (c.doc && c.chave === 'DOC:' + c.doc) window.CLIENTE_PRIVADO['DOC:' + c.doc] = item;
  if (c.chave) window.CLIENTE_PRIVADO[c.chave] = item;
});
"@
[System.IO.File]::WriteAllText($privateJs, $js, [System.Text.Encoding]::UTF8)
$moduleDir = Split-Path -Parent $privateModule
if (!(Test-Path -LiteralPath $moduleDir)) { New-Item -ItemType Directory -Path $moduleDir | Out-Null }
$moduleMap = [ordered]@{}
foreach ($row in $outRows) {
  $item = [ordered]@{
    codigo = [string]$row.Codigo
    nome = [string]$row.Cliente
    total = [int]$row.TotalAtendimentos
    doc = [string]$row.CpfCnpj
    mensalidade = if (![string]::IsNullOrWhiteSpace([string]$row.Mensalidade)) { [double]$row.Mensalidade } else { 0 }
    valorContrato = if (![string]::IsNullOrWhiteSpace([string]$row.ValorContrato)) { [double]$row.ValorContrato } else { 0 }
    formaPagamento = [string]$row.FormaPagamento
    divisorMRR = if (![string]::IsNullOrWhiteSpace([string]$row.DivisorMRR)) { [double]$row.DivisorMRR } else { 1 }
    chave = [string]$row.ChaveCliente
    origem = [string]$row.OrigemIdentificacao
  }
  $moduleMap[[string]$row.Codigo] = $item
  if (![string]::IsNullOrWhiteSpace([string]$row.CpfCnpj) -and [string]$row.ChaveCliente -eq "DOC:$($row.CpfCnpj)") {
    $moduleMap["DOC:$($row.CpfCnpj)"] = $item
  }
  if (![string]::IsNullOrWhiteSpace([string]$row.ChaveCliente)) { $moduleMap[[string]$row.ChaveCliente] = $item }
}
$module = "export const PRIVATE_CLIENT_MAP = " + ($moduleMap | ConvertTo-Json -Depth 10 -Compress) + ";`r`n"
[System.IO.File]::WriteAllText($privateModule, $module, [System.Text.Encoding]::UTF8)

$reportRows | Export-Csv -LiteralPath $report -NoTypeInformation -Encoding UTF8
Write-Output "Mapa privado atualizado: $($outRows.Count) clientes; novos=$newCount; base_auxiliar_doc=$auxMatches"
Write-Output "Relatorio: $report"
