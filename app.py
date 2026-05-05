from __future__ import annotations

import itertools
import json
import socket
import struct
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


HOST = "127.0.0.1"
PORT = 8765
BASE_DIR = Path(__file__).resolve().parent
TRANSACTION_IDS = itertools.count(1)
SPECS_FILE    = BASE_DIR / "specs.json"
SPEC_FILE     = BASE_DIR / "spec.json"   # 舊格式，讀取後自動遷移
PROFILES_FILE = BASE_DIR / "profiles.json"

STATIC_FILES = {
    "/": ("modbus-tool.html", "text/html; charset=utf-8"),
    "/modbus-tool.html": ("modbus-tool.html", "text/html; charset=utf-8"),
    "/modbus-tool.css": ("modbus-tool.css", "text/css; charset=utf-8"),
    "/modbus-tool.js": ("modbus-tool.js", "application/javascript; charset=utf-8"),
}

DEFAULT_SPECS: dict[str, list[dict[str, Any]]] = {
    "電表": [
        {"offset": 0,  "registerType": "Holding Register", "logicalAddress": 40001, "functionCode": "FC03", "size": 2, "dataType": "Float", "resolution": 1, "description": "R-Phase Voltage (R相電壓)", "access": "Read", "unit": "V"},
        {"offset": 2,  "registerType": "Holding Register", "logicalAddress": 40003, "functionCode": "FC03", "size": 2, "dataType": "Float", "resolution": 1, "description": "S-Phase Voltage (S相電壓)", "access": "Read", "unit": "V"},
        {"offset": 4,  "registerType": "Holding Register", "logicalAddress": 40005, "functionCode": "FC03", "size": 2, "dataType": "Float", "resolution": 1, "description": "T-Phase Voltage (T相電壓)", "access": "Read", "unit": "V"},
        {"offset": 6,  "registerType": "Holding Register", "logicalAddress": 40007, "functionCode": "FC03", "size": 2, "dataType": "Float", "resolution": 1, "description": "R-Phase Current (R相電流)", "access": "Read", "unit": "A"},
        {"offset": 8,  "registerType": "Holding Register", "logicalAddress": 40009, "functionCode": "FC03", "size": 2, "dataType": "Float", "resolution": 1, "description": "S-Phase Current (S相電流)", "access": "Read", "unit": "A"},
        {"offset": 10, "registerType": "Holding Register", "logicalAddress": 40011, "functionCode": "FC03", "size": 2, "dataType": "Float", "resolution": 1, "description": "T-Phase Current (T相電流)", "access": "Read", "unit": "A"},
        {"offset": 12, "registerType": "Holding Register", "logicalAddress": 40013, "functionCode": "FC03", "size": 2, "dataType": "Float", "resolution": 1, "description": "R-Phase Power (R相功率)", "access": "Read", "unit": "kW"},
        {"offset": 14, "registerType": "Holding Register", "logicalAddress": 40015, "functionCode": "FC03", "size": 2, "dataType": "Float", "resolution": 1, "description": "S-Phase Power (S相功率)", "access": "Read", "unit": "kW"},
        {"offset": 16, "registerType": "Holding Register", "logicalAddress": 40017, "functionCode": "FC03", "size": 2, "dataType": "Float", "resolution": 1, "description": "T-Phase Power (T相功率)", "access": "Read", "unit": "kW"},
        {"offset": 18, "registerType": "Holding Register", "logicalAddress": 40019, "functionCode": "FC03", "size": 2, "dataType": "Float", "resolution": 1, "description": "Total kWh (累積總電度)", "access": "Read", "unit": "kWh"},
        {"offset": 20, "registerType": "Holding Register", "logicalAddress": 40021, "functionCode": "FC03", "size": 2, "dataType": "Float", "resolution": 1, "description": "Power Factor (功率因數)", "access": "Read", "unit": "-"},
    ],
    "水流量": [
        {"offset": 0, "registerType": "Holding Register", "logicalAddress": 40001, "functionCode": "FC03", "size": 2, "dataType": "Float", "resolution": 1, "description": "CurrentFlow (瞬時流量)", "access": "Read", "unit": "LPM"},
    ],
    "溫度計": [
        {"offset": 0, "registerType": "Holding Register", "logicalAddress": 40001, "functionCode": "FC03", "size": 2, "dataType": "Float", "resolution": 1, "description": "CurrentTmpIn (回水溫度)", "access": "Read", "unit": "℃"},
        {"offset": 2, "registerType": "Holding Register", "logicalAddress": 40003, "functionCode": "FC03", "size": 2, "dataType": "Float", "resolution": 1, "description": "CurrentTmpOut (出水溫度)", "access": "Read", "unit": "℃"},
    ],
}

