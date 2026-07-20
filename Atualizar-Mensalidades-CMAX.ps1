[CmdletBinding()]
param(
  [string]$ClientMapPath = 'cliente-map-privado.csv',
  [string]$OutputPath = 'exports\cmax-mensalidades-clientes.csv',
  [int]$MaxClients = 0
)

$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location -LiteralPath $scriptDir

function Read-CmaxToken {
  if (![string]::IsNullOrWhiteSpace($env:CMAX_JWT_TOKEN)) { return $env:CMAX_JWT_TOKEN }
  $tokenPath = Join-Path $scriptDir 'secrets\cmax-jwt.clixml'
  if (!(Test-Path -LiteralPath $tokenPath)) {
    throw 'Token CMAX não encontrado. Rode Salvar-Credenciais-CMAX.cmd primeiro.'
  }
  $secure = Import-Clixml -LiteralPath $tokenPath
  return [System.Net.NetworkCredential]::new('', $secure).Password
}

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

function First-Property($Object, [string[]]$Names) {
  if ($null -eq $Object) { return $null }
  foreach ($name in $Names) {
    if ($Object.PSObject.Properties.Name -contains $name) {
      $value = $Object.$name
      if ($null -ne $value -and ![string]::IsNullOrWhiteSpace([string]$value)) { return $value }
    }
  }
  return $null
}

function Normalize-PaymentForm($Value) {
  if ($null -eq $Value) { return '' }
  $raw = ([string]$Value).Trim()
  if ([string]::IsNullOrWhiteSpace($raw)) { return '' }
  $norm = $raw.Normalize([System.Text.NormalizationForm]::FormD) -replace '\p{Mn}', ''
  $norm = $norm.ToUpperInvariant()
  switch -Regex ($norm) {
    '^1$|MENSAL' { return 'MENSAL' }
    '^2$|ANUAL' { return 'ANUAL' }
    '^3$|TRIMESTRAL' { return 'TRIMESTRAL' }
    '^4$|SEMESTRAL' { return 'SEMESTRAL' }
    default { return $raw.ToUpperInvariant() }
  }
}

function Get-MrrDivisor([string]$PaymentForm) {
  switch ($PaymentForm) {
    'ANUAL' { return 12 }
    'SEMESTRAL' { return 6 }
    'QUADRIMESTRAL' { return 4 }
    'TRIMESTRAL' { return 3 }
    'BIMESTRAL' { return 2 }
    default { return 1 }
  }
}

function Convert-ToMonthlyValue([string]$Value, [string]$PaymentForm) {
  $normalized = Normalize-Money $Value
  if ([string]::IsNullOrWhiteSpace($normalized)) { return '' }
  $number = [double]::Parse($normalized, [System.Globalization.CultureInfo]::InvariantCulture)
  $divisor = Get-MrrDivisor $PaymentForm
  return ($number / $divisor).ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture)
}

function Get-ContractPaymentForm($Contract) {
  return Normalize-PaymentForm (First-Property $Contract @('forma_pagamento_texto', 'forma_pagamento', 'forma_de_pagamento_texto', 'forma_de_pagamento', 'periodicidade', 'periodicidade_texto'))
}

function Get-ContractValue($Contract) {
  return Normalize-Money ([string](First-Property $Contract @('valor_atual', 'valor_total', 'valor', 'valor_mes', 'ticket_medio')))
}

function Sum-ContractsMonthlyValue($Contracts) {
  $totalMonthly = 0.0
  $totalContract = 0.0
  $forms = New-Object System.Collections.Generic.List[string]
  $count = 0
  foreach ($contract in @($Contracts)) {
    if ($null -eq $contract) { continue }
    $form = Get-ContractPaymentForm $contract
    if ([string]::IsNullOrWhiteSpace($form)) { $form = 'MENSAL' }
    $value = Get-ContractValue $contract
    if ([string]::IsNullOrWhiteSpace($value)) { continue }
    $number = [double]::Parse($value, [System.Globalization.CultureInfo]::InvariantCulture)
    $divisor = Get-MrrDivisor $form
    $totalContract += $number
    $totalMonthly += ($number / $divisor)
    [void]$forms.Add($form)
    $count++
  }
  if ($count -eq 0) { return $null }
  $distinctForms = @($forms.ToArray() | Select-Object -Unique)
  [pscustomobject]@{
    MonthlyValue = $totalMonthly.ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture)
    ContractValue = $totalContract.ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture)
    PaymentForm = if ($distinctForms.Count -eq 1) { [string]$distinctForms[0] } else { ($distinctForms -join '+') }
    Divisor = if ($distinctForms.Count -eq 1) { Get-MrrDivisor ([string]$distinctForms[0]) } else { 1 }
    Count = $count
  }
}

