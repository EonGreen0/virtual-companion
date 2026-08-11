@echo off
chcp 65001 >nul
setlocal
rem %~dp0 是脚本所在目录，自动定位，不依赖绝对路径
set "GW_DIR=%~dp0"
set "LOBE_DIR=%GW_DIR%..\lobehub"
set "BRIDGE_DIR=%GW_DIR%..\wechat-bridge"
set "DOCKER=C:\Program Files\Docker\Docker\resources\bin\docker.exe"
if not exist "%DOCKER%" set "DOCKER=docker"

echo [1/8] Checking Ollama...
curl -s http://localhost:11434/api/version >nul 2>&1
if errorlevel 1 (
  echo Starting Ollama...
  start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
  timeout /t 5 /nobreak >nul
) else (
  echo Ollama already running.
)

echo [2/8] Checking Docker engine...
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

echo [3/8] Starting LobeHub containers...
cd /d "%LOBE_DIR%"
"%DOCKER%" compose up -d

echo [4/8] Preparing memory gateway (首次运行会自动创建环境)...
if not exist "%GW_DIR%\.venv\Scripts\python.exe" (
  echo 未找到虚拟环境，正在创建（需已安装 Python 3.12+）...
  cd /d "%GW_DIR%"
  python -m venv .venv
  if errorlevel 1 py -3 -m venv .venv
  if errorlevel 1 (
    echo [错误] 创建虚拟环境失败：请安装 Python 3.12+，并确保 python 或 py 命令可用。
    pause
    exit /b 1
  )
  echo 安装网关依赖...
  ".venv\Scripts\pip" install -r requirements.txt
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重新运行本脚本。
    pause
    exit /b 1
  )
) else (
  echo 虚拟环境已存在。
)
if not exist "%GW_DIR%\.env" (
  echo.
  echo [错误] 未找到 gateway\.env。
  echo 请先复制 gateway\.env.example 为 .env，并填写 DEEPSEEK_API_KEY。
  pause
  exit /b 1
)
if "%DOUBAO_API_KEY%"=="" echo [提示] 未设置 DOUBAO_API_KEY，微信语音回复不可用（设置方法见 README「微信桥接」）。
if "%ARK_API_KEY%"=="" echo [提示] 未设置 ARK_API_KEY，微信图片理解不可用（设置方法见 README「微信桥接」）。

echo [5/8] Starting memory gateway...
curl -s http://localhost:8080/api/memories >nul 2>&1
if errorlevel 1 (
  start "" "%GW_DIR%\.venv\Scripts\pythonw.exe" "%GW_DIR%\main.py"
  echo Memory gateway started.
) else (
  echo Memory gateway already running.
)

echo [6/8] Preparing WeChat bridge (首次运行会自动安装依赖)...
if not exist "%BRIDGE_DIR%\node_modules" (
  echo 未找到 node_modules，正在安装（需已安装 Node.js 22+）...
  cd /d "%BRIDGE_DIR%"
  call npm install
  if errorlevel 1 (
    echo [错误] npm install 失败，请检查网络后重新运行本脚本。
    pause
    exit /b 1
  )
) else (
  echo 桥接依赖已存在。
)

echo [7/8] Starting WeChat bridge...
curl -s http://127.0.0.1:9090/status >nul 2>&1
if errorlevel 1 (
  start "" /min "node" "%BRIDGE_DIR%\index.js"
  echo WeChat bridge started.
) else (
  echo WeChat bridge already running.
)

echo [8/8] Opening LobeHub...
timeout /t 3 /nobreak >nul
start "" http://localhost:3210
echo Done! Your companion is online.
