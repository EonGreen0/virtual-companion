#!/usr/bin/env bash
# Virtual Companion 一键启动（Linux / macOS）
# 用法：bash gateway/start.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_DIR="$SCRIPT_DIR"
LOBE_DIR="$(cd "$SCRIPT_DIR/../lobehub" && pwd)"

echo "[1/5] Checking Ollama..."
if ! curl -sf http://localhost:11434/api/version >/dev/null 2>&1; then
  echo "Starting Ollama..."
  nohup ollama serve >/dev/null 2>&1 &
  sleep 5
else
  echo "Ollama already running."
fi

echo "[2/5] Checking Docker..."
if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  echo "Docker is not running. Please start it first (e.g. systemctl start docker)."
  exit 1
fi

echo "[3/5] Starting LobeHub containers..."
cd "$LOBE_DIR"
docker compose up -d

echo "[4/5] Starting memory gateway..."
if ! curl -sf http://localhost:8080/api/memories >/dev/null 2>&1; then
  cd "$GATEWAY_DIR"
  if [ ! -d .venv ]; then
    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
  fi
  nohup .venv/bin/python main.py >/dev/null 2>&1 &
  echo "Gateway started."
else
  echo "Gateway already running."
fi

echo "[5/5] Opening LobeHub..."
sleep 3
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open http://localhost:3210 >/dev/null 2>&1 || true
else
  open http://localhost:3210 >/dev/null 2>&1 || true
fi
echo "Done! Your companion is online."
