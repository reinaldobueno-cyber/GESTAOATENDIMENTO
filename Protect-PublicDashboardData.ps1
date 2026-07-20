[CmdletBinding()]
param(
  [string]$HtmlPath = ''
)

$ErrorActionPreference = 'Stop'
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
if ([string]::IsNullOrWhiteSpace($HtmlPath)) { $HtmlPath = Join-Path $scriptDir 'index.html' }

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

$html = Get-Content -LiteralPath $HtmlPath -Raw
$dataBlock = Get-DashboardDataBlock -Html $html
$D = $dataBlock.Json | ConvertFrom-Json
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
$newHtml = $html.Substring(0, $dataBlock.Start) + $json + $html.Substring($dataBlock.End)

$sensitivePatterns = @('DOC:', 'whatsapp_', 'CpfCnpjNeppo', 'UsuarioNeppo')
foreach ($pattern in $sensitivePatterns) {
  if ($json.Contains($pattern)) {
    throw "Sanitização abortada: padrão sensível encontrado no bloco de dados: $pattern"
  }
}

[System.IO.File]::WriteAllText((Resolve-Path -LiteralPath $HtmlPath), $newHtml, [System.Text.Encoding]::UTF8)
Write-Output "HTML público sanitizado: $HtmlPath"
