#!/usr/bin/env bash
# Virtual Companion 一键启动（Linux / macOS）
# 用法：bash gateway/start.sh
# 首次运行会自动：创建网关虚拟环境并安装依赖、npm install 微信桥接依赖
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_DIR="$SCRIPT_DIR"
LOBE_DIR="$(cd "$SCRIPT_DIR/../lobehub" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/../wechat-bridge" && pwd)"

echo "[1/6] Checking Ollama..."
if ! curl -sf http://localhost:11434/api/version >/dev/null 2>&1; then
  echo "Starting Ollama..."
  nohup ollama serve >/dev/null 2>&1 &
  sleep 5
else
  echo "Ollama already running."
fi

echo "[2/6] Checking Docker..."
if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  echo "Docker is not running. Please start it first (e.g. systemctl start docker)."
  exit 1
fi

echo "[3/6] Starting LobeHub containers..."
cd "$LOBE_DIR"
docker compose up -d

echo "[4/6] Preparing memory gateway..."
if ! curl -sf http://localhost:8080/api/memories >/dev/null 2>&1; then
  cd "$GATEWAY_DIR"
  if [ ! -d .venv ]; then
    echo "Creating virtual environment (first run)..."
    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
  fi
  if [ ! -f .env ]; then
    echo "[ERROR] gateway/.env not found."
    echo "Copy gateway/.env.example to .env and set DEEPSEEK_API_KEY first."
    exit 1
  fi
  nohup .venv/bin/python main.py >/dev/null 2>&1 &
  echo "Gateway started."
else
  echo "Gateway already running."
fi

if [ -z "${DOUBAO_API_KEY:-}" ]; then
  echo "[HINT] DOUBAO_API_KEY not set - WeChat voice replies disabled (see README \"微信桥接\")."
fi
if [ -z "${ARK_API_KEY:-}" ]; then
  echo "[HINT] ARK_API_KEY not set - WeChat image understanding disabled (see README \"微信桥接\")."
fi

echo "[5/6] Preparing WeChat bridge..."
if [ ! -d "$BRIDGE_DIR/node_modules" ]; then
  echo "Installing bridge dependencies (npm install, first run)..."
  (cd "$BRIDGE_DIR" && npm install)
fi
if ! curl -sf http://127.0.0.1:9090/status >/dev/null 2>&1; then
  (cd "$BRIDGE_DIR" && nohup node index.js >/dev/null 2>&1 &)
  echo "WeChat bridge started."
else
  echo "WeChat bridge already running."
fi

echo "[6/6] Opening LobeHub..."
sleep 3
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open http://localhost:3210 >/dev/null 2>&1 || true
else
  open http://localhost:3210 >/dev/null 2>&1 || true
fi
echo "Done! Your companion is online."
