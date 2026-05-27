@echo off
cd /d "%~dp0"
echo.
echo Publicacao direta no Cloudflare Worker.
echo Cole um CLOUDFLARE_API_TOKEN com permissao de editar Workers.
echo O token nao sera salvo no Git.
echo.
set /p CLOUDFLARE_API_TOKEN=Token Cloudflare: 
echo.
set "PATH=%LOCALAPPDATA%\CodexTools\node-v22;%PATH%"
npm exec --yes wrangler@latest -- deploy
echo.
pause
