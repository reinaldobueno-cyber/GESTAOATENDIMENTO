#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${GESTAO_ENV_FILE:-/etc/gestao-atendimento/neppo.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

REPO_DIR="${GESTAO_REPO_DIR:-/opt/gestao-atendimento}"
YEAR="${GESTAO_DASHBOARD_YEAR:-2026}"
MONTH="$(date +%-m)"
LOCK_FILE="/tmp/gestao-neppo-update.lock"

missing=()
if [[ -z "${NEPPO_TOKEN:-}" ]]; then
  for name in NEPPO_CLIENT_KEY NEPPO_CLIENT_SECRET NEPPO_USERNAME NEPPO_PASSWORD; do
    if [[ -z "${!name:-}" ]]; then
      missing+=("$name")
    fi
  done
fi
if (( ${#missing[@]} > 0 )); then
  printf 'Variaveis obrigatorias ausentes em %s: %s\n' "$ENV_FILE" "${missing[*]}" >&2
  exit 2
fi

cd "$REPO_DIR"

mkdir -p logs exports

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Outra atualizacao NEPPO ainda esta rodando. Ignorando este ciclo."
  exit 0
fi

echo "Inicio NEPPO VPS: $(date -Is)"
echo "Repositorio: $REPO_DIR"
echo "Periodo: $YEAR/1 ate $YEAR/$MONTH em modo rapido do mes atual"

pwsh ./sync-neppo-data.ps1 \
  -Year "$YEAR" \
  -StartMonth "$MONTH" \
  -EndMonth "$MONTH" \
  -ExportDir exports \
  -MergeExistingCsv \
  -DashboardOnly \
  -ExportOnly \
  -NoMirrorRoot

node tools/build-dashboard-data.js --html=index.html --exports=exports --year="$YEAR"

pwsh ./Protect-PublicDashboardData.ps1 -HtmlPath index.html

echo "Deploy Cloudflare bloqueado: NEPPO ao vivo agora atualiza pelo Worker/KV, nao pela VPS."

echo "Fim NEPPO VPS: $(date -Is)"
