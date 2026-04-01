const API_BASE = window.location.protocol === "file:" ? "http://127.0.0.1:8765" : "";

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  specs: {},          // { 電表: [...], 水流量: [...], 溫度計: [...] }
  specNames: [],      // ['電表', '水流量', '溫度計']
  devices: [],        // [{ unitId, specName, status, latency, summary, lastTs, rows, reqHex, resHex, error }]
  verifyTimer: null,
  verifyBusy: false,
  activeUnitId: null,
  // spec editor buffer: { [typeName]: rows[] }
  editorBuffer: {},
  editorCurrentType: "",
};

// ── DOM refs ───────────────────────────────────────────────────────────────
const el = {
  form:              document.getElementById("settings-form"),
  connectionState:   document.getElementById("connection-state"),
  unitStart:         document.getElementById("unit-start"),
  deviceCount:       document.getElementById("device-count"),
  probeButton:       document.getElementById("probe-button"),
  verifyAllButton:   document.getElementById("verify-all-button"),
  pollAllButton:     document.getElementById("poll-all-button"),
  stopVerifyButton:  document.getElementById("stop-verify-button"),
  okCount:           document.getElementById("ok-count"),
  failCount:         document.getElementById("fail-count"),
  pendingCount:      document.getElementById("pending-count"),
  progressText:      document.getElementById("progress-text"),
  deviceTableBody:   document.getElementById("device-table-body"),
  // bulk assign
  bulkFrom:          document.getElementById("bulk-from"),
  bulkTo:            document.getElementById("bulk-to"),
  bulkType:          document.getElementById("bulk-type"),
  bulkAssignButton:  document.getElementById("bulk-assign-button"),
  // detail
  detailUnitLabel:   document.getElementById("detail-unit-label"),
  detailContent:     document.getElementById("detail-content"),
  detailRefreshBtn:  document.getElementById("detail-refresh-button"),
  closeDetailBtn:    document.getElementById("close-detail-button"),
  // log
  logPanel:          document.getElementById("log-panel"),
  clearLogBtn:       document.getElementById("clear-log-display-button"),
  // spec modal
  editSpecButton:    document.getElementById("edit-spec-button"),
  specModal:         document.getElementById("spec-modal"),
  closeModalButton:  document.getElementById("close-modal-button"),
  cancelSpecButton:  document.getElementById("cancel-spec-button"),
  saveSpecButton:    document.getElementById("save-spec-button"),
  addSpecRowButton:  document.getElementById("add-spec-row-button"),
  addSpecTypeButton: document.getElementById("add-spec-type-button"),
  delSpecTypeButton: document.getElementById("del-spec-type-button"),
  specTypeSelect:    document.getElementById("spec-type-select"),
  specEditorBody:    document.getElementById("spec-editor-body"),
};

// ── Helpers ────────────────────────────────────────────────────────────────
function getSettings() {
  const fd = new FormData(el.form);
  return {
    ip:             String(fd.get("ip") || "").trim(),
    port:           Number(fd.get("port") || 502),
    functionCode:   String(fd.get("functionCode") || "FC03"),
    timeoutMs:      Number(fd.get("timeoutMs") || 2000),
    pollIntervalMs: Number(fd.get("pollIntervalMs") || 5000),
    floatOrder:     String(fd.get("floatOrder") || "ABCD"),
    addressBase:    Number(fd.get("addressBase") || 0),
  };
}

async function apiFetch(url, payload = {}, method = "POST") {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || "request failed");
  return data.data;
}

