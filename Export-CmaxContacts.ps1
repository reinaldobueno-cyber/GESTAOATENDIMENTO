[CmdletBinding()]
param(
  [string]$Url = 'https://www.multbovinos.com/servicos/contato/?page=1&format=json',
  [string]$OutputPath = 'exports\cmax-contatos.csv',
  [string]$RawOutputPath = 'exports\cmax-contatos-raw.txt',
  [int]$MaxPages = 0
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

function Find-RecordArray($Value, [int]$Depth = 0) {
  if ($null -eq $Value -or $Depth -gt 8) { return @() }
  if ($Value -is [array]) {
    $objects = @($Value | Where-Object { $_ -is [psobject] })
    if ($objects.Count -gt 0) { return $objects }
    return @()
  }
  foreach ($key in @('results', 'data', 'items', 'content', 'objects', 'rows', 'list')) {
    if ($Value.PSObject.Properties.Name -contains $key) {
      $found = @(Find-RecordArray $Value.$key ($Depth + 1))
      if ($found.Count -gt 0) { return $found }
    }
  }
  foreach ($prop in $Value.PSObject.Properties) {
    $found = @(Find-RecordArray $prop.Value ($Depth + 1))
    if ($found.Count -gt 0) { return $found }
  }
  return @()
}

function First-Property($Object, [string[]]$Names) {
  if ($null -eq $Object) { return '' }
  $props = @($Object.PSObject.Properties)
  foreach ($name in $Names) {
    $prop = $props | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
    if ($prop) { return [string]$prop.Value }
  }
  foreach ($name in $Names) {
    $prop = $props | Where-Object { $_.Name -match $name } | Select-Object -First 1
    if ($prop) { return [string]$prop.Value }
  }
  return ''
}

function Flatten-CmaxRecord($Record) {
  $cpf = First-Property $Record @('cpf', 'documentoCpf', 'cpfContato')
  $cnpj = First-Property $Record @('cnpj', 'documentoCnpj', 'cnpjContato')
  $doc = Normalize-Document (($cpf) + ($cnpj))
  $contrato = ''
  if ($Record.PSObject.Properties.Name -contains 'contrato_obj' -and $Record.contrato_obj) {
    $contrato = First-Property $Record.contrato_obj @('numero', 'contrato', 'id')
  }
  [pscustomobject]@{
    Id = First-Property $Record @('id', 'uid')
    Chave = First-Property $Record @('chave_mbdt', 'uid', 'codigo_erp')
    Nome = First-Property $Record @('nome', 'name', 'razaoSocial', 'descricao')
    RazaoSocial = First-Property $Record @('razao_social', 'razaoSocial')
    CPF = $cpf
    CNPJ = $cnpj
    Documento = $doc
    Categoria = First-Property $Record @('categoria_texto', 'categoria.nome', 'categoria', 'category')
    Tipo = First-Property $Record @('tipo_texto', 'tipo.nome', 'tipo', 'tipoContato')
    Situacao = First-Property $Record @('situacao_contato_texto', 'situacao', 'situacaoContato', 'status')
    Ativo = First-Property $Record @('ativo', 'active')
    Mensalidade = Normalize-Money (First-Property $Record @('mensalidade', 'valor_mensal', 'manutencao', 'mensalidade_texto'))
    Municipio = First-Property $Record @('municipio', 'cidade', 'city')
    Estado = First-Property $Record @('estado', 'uf', 'state')
    Contrato = $contrato
    Programas = First-Property $Record @('programas_texto', 'programas')
    OrigemInformacao = First-Property $Record @('origem_informacao')
    Origem = 'CMAX'
  }
}

$token = Read-CmaxToken
$out = if ([System.IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } else { Join-Path $scriptDir $OutputPath }
$rawOut = if ([System.IO.Path]::IsPathRooted($RawOutputPath)) { $RawOutputPath } else { Join-Path $scriptDir $RawOutputPath }
$outDir = Split-Path -Parent $out
if (!(Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$headers = @{
  Accept = 'application/json, text/plain, */*'
  Authorization = "JWT $token"
  'Django-Timezone' = 'America/Sao_Paulo'
  Referer = 'https://www.multbovinos.com/'
  'Cache-Control' = 'no-cache'
  Pragma = 'no-cache'
}

$all = New-Object System.Collections.Generic.List[object]
$nextUrl = $Url
$page = 0
$total = $null

while (![string]::IsNullOrWhiteSpace($nextUrl)) {
  if ($MaxPages -gt 0 -and $page -ge $MaxPages) { break }
  $page++

  $response = Invoke-WebRequest -UseBasicParsing -Uri $nextUrl -Headers $headers -Method Get
  $content = [string]$response.Content
  if ($page -eq 1) {
    [System.IO.File]::WriteAllText($rawOut, $content, [System.Text.Encoding]::UTF8)
  }

  $json = $null
  try { $json = $content | ConvertFrom-Json } catch {}

  if ($null -eq $json) {
    Write-Warning "CMAX respondeu em formato não JSON. Salvei o bruto em: $rawOut"
    Write-Warning 'Abra esse arquivo e procure se existe outro endpoint AJAX/JSON na tela.'
    return
  }

  if ($null -eq $total -and ($json.PSObject.Properties.Name -contains 'count')) {
    $total = [int]$json.count
    Write-Output "CMAX total informado: $total contato(s)"
  }

  $records = @(Find-RecordArray $json)
  if ($records.Count -eq 0) {
    Write-Warning "Não encontrei lista de registros no JSON. Salvei o bruto em: $rawOut"
    return
  }

  foreach ($record in $records) {
    $all.Add((Flatten-CmaxRecord $record)) | Out-Null
  }

  if ($page -eq 1 -or $page % 25 -eq 0) {
    Write-Output "CMAX página $page importada: $($all.Count) registro(s)"
  }

  $nextUrl = ''
  if ($json.PSObject.Properties.Name -contains 'links' -and $json.links -and $json.links.next) {
    $nextUrl = [string]$json.links.next
  }
}

$flat = $all.ToArray()
$flat | Export-Csv -LiteralPath $out -NoTypeInformation -Encoding UTF8
Write-Output "CMAX contatos exportados: $($flat.Count)"
Write-Output "CSV: $out"
Write-Output "Bruto: $rawOut"
