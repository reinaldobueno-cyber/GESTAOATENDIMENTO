@echo off
cd /d "%~dp0"
echo.
echo Este comando republica o mapa privado dos clientes.
echo Use exatamente a mesma senha cadastrada no Cloudflare como PRIVATE_MAP_PASSWORD.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Publicar-Clientes-Privados.ps1"
pause
