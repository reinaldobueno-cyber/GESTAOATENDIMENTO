[CmdletBinding()]
param(
  [string]$HtmlPath = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrWhiteSpace($HtmlPath)) { $HtmlPath = Join-Path $scriptDir 'index.html' }

$html = Get-Content -LiteralPath $HtmlPath -Raw
$match = [regex]::Match($html, '(?s)const D = (\{.*?\n\});\r?\n\r?\nconst MANUAL_ADJUSTMENTS_STORAGE_KEY')
if (!$match.Success) { throw 'Bloco const D não encontrado no HTML.' }

$D = $match.Groups[1].Value | ConvertFrom-Json
$privateCsvPath = Join-Path $scriptDir 'cliente-map-privado.csv'

$existingByKey = @{}
$usedCodes = New-Object System.Collections.Generic.HashSet[string]
$maxCode = 0
if (Test-Path -LiteralPath $privateCsvPath) {
  foreach ($client in @(Import-Csv -LiteralPath $privateCsvPath)) {
    $key = [string]$client.ChaveCliente
    $code = [string]$client.Codigo
    if (![string]::IsNullOrWhiteSpace($key) -and ![string]::IsNullOrWhiteSpace($code)) {
      $existingByKey[$key] = $code
      [void]$usedCodes.Add($code)
      $m = [regex]::Match($code, 'Cliente #(\d+)')
      if ($m.Success) { $maxCode = [Math]::Max($maxCode, [int]$m.Groups[1].Value) }
    }
  }
}

$clientGroups = @{}
for ($i = 0; $i -lt $D.rows.Count; $i++) {
  $row = $D.rows[$i]
  if (!$row -or $row.Count -lt 25) { continue }
  $key = [string]$row[20]
  if ([string]::IsNullOrWhiteSpace($key)) {
    $key = if (![string]::IsNullOrWhiteSpace([string]$row[16])) { "SESSION:$($row[16])" } else { "ROW:$i" }
  }
  if (!$clientGroups.ContainsKey($key)) {
    $clientGroups[$key] = New-Object System.Collections.Generic.List[object]
  }
  $clientGroups[$key].Add($row)
}

$orderedClients = $clientGroups.GetEnumerator() |
  Sort-Object @{ Expression = { $_.Value.Count }; Descending = $true }, @{ Expression = { $_.Key }; Ascending = $true }

$clientMap = @{}
$idx = 1
foreach ($entry in $orderedClients) {
  $code = $existingByKey[$entry.Key]
  if ([string]::IsNullOrWhiteSpace($code)) {
    do {
      $maxCode++
      $code = ('Cliente #{0:000}' -f $maxCode)
    } while ($usedCodes.Contains($code))
  }
  [void]$usedCodes.Add($code)
  $clientMap[$entry.Key] = [pscustomobject]@{
    Code = $code
    Count = $entry.Value.Count
  }
  $idx++
}

for ($i = 0; $i -lt $D.rows.Count; $i++) {
  $row = $D.rows[$i]
  if (!$row -or $row.Count -lt 25) { continue }
  $key = [string]$row[20]
  if ([string]::IsNullOrWhiteSpace($key)) {
    $key = if (![string]::IsNullOrWhiteSpace([string]$row[16])) { "SESSION:$($row[16])" } else { "ROW:$i" }
  }
  $client = $clientMap[$key]
  if ($null -eq $client) { continue }
  $label = '{0} · {1} atendimentos' -f $client.Code, $client.Count
  $row[12] = $label
  $row[13] = ''
  $row[18] = $client.Code
  $row[19] = $label
  $row[20] = 'CLIENTE:' + $client.Code.Replace('Cliente #', 'C')
  $row[21] = ''
  $row[22] = ''
  $row[23] = ''
  $row[24] = $client.Count
}

$json = $D | ConvertTo-Json -Depth 100
$newHtml = $html.Substring(0, $match.Groups[1].Index) + $json + $html.Substring($match.Groups[1].Index + $match.Groups[1].Length)

$sensitivePatterns = @('DOC:', 'whatsapp_', 'CpfCnpjNeppo', 'UsuarioNeppo')
foreach ($pattern in $sensitivePatterns) {
  if ($newHtml.Contains($pattern)) {
    throw "Sanitização abortada: padrão sensível encontrado no HTML: $pattern"
  }
}

[System.IO.File]::WriteAllText((Resolve-Path -LiteralPath $HtmlPath), $newHtml, [System.Text.Encoding]::UTF8)
Write-Output "HTML público sanitizado: $HtmlPath"
