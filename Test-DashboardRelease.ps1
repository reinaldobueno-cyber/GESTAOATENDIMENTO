[CmdletBinding()]
param(
  [string]$HtmlPath = (Join-Path $PSScriptRoot 'index.html')
)

$ErrorActionPreference = 'Stop'

if (!(Test-Path -LiteralPath $HtmlPath)) {
  throw "HTML nao encontrado para validar: $HtmlPath"
}

$html = Get-Content -LiteralPath $HtmlPath -Raw
$checks = @(
  @{ Ok = $html.Contains('<div class="logo-gem" aria-label="Multsoft">M</div>'); Message = 'logo atual M nao encontrada' },
  @{ Ok = $html.Contains('Última base'); Message = 'texto atual da base NEPPO nao encontrado' },
  @{ Ok = $html.Contains('neppoLiveHealthLastCheckMs'); Message = 'timer rapido da saude NEPPO nao encontrado' },
  @{ Ok = $html.Contains('/api/neppo-live/dashboard'); Message = 'atualizacao NEPPO via Worker/KV nao encontrada' },
  @{ Ok = $html.Contains('.wg-group-summary{display:grid;gap:.45rem;max-height:none;overflow:visible;padding-right:0;}'); Message = 'layout atual do resumo por grupo nao encontrado' },
  @{ Ok = -not $html.Contains('🌿'); Message = 'logo antiga com folha ainda esta no HTML' },
  @{ Ok = -not $html.Contains('Última publicação'); Message = 'texto antigo de publicacao ainda esta no HTML' }
)

$failed = @($checks | Where-Object { -not $_.Ok } | ForEach-Object { $_.Message })
if ($failed.Count -gt 0) {
  throw "Publicacao bloqueada: HTML antigo ou incompleto detectado em $HtmlPath. Falhas: $($failed -join '; ')"
}

Write-Host "HTML validado para publicacao: $HtmlPath"
