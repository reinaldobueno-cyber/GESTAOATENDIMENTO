# NEPPO em VPS

Este pacote tira a atualizacao do dashboard NEPPO do computador local e coloca a rotina em uma VPS Ubuntu.

Objetivo:

- Rodar a coleta NEPPO em segundo plano, sem abrir janela no Windows.
- Coletar dados NEPPO localmente para auditoria sem publicar HTML no Cloudflare.
- Manter logs no servidor para auditoria.
- Evitar execucoes sobrepostas com `flock`.
- Parar execucoes travadas com limite de tempo do `systemd`.

## O que roda na VPS

O timer `gestao-neppo-update.timer` chama o servico `gestao-neppo-update.service`.

O servico executa:

```bash
/opt/gestao-atendimento/deploy/neppo-vps/run-neppo-update.sh
```

Esse script chama a rotina de exportacao do mes atual, mas nao publica direto no Cloudflare:

```bash
pwsh ./sync-neppo-data.ps1 \
  -Year 2026 \
  -StartMonth MES_ATUAL \
  -EndMonth MES_ATUAL \
  -ExportDir exports \
  -MergeExistingCsv \
  -DashboardOnly \
  -ExportOnly \
  -NoMirrorRoot
```

O caminho operacional da atualizacao ao vivo e o Worker/KV. A VPS nao deve ter token Cloudflare nem executar `wrangler deploy`.
As avaliacoes do NEPPO tambem sao coletadas nessa rotina; nao use `-SkipReviews` se a rotina for usada para auditoria.

## Segredos necessarios

Crie o arquivo:

```bash
sudo nano /etc/gestao-atendimento/neppo.env
```

Use `neppo.env.example` como modelo.

Obrigatorios:

- `NEPPO_CLIENT_KEY`
- `NEPPO_CLIENT_SECRET`
- `NEPPO_USERNAME`
- `NEPPO_PASSWORD`
Opcional:

- `NEPPO_TOKEN`

Preferencia: usar usuario/senha e client key/secret. Assim a rotina renova token sozinha quando o token expira.

No Windows, voce tambem pode preencher e enviar os segredos sem colar no chat:

```powershell
.\deploy\neppo-vps\Set-NeppoVpsSecretsFromWindows.ps1
```

O script pede os valores e envia para `/etc/gestao-atendimento/neppo.env` com permissao restrita.

## Instalacao rapida

Na VPS, depois de copiar o repositorio para `/opt/gestao-atendimento`:

```bash
cd /opt/gestao-atendimento
chmod +x deploy/neppo-vps/install-ubuntu.sh
sudo deploy/neppo-vps/install-ubuntu.sh
```

Depois edite o arquivo de ambiente:

```bash
sudo nano /etc/gestao-atendimento/neppo.env
```

Teste uma execucao manual:

```bash
sudo systemctl start gestao-neppo-update.service
sudo journalctl -u gestao-neppo-update.service -n 120 --no-pager
```

Se publicar corretamente, habilite:

```bash
sudo systemctl enable --now gestao-neppo-update.timer
systemctl list-timers gestao-neppo-update.timer
```

## Operacao

Ver ultima execucao:

```bash
systemctl status gestao-neppo-update.service
```

Ver agenda:

```bash
systemctl list-timers gestao-neppo-update.timer
```

Ver logs:

```bash
journalctl -u gestao-neppo-update.service -f
```

Rodar agora:

```bash
sudo systemctl start gestao-neppo-update.service
```

Pausar:

```bash
sudo systemctl disable --now gestao-neppo-update.timer
```

## Frequencia

O timer legado nao deve ficar habilitado no ambiente de producao. A atualizacao oficial roda pelo Worker/KV.