function Invoke-CmaxJson([string]$Uri, [hashtable]$Headers, [string]$Method = 'GET', [string]$Body = '') {
  $params = @{
    UseBasicParsing = $true
    Uri = $Uri
    Headers = $Headers
    Method = $Method
    TimeoutSec = 35
  }
  if ($Body -ne '') { $params.Body = $Body }
  $response = Invoke-WebRequest @params
  return ([string]$response.Content | ConvertFrom-Json)
}

function Find-CmaxContactByName([string]$Name, [string]$Document, [hashtable]$Headers) {
  if ([string]::IsNullOrWhiteSpace($Name)) { return $null }
  $terms = @($Name)
  $clean = $Name -replace '\s+-\s+CNPJ:.*$', '' -replace '\s+-\s+CPF:.*$', ''
  if ($clean -and $clean -ne $Name) { $terms += $clean }
  $firstWords = (($clean -split '\s+') | Select-Object -First 3) -join ' '
  if ($firstWords -and $firstWords.Length -ge 4) { $terms += $firstWords }
  foreach ($term in ($terms | Select-Object -Unique)) {
    $url = "https://www.multbovinos.com/servicos/contato/?page=1&format=json&nome=$([uri]::EscapeDataString($term))"
    $json = Invoke-CmaxJson -Uri $url -Headers $Headers
    $results = @($json.results)
    if (!$results.Count) { continue }
    if (![string]::IsNullOrWhiteSpace($Document)) {
      $match = @($results | Where-Object {
        $candidateDoc = Normalize-Document (([string]$_.cpf) + ([string]$_.cnpj) + ([string]$_.nome))
        $candidateDoc -like "*$Document*"
      } | Select-Object -First 1)
      if ($match) { return $match }
    }
    return ($results | Select-Object -First 1)
  }
  return $null
}

$mapPath = if ([System.IO.Path]::IsPathRooted($ClientMapPath)) { $ClientMapPath } else { Join-Path $scriptDir $ClientMapPath }
if (!(Test-Path -LiteralPath $mapPath)) { throw "Mapa privado não encontrado: $mapPath" }

