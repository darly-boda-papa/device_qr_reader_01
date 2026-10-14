// 모든 처리는 브라우저 안에서만 이루어지며 외부 서버로 데이터를 보내지 않습니다.

// ===== 설정 =====
const STORAGE_KEY = "qrReader.serials";
const CAMERA_KEY = "qrReader.camera";
const SAME_CODE_COOLDOWN_MS = 2000; // 같은 QR을 연속 인식하지 않는 간격
const SCAN_INTERVAL_MS = 150;       // 프레임 분석 주기
const SCAN_MAX_SIZE = 800;          // 분석용 이미지 최대 크기(px)

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const tbody = $("tbody");
const video = $("video");
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

// ===== 상태 =====
let mode = "register";  // "register" | "check"
let serials = [];       // 오름차순 정렬된 serial 목록
let doneSet = new Set(); // 확인 모드에서 확인된 serial
let blinkSerial = null;  // 확인 모드에서 현재 깜빡이는 serial
let newSerial = null;    // 등록 모드에서 방금 추가된 serial
let stream = null;
let scanTimer = null;
let wakeLock = null;
let lastCode = "";
let lastCodeTime = 0;

// ===== 목록 =====
const normalize = (v) => String(v ?? "").trim().toUpperCase();

// 숫자 부분은 숫자 크기로 비교 (ZIT999M < ZIT3519M)
const compare = (a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serials));
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    serials = [...new Set(saved.map(normalize).filter(Boolean))].sort(compare);
  } catch {
    serials = [];
  }
}

// 추가된 개수를 반환
function addSerials(list) {
  let added = 0;
  for (const raw of list) {
    const s = normalize(raw);
    if (s && !serials.includes(s)) {
      serials.push(s);
      added++;
    }
  }
  if (added) {
    serials.sort(compare);
    save();
  }
  return added;
}

function removeSerial(s) {
  serials = serials.filter((x) => x !== s);
  doneSet.delete(s);
  if (blinkSerial === s) blinkSerial = null;
  save();
  render();
}

function render() {
  tbody.innerHTML = "";
  serials.forEach((s, i) => {
    const tr = document.createElement("tr");
    if (s === blinkSerial) tr.classList.add("hit");
    if (s === newSerial) tr.classList.add("new");

    const tdSerial = document.createElement("td");
    tdSerial.textContent = s;

    const tdNo = document.createElement("td");
    tdNo.className = "no";
    tdNo.textContent = i + 1;

    const tdInd = document.createElement("td");
    tdInd.className = "indicator";
    if (doneSet.has(s)) tdInd.classList.add("done");
    if (s === blinkSerial) tdInd.classList.add("blink");

    const tdDel = document.createElement("td");
    tdDel.className = "col-del";
    const del = document.createElement("button");
    del.className = "del-btn";
    del.textContent = "✕";
    del.setAttribute("aria-label", `${s} 삭제`);
    del.addEventListener("click", () => {
      if (confirm(`${s} 을(를) 삭제할까요?`)) removeSerial(s);
    });
    tdDel.appendChild(del);

    tr.append(tdSerial, tdNo, tdInd, tdDel);
    tbody.appendChild(tr);
  });
  $("countBadge").textContent = serials.length;
  $("emptyMsg").hidden = serials.length > 0;
}

function scrollToSerial(s) {
  const i = serials.indexOf(s);
  const tr = tbody.children[i];
  if (!tr) return;
  // 카메라 영역(sticky 아님)을 가리지 않도록 행만 화면 안으로 이동
  tr.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ===== 모드 =====
function setMode(m) {
  mode = m;
  document.body.classList.toggle("mode-check", m === "check");
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === m));
  $("resetMarksBtn").hidden = m !== "check";
  $("pasteBox").hidden = m !== "register";
  $("manualBtn").textContent = m === "register" ? "등록" : "확인";
  newSerial = null;
  lastCode = "";
  if (m === "register") {
    setStatus("idle", "등록 모드", "기기 QR을 순서 상관없이 스캔하면 오름차순으로 정렬됩니다");
  } else {
    setStatus("idle", "확인 모드", serials.length
      ? `QR을 스캔하면 ${serials.length}개 중 몇 번째인지 표시합니다`
      : "먼저 등록 모드에서 Serial을 등록해 주세요");
  }
  render();
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => setMode(t.dataset.mode))
);

// ===== 스캔 결과 처리 =====
function handleCode(raw, fromCamera = true) {
  const code = normalize(raw);
  if (!code) return;

  if (fromCamera) {
    const now = Date.now();
    if (code === lastCode && now - lastCodeTime < SAME_CODE_COOLDOWN_MS) return;
    lastCode = code;
    lastCodeTime = now;
  }

  if (mode === "register") {
    if (addSerials([code])) {
      newSerial = code;
      render();
      scrollToSerial(code);
      setStatus("added", code, `등록됨 → No. ${serials.indexOf(code) + 1} (총 ${serials.length}개)`);
      feedback("ok");
    } else {
      newSerial = null;
      setStatus("dup", code, `이미 등록됨 (No. ${serials.indexOf(code) + 1})`);
      feedback("warn");
    }
    return;
  }

  // 확인 모드
  const idx = serials.indexOf(code);
  if (idx >= 0) {
    doneSet.add(code);
    blinkSerial = code;
    render();
    scrollToSerial(code);
    setStatus("match", `${idx + 1} / ${serials.length}`, `${code} 은(는) ${idx + 1}번째입니다`);
    feedback("ok");
  } else {
    setStatus("nomatch", code, "목록에 없는 Serial입니다");
    feedback("error");
  }
}

