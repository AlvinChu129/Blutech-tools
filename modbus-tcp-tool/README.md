# Modbus TCP Tool

## 啟動方式

1. 直接雙擊 `run-modbus-tool.bat`
2. 瀏覽器會自動開啟 `http://127.0.0.1:8765/`

## 如果看到初始化失敗

- 最常見原因是直接雙擊 `modbus-tool.html`
- 這個工具需要本機 Python 服務一起跑
- 請改用 `run-modbus-tool.bat`，或在這個資料夾內執行 `python app.py`

## 主要欄位

- `IP / Host`
- `Port`
- `Function Code`
- `Unit ID`
- `Timeout`
- `輪詢間隔`
- `Float Byte Order`