$out = if ([System.IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } else { Join-Path $scriptDir $OutputPath }
$outDir = Split-Path -Parent $out
if (!(Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$token = Read-CmaxToken
$headers = @{
  Accept = 'application/json, text/plain, */*'
  Authorization = "JWT $token"
  'Django-Timezone' = 'America/Sao_Paulo'
  Referer = 'https://www.multbovinos.com/'
  'Cache-Control' = 'no-cache'
  Pragma = 'no-cache'
}
$jsonHeaders = $headers.Clone()
$jsonHeaders['Content-Type'] = 'application/json'

$rows = @(Import-Csv -LiteralPath $mapPath | Where-Object { Normalize-Document $_.CpfCnpj })
if ($MaxClients -gt 0) { $rows = @($rows | Select-Object -First $MaxClients) }

$result = New-Object System.Collections.Generic.List[object]
$i = 0
foreach ($row in $rows) {
  $i++
  $doc = Normalize-Document $row.CpfCnpj
  $paramName = if ($doc.Length -eq 11) { 'cpf' } elseif ($doc.Length -eq 14) { 'cnpj' } else { '' }
  if (!$paramName) { continue }

  $contactId = ''
  $monthlyValue = ''
  $contractValue = ''
  $paymentForm = ''
  $mrrDivisor = 1
  $renewalDate = ''
  $status = 'nao_encontrado'

  try {
    $contactUrl = "https://www.multbovinos.com/servicos/contato/?page=1&format=json&$paramName=$doc"
    $contactJson = Invoke-CmaxJson -Uri $contactUrl -Headers $headers
    $contact = @($contactJson.results | Where-Object { (Normalize-Document (($_.cpf) + ($_.cnpj))) -eq $doc } | Select-Object -First 1)
    if (!$contact) { $contact = @($contactJson.results | Select-Object -First 1) }
    if (!$contact) { $contact = Find-CmaxContactByName -Name ([string]$row.Cliente) -Document $doc -Headers $headers }

    if ($contact) {
      $contactId = [string]$contact.id
      $maintenanceJson = Invoke-CmaxJson -Uri 'https://www.multbovinos.com/servicos/gestaocontratos/obter-dados-ultimo-contrato-manutencao/?format=json' -Headers $jsonHeaders -Method POST -Body $contactId
      $maintenance = $maintenanceJson.dados
      $paymentForm = Normalize-PaymentForm (First-Property $maintenance @('forma_pagamento_texto', 'forma_pagamento', 'forma_de_pagamento_texto', 'forma_de_pagamento', 'periodicidade', 'periodicidade_texto'))
      $contractValue = Normalize-Money ([string](First-Property $maintenance @('valor_atual', 'valor_total', 'valor', 'valor_mes', 'ticket_medio')))
      $renewalDate = [string](First-Property $maintenance @('data_renovacao', 'data_reajuste'))

      $contractUrl = "https://www.multbovinos.com/servicos/gestaocontratos/?page=1&format=json&contato=$contactId&tipo_aba=ficha_contato_ativos&ativo=true"
      $contractJson = Invoke-CmaxJson -Uri $contractUrl -Headers $headers
      $contracts = @($contractJson.results)
      $contractSum = Sum-ContractsMonthlyValue $contracts
      if ($contractSum) {
        $monthlyValue = $contractSum.MonthlyValue
        $contractValue = $contractSum.ContractValue
        $paymentForm = $contractSum.PaymentForm
        $mrrDivisor = $contractSum.Divisor
        if ([string]::IsNullOrWhiteSpace($renewalDate)) {
          $renewalDate = [string](First-Property ($contracts | Select-Object -First 1) @('data_renovacao', 'data_reajuste'))
        }
      } elseif ([string]::IsNullOrWhiteSpace($paymentForm) -or [string]::IsNullOrWhiteSpace($contractValue)) {
        $contract = @($contracts | Select-Object -First 1)
        if ($contract) {
          if ([string]::IsNullOrWhiteSpace($paymentForm)) { $paymentForm = Get-ContractPaymentForm $contract }
          if ([string]::IsNullOrWhiteSpace($contractValue)) { $contractValue = Get-ContractValue $contract }
          if ([string]::IsNullOrWhiteSpace($renewalDate)) { $renewalDate = [string](First-Property $contract @('data_renovacao', 'data_reajuste')) }
        }
      }

      if ([string]::IsNullOrWhiteSpace($monthlyValue)) {
        if ([string]::IsNullOrWhiteSpace($paymentForm)) { $paymentForm = 'MENSAL' }
        $mrrDivisor = Get-MrrDivisor $paymentForm
        $monthlyValue = Convert-ToMonthlyValue $contractValue $paymentForm
      }
      $status = if ($monthlyValue) { 'ok' } else { 'sem_valor' }
    }
  } catch {
    $status = 'erro'
  }

  $result.Add([pscustomobject]@{
    Nome = [string]$row.Cliente
    CPF = if ($doc.Length -eq 11) { $doc } else { '' }
    CNPJ = if ($doc.Length -eq 14) { $doc } else { '' }
    Documento = $doc
    Mensalidade = $monthlyValue
    ValorContrato = $contractValue
    FormaPagamento = $paymentForm
    DivisorMRR = $mrrDivisor
    DataRenovacao = $renewalDate
    CmaxContatoId = $contactId
    Codigo = [string]$row.Codigo
    Status = $status
  }) | Out-Null

  if ($i -eq 1 -or $i % 25 -eq 0) {
    Write-Output "CMAX mensalidades: $i/$($rows.Count) processado(s); ok=$(@($result | Where-Object Status -eq 'ok').Count)"
  }
}

$result.ToArray() | Export-Csv -LiteralPath $out -NoTypeInformation -Encoding UTF8
Write-Output "Mensalidades CMAX exportadas: $($result.Count)"
Write-Output "Com valor: $(@($result | Where-Object Status -eq 'ok').Count)"
Write-Output "CSV: $out"
