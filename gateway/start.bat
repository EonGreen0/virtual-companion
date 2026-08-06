@echo off
chcp 65001 >nul
setlocal
set "GW_DIR=C:\Users\SANWU\Documents\Codex\2026-08-06\wo\virtual-companion\gateway"
set "LOBE_DIR=C:\Users\SANWU\Documents\Codex\2026-08-06\wo\virtual-companion\lobehub"
set "DOCKER=C:\Program Files\Docker\Docker\resources\bin\docker.exe"

echo [1/4] Checking Docker engine...
"%DOCKER%" version --format "{{.Server.Version}}" >nul 2>&1
if errorlevel 1 goto start_docker
goto docker_ready

:start_docker
echo Starting Docker Desktop...
start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
echo Waiting for Docker engine (up to 120s)...
set /a tries=0
:docker_wait
set /a tries+=1
if %tries% GEQ 24 goto docker_ready
"%DOCKER%" version --format "{{.Server.Version}}" >nul 2>&1
if errorlevel 1 (
  timeout /t 5 /nobreak >nul
  goto docker_wait
)

:docker_ready
echo Docker engine ready.

echo [2/4] Starting LobeHub containers...
cd /d "%LOBE_DIR%"
"%DOCKER%" compose up -d

echo [3/4] Starting memory gateway...
curl -s http://localhost:8080/api/memories >nul 2>&1
if errorlevel 1 (
  start "" "%GW_DIR%\.venv\Scripts\pythonw.exe" "%GW_DIR%\main.py"
  echo Memory gateway started.
) else (
  echo Memory gateway already running.
)

echo [4/4] Opening LobeHub...
timeout /t 3 /nobreak >nul
start "" http://localhost:3210
echo Done! Kita is waiting for you.
