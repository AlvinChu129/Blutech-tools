@echo off
cd /d "%~dp0"

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [INFO] Python not found. Trying to install via winget...

    winget --version >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] winget not found. Please install Python 3.12 manually.
        echo Download: https://www.python.org/downloads/
        pause
        exit /b 1
    )

    echo [INFO] Installing Python 3.12 via winget...
    winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo [ERROR] winget install failed. Please install Python 3.12 manually.
        echo Download: https://www.python.org/downloads/
        pause
        exit /b 1
    )

    call refreshenv >nul 2>&1

    python --version >nul 2>&1
    if errorlevel 1 (
        echo [INFO] Python installed. Please close and re-run run-modbus-tool.bat.
        pause
        exit /b 0
    )

    echo [OK] Python installed successfully.
)

:: Launch tool
start "Modbus TCP Tool" python app.py
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:8765/
