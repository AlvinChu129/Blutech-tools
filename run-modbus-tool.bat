@echo off
cd /d "%~dp0"

:: ── 檢查 Python ──────────────────────────────────────────────────────────────
python --version >nul 2>&1
if errorlevel 1 (
    echo [資訊] 未偵測到 Python，嘗試自動安裝...

    :: 確認 winget 是否可用
    winget --version >nul 2>&1
    if errorlevel 1 (
        echo [警告] 找不到 winget，請手動安裝 Python 3.12 後重新執行。
        echo 下載網址: https://www.python.org/downloads/
        pause
        exit /b 1
    )

    echo [資訊] 透過 winget 安裝 Python 3.12，請稍候...
    winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo [錯誤] winget 安裝失敗，請手動安裝 Python 3.12。
        echo 下載網址: https://www.python.org/downloads/
        pause
        exit /b 1
    )

    :: 重新整理 PATH（winget 安裝後需要）
    echo [資訊] 重新整理環境變數...
    call refreshenv >nul 2>&1

    :: 再次確認
    python --version >nul 2>&1
    if errorlevel 1 (
        echo [提示] Python 已安裝完成，但需要重新開啟命令提示字元才能生效。
        echo        請關閉此視窗後再次執行 run-modbus-tool.bat。
        pause
        exit /b 0
    )

    echo [成功] Python 安裝完成。
)

:: ── 啟動工具 ──────────────────────────────────────────────────────────────────
start "Modbus TCP Tool" python app.py
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:8765/
