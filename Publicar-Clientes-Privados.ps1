[CmdletBinding()]
param(
  [string]$PrivateMapPath = 'cliente-map-privado.js',
  [string]$OutputPath = 'private-client-map.enc.json',
  [int]$Iterations = 150000,
  [switch]$SkipPush
)

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
Set-Location -LiteralPath $scriptDir

function Find-Git {
  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $candidates = @(
    "$env:LOCALAPPDATA\GitHubDesktop\app-3.5.8\resources\app\git\cmd\git.exe",
    "$env:ProgramFiles\Git\cmd\git.exe",
    "${env:ProgramFiles(x86)}\Git\cmd\git.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }

  throw 'Git não encontrado. Instale o Git ou abra pelo GitHub Desktop.'
}

function Join-Bytes([byte[]]$A, [byte[]]$B, [byte[]]$C) {
  $output = New-Object byte[] ($A.Length + $B.Length + $C.Length)
  [Array]::Copy($A, 0, $output, 0, $A.Length)
  [Array]::Copy($B, 0, $output, $A.Length, $B.Length)
  [Array]::Copy($C, 0, $output, $A.Length + $B.Length, $C.Length)
  return $output
}

$sourcePath = Join-Path $scriptDir $PrivateMapPath
if (!(Test-Path -LiteralPath $sourcePath)) {
  throw "Arquivo privado não encontrado: $sourcePath"
}

Write-Host ''
Write-Host 'Digite a mesma senha configurada em PRIVATE_MAP_PASSWORD na Cloudflare.'
Write-Host 'Ela será usada só para criptografar o mapa privado localmente.'
Write-Host 'Importante: essa senha deve ser fixa e não precisa ser a senha de login dos usuários.'
$securePassword = Read-Host 'PRIVATE_MAP_PASSWORD' -AsSecureString
if ($securePassword.Length -eq 0) { throw 'Senha vazia. Operação cancelada.' }
$password = [System.Net.NetworkCredential]::new('', $securePassword).Password

$plain = [System.IO.File]::ReadAllBytes($sourcePath)
$salt = New-Object byte[] 16
$iv = New-Object byte[] 16
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($salt)
$rng.GetBytes($iv)

$derive = New-Object System.Security.Cryptography.Rfc2898DeriveBytes($password, $salt, $Iterations)
$keyMaterial = $derive.GetBytes(64)
$aesKey = New-Object byte[] 32
$macKey = New-Object byte[] 32
[Array]::Copy($keyMaterial, 0, $aesKey, 0, 32)
[Array]::Copy($keyMaterial, 32, $macKey, 0, 32)

$aes = [System.Security.Cryptography.Aes]::Create()
$aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
$aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
$aes.Key = $aesKey
$aes.IV = $iv
$encryptor = $aes.CreateEncryptor()
$cipher = $encryptor.TransformFinalBlock($plain, 0, $plain.Length)

$hmac = New-Object System.Security.Cryptography.HMACSHA256 (, $macKey)
$mac = $hmac.ComputeHash((Join-Bytes $salt $iv $cipher))

$package = [pscustomobject]@{
  v = 1
  alg = 'AES-256-CBC-HMAC-SHA256'
  kdf = 'PBKDF2-SHA1'
  iterations = $Iterations
  salt = [Convert]::ToBase64String($salt)
  iv = [Convert]::ToBase64String($iv)
  mac = [Convert]::ToBase64String($mac)
  data = [Convert]::ToBase64String($cipher)
}

$out = Join-Path $scriptDir $OutputPath
$json = $package | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($out, $json, [System.Text.Encoding]::UTF8)

$git = Find-Git
& $git add $OutputPath
& $git commit -m 'Publica mapa privado de clientes criptografado'

if (!$SkipPush) {
  & $git push
}

Write-Host ''
Write-Host 'Mapa privado criptografado publicado. A Cloudflare vai atualizar em instantes.'