EXCEPTION_CODES = {
    1: "Illegal Function",
    2: "Illegal Data Address",
    3: "Illegal Data Value",
    4: "Slave Device Failure",
    5: "Acknowledge",
    6: "Slave Device Busy",
    8: "Memory Parity Error",
    10: "Gateway Path Unavailable",
    11: "Gateway Target Device Failed To Respond",
}

_specs: dict[str, list[dict[str, Any]]] = {}
_profiles: dict[str, dict[str, Any]] = {}


def load_profiles() -> dict[str, dict[str, Any]]:
    if PROFILES_FILE.exists():
        try:
            data = json.loads(PROFILES_FILE.read_text("utf-8"))
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return {}


def save_profiles_data(payload: Any) -> dict[str, Any]:
    global _profiles
    if not isinstance(payload, dict):
        raise ValueError("Profiles 必須是物件")
    _profiles = payload
    PROFILES_FILE.write_text(json.dumps(_profiles, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"profiles": _profiles}


def load_specs() -> dict[str, list[dict[str, Any]]]:
    # 優先讀新格式 specs.json
    if SPECS_FILE.exists():
        try:
            data = json.loads(SPECS_FILE.read_text("utf-8"))
            if isinstance(data, dict) and data:
                return data
        except Exception:
            pass
    # 遷移舊格式 spec.json → 電表
    if SPEC_FILE.exists():
        try:
            rows = json.loads(SPEC_FILE.read_text("utf-8"))
            if isinstance(rows, list) and rows:
                migrated = {"電表": rows}
                for k, v in DEFAULT_SPECS.items():
                    if k != "電表":
                        migrated[k] = [dict(r) for r in v]
                return migrated
        except Exception:
            pass
    return {k: [dict(r) for r in v] for k, v in DEFAULT_SPECS.items()}


def get_spec_by_name(name: str) -> list[dict[str, Any]]:
    if name and name in _specs:
        return _specs[name]
    return list(_specs.values())[0] if _specs else []


def validate_spec_rows(rows: Any) -> list[dict[str, Any]]:
    if not isinstance(rows, list):
        raise ValueError("點位定義必須是陣列")
    validated = []
    for item in rows:
        offset = int(item["offset"])
        validated.append({
            "offset": offset,
            "registerType": str(item.get("registerType", "Holding Register")),
            "logicalAddress": int(item.get("logicalAddress", offset + 40001)),
            "functionCode": str(item.get("functionCode", "FC03")),
            "size": max(1, int(item.get("size", 2))),
            "dataType": str(item.get("dataType", "Float")),
            "resolution": float(item.get("resolution", 1)),
            "description": str(item.get("description", "")),
            "access": str(item.get("access", "Read")),
            "unit": str(item.get("unit", "")),
        })
    return validated


def update_all_specs(payload: Any) -> dict[str, Any]:
    global _specs
    if not isinstance(payload, dict) or not payload:
        raise ValueError("Specs 必須是非空物件")
    validated: dict[str, list[dict[str, Any]]] = {}
    for name, rows in payload.items():
        validated[str(name)] = validate_spec_rows(rows)
    _specs = validated
    SPECS_FILE.write_text(json.dumps(validated, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"specs": _specs, "names": list(_specs.keys())}


def parse_json(handler: BaseHTTPRequestHandler) -> Any:
    content_length = int(handler.headers.get("Content-Length", "0"))
    body = handler.rfile.read(content_length) if content_length else b"{}"
    return json.loads(body.decode("utf-8"))


def parse_function_code(value: Any) -> int:
    text = str(value).strip().upper()
    if text.startswith("FC"):
        text = text[2:]
    code = int(text, 10)
    if code not in {3, 4}:
        raise ValueError("目前工具支援 FC03 與 FC04")
    return code


def parse_address_base(value: Any) -> int:
    base = int(0 if value is None else value)
    if base not in {0, 1}:
        raise ValueError("Address Base must be 0 or 1")
    return base


def decode_value(registers: list[int], data_type: str, float_order: str) -> float:
    dt = data_type.strip().upper()
    if dt == "FLOAT":
        if len(registers) != 2:
            raise ValueError("Float 需要 2 個 registers")
        base = registers[0].to_bytes(2, "big") + registers[1].to_bytes(2, "big")
        mapping = {"ABCD": (0,1,2,3), "BADC": (1,0,3,2), "CDAB": (2,3,0,1), "DCBA": (3,2,1,0)}
        order = float_order.strip().upper()
        if order not in mapping:
            raise ValueError("不支援的 Float Byte Order")
        ordered = bytes(base[i] for i in mapping[order])
        return struct.unpack(">f", ordered)[0]
    if dt in ("INT16", "SINT16"):
        raw = registers[0]
        return float(raw if raw < 0x8000 else raw - 0x10000)
    if dt == "UINT16":
        return float(registers[0])
    if dt in ("INT32", "SINT32"):
        raw = (registers[0] << 16) | registers[1]
        return float(raw if raw < 0x80000000 else raw - 0x100000000)
    if dt == "UINT32":
        return float((registers[0] << 16) | registers[1])
    return float(registers[0])


def read_exact(sock: socket.socket, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = sock.recv(size - len(chunks))
        if not chunk:
            raise ConnectionError("設備在回應完成前中斷連線")
        chunks.extend(chunk)
    return bytes(chunks)


def send_modbus_request(
    host: str, port: int, unit_id: int, function_code: int,
    start_address: int, quantity: int, timeout_ms: int,
) -> dict[str, Any]:
    if not 0 <= start_address <= 65535:
        raise ValueError("Start Address 必須介於 0 到 65535")
    if not 1 <= quantity <= 125:
        raise ValueError("Quantity 必須介於 1 到 125")
    if not 0 <= unit_id <= 255:
        raise ValueError("Unit ID 必須介於 0 到 255")
    if not 1 <= port <= 65535:
        raise ValueError("Port 必須介於 1 到 65535")

    transaction_id = next(TRANSACTION_IDS) % 65536
    pdu  = struct.pack(">BHH", function_code, start_address, quantity)
    mbap = struct.pack(">HHHB", transaction_id, 0, len(pdu) + 1, unit_id)
    request = mbap + pdu
    started = time.perf_counter()

    with socket.create_connection((host, port), timeout=timeout_ms / 1000) as sock:
        sock.settimeout(timeout_ms / 1000)
        sock.sendall(request)
        response_header = read_exact(sock, 7)
        resp_tid, resp_pid, resp_length, resp_unit_id = struct.unpack(">HHHB", response_header)
        if resp_tid != transaction_id:
            raise ValueError("Transaction ID 不一致")
        if resp_pid != 0:
            raise ValueError("Protocol ID 錯誤")
        response_pdu = read_exact(sock, resp_length - 1)
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)

    raw_response = response_header + response_pdu
    response_function = response_pdu[0]
    if response_function & 0x80:
        exception_code = response_pdu[1] if len(response_pdu) > 1 else None
        exception_name = EXCEPTION_CODES.get(exception_code, "Unknown")
        raise ValueError(f"設備回傳例外 {exception_code}: {exception_name}")
    if response_function != function_code:
        raise ValueError("Function Code 不一致")

    byte_count = response_pdu[1]
    payload = response_pdu[2:]
    if byte_count != len(payload):
        raise ValueError("Byte Count 與實際資料長度不一致")
    if byte_count % 2 != 0:
        raise ValueError("資料長度不是完整 register 數")

    registers = [int.from_bytes(payload[i:i + 2], "big") for i in range(0, len(payload), 2)]
    if len(registers) != quantity:
        raise ValueError(f"預期 {quantity} registers，收到 {len(registers)}")
    return {
        "transactionId": transaction_id,
        "unitId": resp_unit_id,
        "functionCode": response_function,
        "registers": registers,
        "rawRequestHex": request.hex(" ").upper(),
        "rawResponseHex": raw_response.hex(" ").upper(),
        "responseTimeMs": elapsed_ms,
    }


def probe_tcp(payload: dict[str, Any]) -> dict[str, Any]:
    host = str(payload.get("ip", "")).strip()
    if not host:
        raise ValueError("IP / Host 不可為空")
    port = int(payload.get("port", 502))
    timeout_ms = int(payload.get("timeoutMs", 2000))
    started = time.perf_counter()
    with socket.create_connection((host, port), timeout=timeout_ms / 1000):
        elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
    return {"connected": True, "connectTimeMs": elapsed_ms, "ip": host, "port": port}


def scan_unit_ids(payload: dict[str, Any]) -> dict[str, Any]:
    host = str(payload.get("ip", "")).strip()
    if not host:
        raise ValueError("IP / Host 不可為空")
    port = int(payload.get("port", 502))
    function_code = parse_function_code(payload.get("functionCode", "FC03"))
    timeout_ms = int(payload.get("timeoutMs", 2000))
    address_base = parse_address_base(payload.get("addressBase", 0))
    scan_from = int(payload.get("scanFrom", 1))
    scan_to   = int(payload.get("scanTo", 10))
    if not 0 <= scan_from <= 255 or not 0 <= scan_to <= 255 or scan_from > scan_to:
        raise ValueError("Unit ID 掃描範圍無效")

    found, errors = [], []
    for unit_id in range(scan_from, scan_to + 1):
        try:
            result = send_modbus_request(host, port, unit_id, function_code, address_base, 2, timeout_ms)
            found.append({"unitId": unit_id, "responseTimeMs": result["responseTimeMs"], "registers": result["registers"]})
        except Exception as exc:  # noqa: BLE001
            errors.append({"unitId": unit_id, "error": format_error_message(exc)})
    return {
        "ip": host, "port": port, "functionCode": function_code,
        "addressBase": address_base, "scanFrom": scan_from, "scanTo": scan_to,
        "found": found, "errors": errors,
    }


def read_meter_data(payload: dict[str, Any]) -> dict[str, Any]:
    spec_name     = str(payload.get("specName", "")).strip()
    spec          = get_spec_by_name(spec_name)
    function_code = parse_function_code(payload.get("functionCode", "FC03"))
    host          = str(payload.get("ip", "")).strip()
    if not host:
        raise ValueError("IP / Host 不可為空")
    port          = int(payload.get("port", 502))
    unit_id       = int(payload.get("unitId", 1))
    timeout_ms    = int(payload.get("timeoutMs", 2000))
    float_order   = str(payload.get("floatOrder", "ABCD")).strip().upper()
    address_base  = parse_address_base(payload.get("addressBase", 0))
    quantity      = max(item["offset"] + item["size"] for item in spec)

    response = send_modbus_request(host, port, unit_id, function_code, address_base, quantity, timeout_ms)
    rows = []
    for item in spec:
        start        = item["offset"]
        raw_registers = response["registers"][start:start + item["size"]]
        value        = decode_value(raw_registers, item.get("dataType", "Float"), float_order) * item["resolution"]
        rows.append({**item, "value": round(value, 4), "rawRegisters": raw_registers, "status": "ok"})

    response["rows"]         = rows
    response["specName"]     = spec_name
    response["floatOrder"]   = float_order
    response["startAddress"] = address_base
    response["quantity"]     = quantity
    response["addressBase"]  = address_base
    return response


def read_single_row(payload: dict[str, Any]) -> dict[str, Any]:
    spec_name     = str(payload.get("specName", "")).strip()
    spec          = get_spec_by_name(spec_name)
    function_code = parse_function_code(payload.get("functionCode", "FC03"))
    host          = str(payload.get("ip", "")).strip()
    if not host:
        raise ValueError("IP / Host 不可為空")
    port         = int(payload.get("port", 502))
    unit_id      = int(payload.get("unitId", 1))
    timeout_ms   = int(payload.get("timeoutMs", 2000))
    float_order  = str(payload.get("floatOrder", "ABCD")).strip().upper()
    address_base = parse_address_base(payload.get("addressBase", 0))
    offset       = int(payload.get("offset", 0))
    spec_item    = next((item for item in spec if item["offset"] == offset), None)
    if spec_item is None:
        raise ValueError("找不到指定 offset 的點位定義")

    response = send_modbus_request(host, port, unit_id, function_code, offset + address_base, spec_item["size"], timeout_ms)
    value = decode_value(response["registers"], spec_item.get("dataType", "Float"), float_order) * spec_item["resolution"]
    response["row"]          = {**spec_item, "value": round(value, 4), "rawRegisters": response["registers"], "status": "ok"}
    response["floatOrder"]   = float_order
    response["startAddress"] = offset + address_base
    response["quantity"]     = spec_item["size"]
    response["addressBase"]  = address_base
    return response


def format_error_message(exc: Exception) -> str:
    if isinstance(exc, TimeoutError):
        return "連線逾時：確認 IP、Port、防火牆與設備在線狀態"
    if isinstance(exc, ConnectionRefusedError):
        return "連線被拒絕：目標 IP 可達但 Port 未開放"
    if isinstance(exc, socket.gaierror):
        return "DNS 解析失敗，請確認 IP 或 Host"
    return str(exc)


class ModbusToolHandler(BaseHTTPRequestHandler):
    server_version = "ModbusVerifier/1.0"

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/profiles":
            self.send_json({"profiles": _profiles})
            return
        if parsed.path == "/api/specs":
            self.send_json({"specs": _specs, "names": list(_specs.keys())})
            return
        if parsed.path == "/api/spec":
            # backward compat
            self.send_json({"rows": list(_specs.values())[0] if _specs else []})
            return
        if parsed.path == "/api/health":
            self.send_json({"status": "ok"})
            return

        file_info = STATIC_FILES.get(parsed.path)
        if not file_info:
            self.send_error(HTTPStatus.NOT_FOUND, "Not Found")
            return
        file_name, content_type = file_info
        file_path = BASE_DIR / file_name
        if not file_path.exists():
            self.send_error(HTTPStatus.NOT_FOUND, "Static file not found")
            return
        content = file_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_cors_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            payload = parse_json(self)
            if parsed.path == "/api/probe":
                data = probe_tcp(payload)
            elif parsed.path == "/api/scan-units":
                data = scan_unit_ids(payload)
            elif parsed.path == "/api/read-all":
                data = read_meter_data(payload)
            elif parsed.path == "/api/read-register":
                data = read_single_row(payload)
            else:
                self.send_error(HTTPStatus.NOT_FOUND, "Not Found")
                return
            self.send_json({"ok": True, "data": data})
        except Exception as exc:  # noqa: BLE001
            self.send_json({"ok": False, "error": format_error_message(exc)}, status=HTTPStatus.BAD_REQUEST)

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        try:
            payload = parse_json(self)
            if parsed.path == "/api/profiles":
                data = save_profiles_data(payload)
            elif parsed.path == "/api/specs":
                data = update_all_specs(payload)
            else:
                self.send_error(HTTPStatus.NOT_FOUND, "Not Found")
                return
            self.send_json({"ok": True, "data": data})
        except Exception as exc:  # noqa: BLE001
            self.send_json({"ok": False, "error": format_error_message(exc)}, status=HTTPStatus.BAD_REQUEST)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


def main() -> None:
    global _specs, _profiles
    _specs    = load_specs()
    _profiles = load_profiles()
    server = ThreadingHTTPServer((HOST, PORT), ModbusToolHandler)
    print(f"Modbus TCP 驗證工具已啟動: http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n收到中斷訊號，正在關閉伺服器...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
