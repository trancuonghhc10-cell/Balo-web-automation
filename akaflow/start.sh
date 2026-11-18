#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
mkdir -p data
chmod 700 data

for command in python3 node npm curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Thiếu chương trình bắt buộc: $command"
    exit 1
  fi
done

if [[ ! -x .venv/bin/python ]]; then
  echo "Đang tạo môi trường Python cục bộ..."
  python3 -m venv .venv
fi

if ! ./.venv/bin/python -c 'import fastapi, uvicorn, httpx, multipart, opentelemetry' >/dev/null 2>&1; then
  echo "Đang cài thư viện Python..."
  ./.venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt
fi

if [[ ! -d vendor/zca-js/node_modules/tough-cookie ]]; then
  echo "Đang cài thư viện zca-js..."
  npm install --omit=dev --ignore-scripts --prefix vendor/zca-js
fi

APP_HOST="${AKAFLOW_HOST:-127.0.0.1}"
APP_PORT="${AKAFLOW_PORT:-8010}"

if [[ "$APP_HOST" != "127.0.0.1" && "$APP_HOST" != "localhost" && "$APP_HOST" != "::1" ]]; then
  echo "AkaFlow không có đăng nhập và chỉ được phép chạy trên loopback."
  echo "Hãy dùng AKAFLOW_HOST=127.0.0.1."
  exit 1
fi

CONNECTOR_PID=""
if ! curl --silent --fail --max-time 2 http://127.0.0.1:8001/api/health >/dev/null 2>&1; then
  node ./zalo_service.mjs >data/zalo-connector.log 2>&1 &
  CONNECTOR_PID="$!"
  cleanup() {
    if [[ -n "$CONNECTOR_PID" ]]; then
      kill "$CONNECTOR_PID" 2>/dev/null || true
    fi
  }
  trap cleanup EXIT INT TERM

  for _ in {1..20}; do
    if curl --silent --fail --max-time 1 http://127.0.0.1:8001/api/health >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
fi

./.venv/bin/python -m uvicorn app:app --host "$APP_HOST" --port "$APP_PORT"
