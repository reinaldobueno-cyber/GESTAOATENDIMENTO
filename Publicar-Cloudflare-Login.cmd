@echo off
setlocal
cd /d "%~dp0"
set "PATH=%LOCALAPPDATA%\CodexTools\node-v22;%PATH%"
set "CLOUDFLARE_API_TOKEN="
set "CLOUDFLARE_API_KEY="
set "CLOUDFLARE_EMAIL="
echo.
echo Publicacao via login do Cloudflare no navegador.
echo Use esta opcao quando o API Token estiver dando erro 9109.
echo.
echo 1) O Wrangler vai abrir o navegador para autorizar.
echo 2) Depois de autorizar, ele volta e publica o Worker.
echo.
npm exec --yes wrangler@latest -- login
if errorlevel 1 goto erro
echo.
npm exec --yes wrangler@latest -- whoami
if errorlevel 1 goto erro
echo.
npm exec --yes wrangler@latest -- deploy
if errorlevel 1 goto erro
echo.
echo Publicado com sucesso:
echo https://gestaoatendimento.reinaldo-bueno.workers.dev/bonificacao.html
echo.
pause
exit /b 0

:erro
echo.
echo A publicacao falhou. Veja a mensagem acima.
pause
exit /b 1