function ts() {
  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function addLog(title, detail, type = "info") {
  const entry = document.createElement("article");
  entry.className = `log-entry${type === "error" ? " is-error" : ""}`;
  const strong = document.createElement("strong");
  strong.textContent = title;
  const p = document.createElement("p");
  p.textContent = detail;
  const time = document.createElement("time");
  time.textContent = ts();
  entry.append(strong, p, time);
  el.logPanel.prepend(entry);
}

// ── Type selects (shared helper) ───────────────────────────────────────────
function populateTypeSelects() {
  const names = state.specNames;

  // bulk assign dropdown
  el.bulkType.innerHTML = names.map((n) => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join("");

  // spec modal dropdown
  el.specTypeSelect.innerHTML = names.map((n) => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join("");
}

// ── Device list ────────────────────────────────────────────────────────────
function buildDeviceList() {
  const start = Math.max(0, parseInt(el.unitStart.value, 10) || 1);
  const count = Math.max(1, parseInt(el.deviceCount.value, 10) || 1);
  const defaultType = state.specNames[0] || "";

  // Preserve existing specName per unitId when rebuilding
  const prevMap = new Map(state.devices.map((d) => [d.unitId, d.specName]));
  state.devices = [];
  for (let i = 0; i < count; i++) {
    const uid = start + i;
    state.devices.push({
      unitId:   uid,
      specName: prevMap.get(uid) || defaultType,
      status:   "pending",
      latency:  null,
      summary:  "",
      lastTs:   "",
      rows:     [],
      reqHex:   "",
      resHex:   "",
      error:    "",
    });
  }
  renderDeviceTable();
  updateSummaryChips();
  closeDetail();
}

function renderDeviceTable() {
  el.deviceTableBody.innerHTML = "";
  state.devices.forEach((d) => {
    const tr = document.createElement("tr");
    tr.id = `dev-row-${d.unitId}`;
    if (d.unitId === state.activeUnitId) tr.classList.add("is-active");
    tr.innerHTML = deviceRowHtml(d);
    // type selector change
    const sel = tr.querySelector(".dev-type-select");
    if (sel) sel.addEventListener("change", (e) => { d.specName = e.target.value; });
    // detail button
    tr.querySelector("[data-action='detail']").addEventListener("click", () => openDetail(d.unitId));
    el.deviceTableBody.appendChild(tr);
  });
}

function deviceRowHtml(d) {
  const typeOptions = state.specNames
    .map((n) => `<option value="${escHtml(n)}"${n === d.specName ? " selected" : ""}>${escHtml(n)}</option>`)
    .join("");
  const badge = badgeHtml(d.status);
  const lat   = d.latency != null
    ? `<span class="device-latency">${d.latency}</span>`
    : `<span class="muted">—</span>`;
  const sum   = d.summary
    ? `<span class="device-summary has-value">${escHtml(d.summary)}</span>`
    : `<span class="device-summary">${d.error ? escHtml(d.error) : "—"}</span>`;
  const t     = d.lastTs ? `<span class="device-time">${d.lastTs}</span>` : `<span class="muted">—</span>`;

  return `
    <td><strong style="font-family:'IBM Plex Mono',monospace">${d.unitId}</strong></td>
    <td><select class="dev-type-select">${typeOptions}</select></td>
    <td>${badge}</td>
    <td>${lat}</td>
    <td>${sum}</td>
    <td>${t}</td>
    <td><button type="button" class="btn btn-ghost btn-xs" data-action="detail">詳細</button></td>
  `;
}

function badgeHtml(status) {
  const map = {
    pending: ["badge-pending", "待測"],
    testing: ["badge-testing", "測試中"],
    ok:      ["badge-ok",      "正常"],
    fail:    ["badge-fail",    "失敗"],
  };
  const [cls, label] = map[status] || map.pending;
  return `<span class="badge ${cls}">${label}</span>`;
}

function refreshDeviceRow(d) {
  const tr = document.getElementById(`dev-row-${d.unitId}`);
  if (!tr) return;
  tr.innerHTML = deviceRowHtml(d);
  const sel = tr.querySelector(".dev-type-select");
  if (sel) sel.addEventListener("change", (e) => { d.specName = e.target.value; });
  tr.querySelector("[data-action='detail']").addEventListener("click", () => openDetail(d.unitId));
  if (d.unitId === state.activeUnitId) tr.classList.add("is-active");
}

function updateSummaryChips() {
  el.okCount.textContent      = state.devices.filter((d) => d.status === "ok").length;
  el.failCount.textContent    = state.devices.filter((d) => d.status === "fail").length;
  el.pendingCount.textContent = state.devices.filter((d) => d.status === "pending" || d.status === "testing").length;
}

// ── Bulk assign ────────────────────────────────────────────────────────────
function bulkAssign() {
  const from    = parseInt(el.bulkFrom.value, 10);
  const to      = parseInt(el.bulkTo.value, 10);
  const newType = el.bulkType.value;
  if (isNaN(from) || isNaN(to) || from > to || !newType) return;

  let count = 0;
  state.devices.forEach((d) => {
    if (d.unitId >= from && d.unitId <= to) {
      d.specName = newType;
      count++;
    }
  });
  renderDeviceTable();
  addLog("批量指派完成", `Unit ${from}–${to} 共 ${count} 台設為「${newType}」`);
}

// ── Verify one device ──────────────────────────────────────────────────────
async function verifyDevice(d, settings) {
  d.status = "testing";
  refreshDeviceRow(d);
  updateSummaryChips();

  try {
    const result = await apiFetch("/api/read-all", {
      ...settings,
      unitId:   d.unitId,
      specName: d.specName,
    });

    d.status  = "ok";
    d.latency = result.responseTimeMs;
    d.lastTs  = ts();
    d.rows    = result.rows;
    d.reqHex  = result.rawRequestHex  || "";
    d.resHex  = result.rawResponseHex || "";
    d.error   = "";

    // 摘要：前 2 個點位
    d.summary = result.rows.slice(0, 2)
      .map((r) => `${r.description.replace(/\(.*\)/, "").trim()} ${Number.isFinite(r.value) ? r.value : "NaN"}${r.unit}`)
      .join("  |  ");

    if (d.unitId === state.activeUnitId) renderDetail(d);
    el.connectionState.textContent = "設備回應正常";
    el.connectionState.className   = "status-pill is-ok";

  } catch (err) {
    d.status  = "fail";
    d.latency = null;
    d.lastTs  = ts();
    d.error   = err instanceof Error ? err.message : String(err);
    d.summary = "";
    addLog(`Unit ${d.unitId} 讀取失敗`, d.error, "error");
  }

  refreshDeviceRow(d);
  updateSummaryChips();
}

// ── Verify all ─────────────────────────────────────────────────────────────
async function verifyAll() {
  if (state.verifyBusy) return;
  state.verifyBusy = true;
  setBusyUI(true);
  buildDeviceList();

  const settings = getSettings();
  const total    = state.devices.length;
  let done = 0;

  addLog("開始批次驗證", `共 ${total} 台設備`);

  for (const d of state.devices) {
    if (!state.verifyBusy) break;
    await verifyDevice(d, settings);
    done++;
    el.progressText.textContent = `${done} / ${total}`;
  }

  const ok   = state.devices.filter((d) => d.status === "ok").length;
  const fail = state.devices.filter((d) => d.status === "fail").length;
  addLog("批次驗證完成", `正常 ${ok} 台，失敗 ${fail} 台`);
  stopVerify();
}

// ── Poll all ───────────────────────────────────────────────────────────────
async function startPollAll() {
  if (state.verifyBusy) return;
  buildDeviceList();
  state.verifyBusy = true;
  setBusyUI(true);

  const settings    = getSettings();
  const intervalMs  = settings.pollIntervalMs;
  addLog("持續輪詢已啟動", `每 ${intervalMs / 1000} 秒掃描全部設備`);

  async function pollRound() {
    if (!state.verifyBusy) return;
    const total = state.devices.length;
    let done = 0;
    for (const d of state.devices) {
      if (!state.verifyBusy) return;
      await verifyDevice(d, settings);
      done++;
      el.progressText.textContent = `${done} / ${total}`;
    }
    if (state.verifyBusy) state.verifyTimer = setTimeout(pollRound, intervalMs);
  }
  pollRound();
}

function stopVerify() {
  state.verifyBusy = false;
  if (state.verifyTimer) { clearTimeout(state.verifyTimer); state.verifyTimer = null; }
  setBusyUI(false);
  state.devices.forEach((d) => {
    if (d.status === "testing") { d.status = "pending"; refreshDeviceRow(d); }
  });
  updateSummaryChips();
}

function setBusyUI(busy) {
  el.verifyAllButton.disabled  = busy;
  el.pollAllButton.disabled    = busy;
  el.stopVerifyButton.disabled = !busy;
}

// ── TCP probe ──────────────────────────────────────────────────────────────
async function probeConnection() {
  const s = getSettings();
  try {
    const result = await apiFetch("/api/probe", s);
    el.connectionState.textContent = "TCP 可達";
    el.connectionState.className   = "status-pill is-ok";
    addLog("TCP 連線成功", `${result.ip}:${result.port} — ${result.connectTimeMs} ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    el.connectionState.textContent = "TCP 失敗";
    el.connectionState.className   = "status-pill is-error";
    addLog("TCP 連線失敗", msg, "error");
  }
}

// ── Detail panel ───────────────────────────────────────────────────────────
function openDetail(unitId) {
  const d = state.devices.find((x) => x.unitId === unitId);
  if (!d) return;
  document.querySelectorAll(".device-table tbody tr").forEach((r) => r.classList.remove("is-active"));
  const tr = document.getElementById(`dev-row-${unitId}`);
  if (tr) tr.classList.add("is-active");
  state.activeUnitId = unitId;
  el.detailUnitLabel.textContent = `Unit ${unitId}（${d.specName}）`;
  el.detailRefreshBtn.disabled   = false;
  renderDetail(d);
}

function renderDetail(d) {
  if (!d.rows.length) {
    el.detailContent.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "detail-empty";
    empty.innerHTML = d.status === "fail"
      ? `<span style="color:var(--danger)">讀取失敗：${escHtml(d.error)}</span>`
      : "<span>尚無讀值，請先執行驗證</span>";
    el.detailContent.appendChild(empty);
    return;
  }

  el.detailContent.innerHTML = `
    <div class="detail-table-wrap">
      <table class="detail-table">
        <thead>
          <tr>
            <th>Description</th>
            <th>Value</th>
            <th>Unit</th>
            <th>Raw Registers</th>
          </tr>
        </thead>
        <tbody>
          ${d.rows.map((r) => `
            <tr>
              <td>${escHtml(r.description)}</td>
              <td class="detail-value${Number.isFinite(r.value) ? "" : " is-error"}">
                ${Number.isFinite(r.value) ? r.value : "NaN"}
              </td>
              <td class="muted">${escHtml(r.unit)}</td>
              <td class="detail-raw">${Array.isArray(r.rawRegisters) ? r.rawRegisters.join(", ") : "—"}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <div class="detail-hex">
      <div class="hex-item"><span>Request Hex</span><code>${escHtml(d.reqHex) || "—"}</code></div>
      <div class="hex-item"><span>Response Hex</span><code>${escHtml(d.resHex) || "—"}</code></div>
    </div>
  `;
}

function closeDetail() {
  state.activeUnitId = null;
  el.detailUnitLabel.textContent = "—";
  el.detailRefreshBtn.disabled   = true;
  el.detailContent.innerHTML     = "";
  const empty = document.createElement("div");
  empty.className = "detail-empty";
  empty.innerHTML = "<span>點選設備列的「詳細」查看完整讀值</span>";
  el.detailContent.appendChild(empty);
  document.querySelectorAll(".device-table tbody tr").forEach((r) => r.classList.remove("is-active"));
}

async function refreshDetail() {
  if (state.activeUnitId == null) return;
  const d = state.devices.find((x) => x.unitId === state.activeUnitId);
  if (!d) return;
  await verifyDevice(d, getSettings());
}

// ── Spec editor ────────────────────────────────────────────────────────────
const DATA_TYPES = ["Float", "UINT16", "INT16", "UINT32", "INT32"];

function openSpecEditor() {
  // Deep-copy current specs into editor buffer
  state.editorBuffer = {};
  for (const [name, rows] of Object.entries(state.specs)) {
    state.editorBuffer[name] = rows.map((r) => ({ ...r }));
  }
  // populate type select
  el.specTypeSelect.innerHTML = Object.keys(state.editorBuffer)
    .map((n) => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join("");

  state.editorCurrentType = Object.keys(state.editorBuffer)[0] || "";
  el.specTypeSelect.value = state.editorCurrentType;
  renderEditorRows();
  el.specModal.hidden = false;
}

function closeSpecEditor() { el.specModal.hidden = true; }

function saveEditorRowsToBuffer() {
  if (!state.editorCurrentType) return;
  const rows = [];
  for (const tr of el.specEditorBody.querySelectorAll("tr")) {
    const offset = parseInt(tr.querySelector("[name='offset']").value, 10);
    if (isNaN(offset)) continue;
    rows.push({
      offset,
      description:    tr.querySelector("[name='description']").value.trim(),
      functionCode:   tr.querySelector("[name='functionCode']").value.trim() || "FC03",
      size:           parseInt(tr.querySelector("[name='size']").value, 10) || 2,
      dataType:       tr.querySelector("[name='dataType']").value,
      resolution:     parseFloat(tr.querySelector("[name='resolution']").value) || 1,
      unit:           tr.querySelector("[name='unit']").value.trim(),
      logicalAddress: offset + 40001,
      registerType:   "Holding Register",
      access:         "Read",
    });
  }
  state.editorBuffer[state.editorCurrentType] = rows;
}

function switchEditorType(newType) {
  saveEditorRowsToBuffer();
  state.editorCurrentType = newType;
  renderEditorRows();
}

function renderEditorRows() {
  el.specEditorBody.innerHTML = "";
  const rows = state.editorBuffer[state.editorCurrentType] || [];
  rows.forEach((row) => el.specEditorBody.appendChild(createEditorRow(row)));
}

function createEditorRow(row) {
  const tr = document.createElement("tr");
  const dtOptions = DATA_TYPES
    .map((t) => `<option value="${t}"${t === row.dataType ? " selected" : ""}>${t}</option>`)
    .join("");
  tr.innerHTML = `
    <td><input type="number" name="offset"       value="${row.offset}"              min="0" max="65535" style="width:60px" /></td>
    <td><input type="text"   name="description"  value="${escHtml(row.description)}"                    style="width:100%;min-width:150px" /></td>
    <td><input type="text"   name="functionCode" value="${escHtml(row.functionCode)}"                    style="width:50px" /></td>
    <td><input type="number" name="size"         value="${row.size}"                min="1" max="4"      style="width:40px" /></td>
    <td><select name="dataType" style="width:76px">${dtOptions}</select></td>
    <td><input type="number" name="resolution"   value="${row.resolution}"          step="any"           style="width:58px" /></td>
    <td><input type="text"   name="unit"         value="${escHtml(row.unit)}"                            style="width:44px" /></td>
    <td><button type="button" class="btn btn-ghost btn-xs" data-action="remove">✕</button></td>
  `;
  tr.querySelector("[data-action='remove']").addEventListener("click", () => tr.remove());
  return tr;
}

function addEditorRow() {
  const rows = el.specEditorBody.querySelectorAll("tr");
  let nextOffset = 0;
  if (rows.length) {
    const last = rows[rows.length - 1];
    const lo = parseInt(last.querySelector("[name='offset']").value, 10) || 0;
    const ls = parseInt(last.querySelector("[name='size']").value,   10) || 2;
    nextOffset = lo + ls;
  }
  el.specEditorBody.appendChild(createEditorRow({
    offset: nextOffset, description: "", functionCode: "FC03",
    size: 2, dataType: "Float", resolution: 1, unit: "",
  }));
}

function addSpecType() {
  const name = prompt("請輸入新類型名稱：");
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  if (state.editorBuffer[trimmed]) {
    alert(`「${trimmed}」已存在`);
    return;
  }
  saveEditorRowsToBuffer();
  state.editorBuffer[trimmed] = [];
  // add to select
  const opt = document.createElement("option");
  opt.value = trimmed;
  opt.textContent = trimmed;
  el.specTypeSelect.appendChild(opt);
  el.specTypeSelect.value = trimmed;
  state.editorCurrentType = trimmed;
  renderEditorRows();
}

function delSpecType() {
  const names = Object.keys(state.editorBuffer);
  if (names.length <= 1) { alert("至少要保留一個類型"); return; }
  if (!confirm(`確定刪除類型「${state.editorCurrentType}」？`)) return;
  delete state.editorBuffer[state.editorCurrentType];
  el.specTypeSelect.innerHTML = Object.keys(state.editorBuffer)
    .map((n) => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join("");
  state.editorCurrentType = Object.keys(state.editorBuffer)[0];
  el.specTypeSelect.value = state.editorCurrentType;
  renderEditorRows();
}

async function saveSpec() {
  saveEditorRowsToBuffer();
  try {
    const result = await apiFetch("/api/specs", state.editorBuffer, "PUT");
    state.specs     = result.specs;
    state.specNames = result.names;
    populateTypeSelects();
    // rebuild device list to reflect any type name changes
    buildDeviceList();
    closeSpecEditor();
    addLog("點位已更新", `共 ${state.specNames.length} 種類型已儲存至 specs.json`);
  } catch (err) {
    addLog("儲存點位失敗", err instanceof Error ? err.message : String(err), "error");
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
function bindEvents() {
  el.probeButton.addEventListener("click",      probeConnection);
  el.verifyAllButton.addEventListener("click",  verifyAll);
  el.pollAllButton.addEventListener("click",    startPollAll);
  el.stopVerifyButton.addEventListener("click", stopVerify);

  el.bulkAssignButton.addEventListener("click", bulkAssign);

  el.clearLogBtn.addEventListener("click",    () => { el.logPanel.innerHTML = ""; });
  el.detailRefreshBtn.addEventListener("click", refreshDetail);
  el.closeDetailBtn.addEventListener("click",   closeDetail);

  el.editSpecButton.addEventListener("click",    openSpecEditor);
  el.closeModalButton.addEventListener("click",  closeSpecEditor);
  el.cancelSpecButton.addEventListener("click",  closeSpecEditor);
  el.saveSpecButton.addEventListener("click",    saveSpec);
  el.addSpecRowButton.addEventListener("click",  addEditorRow);
  el.addSpecTypeButton.addEventListener("click", addSpecType);
  el.delSpecTypeButton.addEventListener("click", delSpecType);
  el.specTypeSelect.addEventListener("change",  (e) => switchEditorType(e.target.value));
  el.specModal.addEventListener("click", (e) => { if (e.target === el.specModal) closeSpecEditor(); });

  [el.unitStart, el.deviceCount].forEach((inp) =>
    inp.addEventListener("change", () => { if (!state.verifyBusy) buildDeviceList(); })
  );
}

async function init() {
  try {
    const res  = await fetch(`${API_BASE}/api/specs`);
    const data = await res.json();
    state.specs     = data.specs;
    state.specNames = data.names;

    populateTypeSelects();
    bindEvents();
    buildDeviceList();

    if (window.location.protocol === "file:") addLog("本機 API 模式", "已改連 http://127.0.0.1:8765");
    addLog("工具已就緒", "設定連線參數後，按「開始驗證」或「持續輪詢」");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addLog("初始化失敗",
      window.location.protocol === "file:" ? `${msg}。請先執行 run-modbus-tool.bat。` : msg,
      "error"
    );
  }
}

window.addEventListener("beforeunload", stopVerify);
window.addEventListener("DOMContentLoaded", init);
