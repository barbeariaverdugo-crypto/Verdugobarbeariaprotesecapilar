#!/usr/bin/env bash
# Sobe o app num banco NOVO (com a planilha importada), roda o teste de interface e desliga.
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
export DB_FILE="$TMP/verdugo.db" PORT="${PORT:-3199}"
VERDUGO_EMAIL=dono@verdugo.test VERDUGO_SENHA=SenhaForte2026 npm run -s definir-senha >/dev/null
npm run -s importar-planilha -- dados/planilha_extraida.json "$DB_FILE" >/dev/null
node --disable-warning=ExperimentalWarning server/index.js > "$TMP/server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "$TMP"' EXIT
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/saude" >/dev/null && break; sleep 0.3; done
BASE="http://127.0.0.1:$PORT" python3 tests/ui_teste.py