function setStatus(type, main, sub = "") {
  $("status").className = `status ${type}`;
  $("statusMain").textContent = main;
  $("statusSub").textContent = sub;
}

let audioCtx = null;
function feedback(kind) {
  const vib = { ok: 120, warn: [60, 60, 60], error: [200, 80, 200] }[kind];
  if (navigator.vibrate) navigator.vibrate(vib);
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = { ok: 1200, warn: 700, error: 300 }[kind];
    gain.gain.value = 0.1;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + (kind === "error" ? 0.3 : 0.12));
  } catch { /* 소리 미지원 시 무시 */ }
}

// ===== 직접 입력 / 붙여넣기 =====
function submitManual() {
  const input = $("manualInput");
  handleCode(input.value, false);
  input.value = "";
}
$("manualBtn").addEventListener("click", submitManual);
$("manualInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitManual();
});

$("pasteBtn").addEventListener("click", () => {
  const area = $("pasteArea");
  const list = area.value
    .split(/[\r\n,;\t]+/)
    .map(normalize)
    .filter(Boolean);
  if (!list.length) return;
  const added = addSerials(list);
  newSerial = null;
  render();
  area.value = "";
  $("pasteBox").open = false;
  setStatus("added", `${added}개 추가`, `중복 ${list.length - added}개 제외 · 총 ${serials.length}개`);
});

$("resetMarksBtn").addEventListener("click", () => {
  doneSet.clear();
  blinkSerial = null;
  render();
  setStatus("idle", "확인 모드", "표시를 초기화했습니다");
});

$("clearBtn").addEventListener("click", () => {
  if (!serials.length || !confirm(`Serial ${serials.length}개를 모두 삭제할까요?`)) return;
  serials = [];
  doneSet.clear();
  blinkSerial = null;
  newSerial = null;
  save();
  render();
  setStatus("idle", "전체 삭제됨", "");
});

// ===== 카메라 =====
async function listCameras(activeId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  const select = $("cameraSelect");
  select.innerHTML = "";
  cams.forEach((cam, i) => {
    const opt = document.createElement("option");
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `카메라 ${i + 1}`;
    select.appendChild(opt);
  });
  if (activeId) select.value = activeId;
  select.hidden = cams.length < 2;
}

async function startCamera(deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("nomatch", "카메라 사용 불가", "HTTPS 주소(GitHub Pages)로 접속해 주세요");
    return;
  }
  stopCamera();
  const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: "environment", ...size },
      audio: false,
    });
  } catch (err) {
    console.error(err);
    // 저장된 카메라가 없어진 경우 기본 후면 카메라로 재시도
    if (deviceId && err.name !== "NotAllowedError") {
      localStorage.removeItem(CAMERA_KEY);
      return startCamera(null);
    }
    const msg = err.name === "NotAllowedError"
      ? "브라우저 설정에서 카메라 권한을 허용해 주세요"
      : err.message;
    setStatus("nomatch", "카메라 오류", msg);
    return;
  }

  video.srcObject = stream;
  await video.play();
  $("videoPlaceholder").hidden = true;
  $("startBtn").hidden = true;
  $("stopBtn").hidden = false;

  const track = stream.getVideoTracks()[0];
  const activeId = track.getSettings().deviceId;
  if (activeId) localStorage.setItem(CAMERA_KEY, activeId);
  listCameras(activeId).catch(() => {});
  setupTrackControls(track);
  requestWakeLock();

  scanTimer = setInterval(scanFrame, SCAN_INTERVAL_MS);
}

function stopCamera() {
  clearInterval(scanTimer);
  scanTimer = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  $("videoPlaceholder").hidden = false;
  $("startBtn").hidden = false;
  $("stopBtn").hidden = true;
  $("torchBtn").hidden = true;
  $("zoomRow").hidden = true;
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

// 줌 / 플래시 (지원하는 기기에서만 표시)
function setupTrackControls(track) {
  const caps = track.getCapabilities ? track.getCapabilities() : {};

  const torchBtn = $("torchBtn");
  torchBtn.hidden = !caps.torch;
  let torchOn = false;
  torchBtn.onclick = async () => {
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch { torchOn = false; }
    torchBtn.classList.toggle("primary", torchOn);
  };

  const zoomRow = $("zoomRow");
  const range = $("zoomRange");
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    range.min = caps.zoom.min;
    range.max = caps.zoom.max;
    range.step = caps.zoom.step || 0.1;
    range.value = track.getSettings().zoom || caps.zoom.min;
    range.oninput = () => track.applyConstraints({ advanced: [{ zoom: Number(range.value) }] }).catch(() => {});
    zoomRow.hidden = false;
  } else {
    zoomRow.hidden = true;
  }
}

// 스캔 중 화면 꺼짐 방지
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* 미지원 시 무시 */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && stream) requestWakeLock();
});

function scanFrame() {
  if (!stream || video.readyState < 2) return;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.min(1, SCAN_MAX_SIZE / Math.max(vw, vh));
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const result = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
  if (result && result.data) handleCode(result.data);
}

$("startBtn").addEventListener("click", () => startCamera(localStorage.getItem(CAMERA_KEY)));
$("stopBtn").addEventListener("click", stopCamera);
$("cameraSelect").addEventListener("change", (e) => startCamera(e.target.value));

// ===== 초기화 =====
load();
setMode("register");
