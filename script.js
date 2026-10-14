// 모든 처리는 브라우저 안에서만 이루어지며 외부 서버로 데이터를 보내지 않습니다.

// ===== 설정 =====
const STORAGE_KEY = "qrReader.serials";
const CAMERA_KEY = "qrReader.camera";
const MULTI_KEY = "qrReader.multi";
const SAME_CODE_COOLDOWN_MS = 2000; // 화면에서 사라진 뒤 이 시간이 지나야 같은 코드를 다시 인식
const SCAN_INTERVAL_MS = 120;       // 프레임 분석 간 쉬는 시간
const FULL_FRAME_EVERY = 3;         // 조준 영역에서 못 찾으면 N번에 한 번 전체 화면 분석
const FULL_MAX_SIZE = 1280;         // 전체 화면 분석 시 최대 크기(px)
const MULTI_MAX_SIZE = 1920;        // 여러 개 동시 인식 시 최대 크기(px)
const READER_OPTIONS = {
  formats: ["DataMatrix", "QRCode"],
  tryHarder: true,
  maxNumberOfSymbols: 1,
};
const READER_MULTI = { ...READER_OPTIONS, maxNumberOfSymbols: 30 };

// ZXing(WASM) 준비 — wasm 파일도 같은 폴더에서 불러옴(외부 CDN 미사용)
const zxingReady = (async () => {
  ZXingWASM.prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) =>
        path.endsWith(".wasm") ? new URL(path, location.href).href : prefix + path,
    },
    fireImmediately: true,
  });
  // 빈 이미지로 한 번 실행해 wasm 로딩 완료를 확인
  await ZXingWASM.readBarcodes(new ImageData(8, 8), READER_OPTIONS);
})();
zxingReady.catch(() => {}); // 실패는 사용하는 곳에서 안내

// ===== DOM =====
const $ = (id) => document.getElementById(id);
const tbody = $("tbody");
const video = $("video");
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

// ===== 상태 =====
let mode = "register";    // "register" | "check" | "label"
let serials = [];         // 오름차순 정렬된 serial 목록
let doneSet = new Set();  // 확인 모드에서 확인된 serial
let blinkSerial = null;   // 확인 모드에서 현재 깜빡이는 serial
let newSet = new Set();   // 등록 모드에서 방금 추가된 serial
let stream = null;
let scanning = false;
let scanTimer = null;
let frameCount = 0;
let wakeLock = null;
const lastSeen = new Map(); // code → 마지막으로 화면에서 본 시각

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
    if (newSet.has(s)) tr.classList.add("new");

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
  renderRemain();
}

// 확인 모드: 아직 스캔하지 않은 기기 수
function renderRemain() {
  const el = $("remain");
  el.hidden = mode !== "check" || serials.length === 0;
  if (el.hidden) return;
  const left = serials.filter((s) => !doneSet.has(s)).length;
  el.classList.toggle("complete", left === 0);
  el.textContent = left === 0 ? "✔ 전체 확인" : `${left}대 미확인`;
}

function scrollToSerial(s) {
  const tr = tbody.children[serials.indexOf(s)];
  if (tr) tr.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// ===== 모드 =====
function setMode(m) {
  mode = m;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === m));
  document.body.classList.toggle("mode-check", m === "check");

  const isLabel = m === "label";
  $("scannerView").hidden = isLabel;
  $("listView").hidden = isLabel;
  $("labelView").hidden = !isLabel;
  if (isLabel) {
    stopCamera();
    setOcr(false);
    return;
  }

  $("resetMarksBtn").hidden = m !== "check";
  $("pasteBox").hidden = m !== "register";
  $("multiRow").hidden = m !== "register";
  $("manualBtn").textContent = m === "register" ? "등록" : "확인";
  updateAimStyle();
  newSet = new Set();
  lastSeen.clear();
  $("ocrCands").innerHTML = "";
  if (m === "register") {
    setStatus("idle", "등록 모드", "기기 코드를 순서 상관없이 스캔하면 오름차순으로 정렬됩니다");
  } else {
    setStatus("idle", "확인 모드", serials.length
      ? `코드를 스캔하면 ${serials.length}개 중 몇 번째인지 표시합니다`
      : "먼저 등록 모드에서 Serial을 등록해 주세요");
  }
  render();
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => setMode(t.dataset.mode))
);

// ===== 스캔 결과 처리 =====
// 같은 코드가 계속 화면에 있으면 다시 처리하지 않음
function isFresh(code) {
  const now = Date.now();
  const prev = lastSeen.get(code);
  lastSeen.set(code, now);
  return prev === undefined || now - prev > SAME_CODE_COOLDOWN_MS;
}

function handleCode(raw, fromCamera = true) {
  const code = normalize(raw);
  if (!code) return;
  if (fromCamera && !isFresh(code)) return;

  if (mode === "register") {
    if (addSerials([code])) {
      newSet = new Set([code]);
      render();
      scrollToSerial(code);
      setStatus("added", code, `등록됨 → No. ${serials.indexOf(code) + 1} (총 ${serials.length}개)`);
      feedback("ok");
    } else {
      newSet = new Set();
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

// 여러 개 동시 인식(등록 모드)
function handleMany(rawCodes) {
  const codes = [...new Set(rawCodes.map(normalize).filter(Boolean))];
  const fresh = codes.filter(isFresh);
  if (!fresh.length) return;
  if (codes.length === 1) {
    handleCode(codes[0], false);
    return;
  }
  const before = new Set(serials);
  const added = addSerials(codes);
  newSet = new Set(codes.filter((c) => !before.has(c)));
  render();
  if (newSet.size) scrollToSerial([...newSet][0]);
  setStatus(
    added ? "added" : "dup",
    `${codes.length}개 인식 · ${added}개 추가`,
    `이미 등록 ${codes.length - added}개 · 총 ${serials.length}개`
  );
  feedback(added ? "ok" : "warn");
}

function setStatus(type, main, sub = "") {
  $("status").className = `status ${type}`;
  $("statusMain").textContent = main;
  $("statusSub").textContent = sub;
}

let audioCtx = null;
function feedback(kind) {
  const vib = { ok: 120, warn: [60, 60, 60], error: [200, 80, 200] }[kind];
  if (navigator.vibrate && navigator.userActivation?.hasBeenActive !== false) navigator.vibrate(vib);
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
  newSet = new Set();
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
  newSet = new Set();
  save();
  render();
  setStatus("idle", "전체 삭제됨", "");
});

$("multiChk").checked = localStorage.getItem(MULTI_KEY) === "1";
$("multiChk").addEventListener("change", (e) => {
  localStorage.setItem(MULTI_KEY, e.target.checked ? "1" : "0");
  lastSeen.clear();
  updateAimStyle();
});

// 여러 개 인식 중에는 전체 화면을 보므로 조준 사각형을 숨김
function updateAimStyle() {
  $("videoWrap").classList.toggle("multi", mode === "register" && $("multiChk").checked);
}

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
  // 작은 Data Matrix를 읽기 위해 고해상도 요청
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
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
  $("ocrBtn").hidden = false;

  const track = stream.getVideoTracks()[0];
  const activeId = track.getSettings().deviceId;
  if (activeId) localStorage.setItem(CAMERA_KEY, activeId);
  listCameras(activeId).catch(() => {});
  setupTrackControls(track);
  requestWakeLock();

  try {
    await zxingReady;
  } catch (err) {
    console.error(err);
    setStatus("nomatch", "인식 엔진 로딩 실패", "zxing_full.wasm 파일이 업로드되었는지 확인해 주세요");
    return;
  }
  scanning = true;
  frameCount = 0;
  scanLoop();
}

function stopCamera() {
  scanning = false;
  clearTimeout(scanTimer);
  scanTimer = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  $("videoPlaceholder").hidden = false;
  $("startBtn").hidden = false;
  $("stopBtn").hidden = true;
  $("ocrBtn").hidden = true;
  $("torchBtn").hidden = true;
  $("zoomRow").hidden = true;
  setOcr(false);
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

// 줌 / 플래시 (지원하는 기기에서만 표시)
function setupTrackControls(track) {
  const caps = track.getCapabilities ? track.getCapabilities() : {};

  // 가까운 거리 초점을 위해 연속 자동초점 사용
  if (caps.focusMode && caps.focusMode.includes("continuous")) {
    track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
  }

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

// 화면 위의 요소(조준 사각형 / OCR 띠)에 해당하는 영상 영역(원본 해상도 기준)
function regionRect(el, vw, vh, padRatio) {
  const box = video.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const scale = Math.max(box.width / vw, box.height / vh); // object-fit: cover
  const offX = (vw * scale - box.width) / 2;
  const offY = (vh * scale - box.height) / 2;
  const pad = r.width * padRatio;
  const x = Math.max(0, (r.left - box.left - pad + offX) / scale);
  const y = Math.max(0, (r.top - box.top - pad + offY) / scale);
  const w = Math.min(vw - x, (r.width + pad * 2) / scale);
  const h = Math.min(vh - y, (r.height + pad * 2) / scale);
  return [x, y, w, h];
}

function grab(sx, sy, sw, sh, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

async function scanFrame() {
  if (!stream || video.readyState < 2) return;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  // 여러 개 동시 인식: 전체 화면을 고해상도로 분석
  if (mode === "register" && $("multiChk").checked) {
    const results = await ZXingWASM.readBarcodes(grab(0, 0, vw, vh, MULTI_MAX_SIZE), READER_MULTI);
    const codes = results.filter((r) => r.isValid && r.text).map((r) => r.text);
    if (codes.length) handleMany(codes);
    return;
  }

  // 1) 조준 영역을 원본 해상도로 분석 (작은 코드 인식에 유리, 빠름)
  const [x, y, w, h] = regionRect(document.querySelector(".aim"), vw, vh, 0.15);
  let results = await ZXingWASM.readBarcodes(grab(x, y, w, h, 1600), READER_OPTIONS);

  // 2) 못 찾으면 가끔 전체 화면도 분석
  if (!results.length && ++frameCount % FULL_FRAME_EVERY === 0) {
    results = await ZXingWASM.readBarcodes(grab(0, 0, vw, vh, FULL_MAX_SIZE), READER_OPTIONS);
  }

  const hit = results.find((r) => r.isValid && r.text);
  if (hit) handleCode(hit.text);
}

async function scanLoop() {
  if (!scanning) return;
  try {
    await scanFrame();
  } catch (err) {
    console.error(err);
  }
  if (scanning) scanTimer = setTimeout(scanLoop, SCAN_INTERVAL_MS);
}

$("startBtn").addEventListener("click", () => startCamera(localStorage.getItem(CAMERA_KEY)));
$("stopBtn").addEventListener("click", stopCamera);
$("cameraSelect").addEventListener("change", (e) => startCamera(e.target.value));

// ===== 글자 인식(OCR) — 코드가 훼손됐을 때 보조용 =====
const OCR_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
// OCR에서 자주 헷갈리는 글자를 같은 글자로 보고 비교
const CONFUSABLE = { O: "0", Q: "0", D: "0", I: "1", L: "1", J: "1", Z: "2", 7: "2", S: "5", B: "8", G: "6" };
let ocrWorkerPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src} 로딩 실패`));
    document.head.appendChild(s);
  });
}

// OCR 엔진(약 9MB)은 처음 사용할 때만 불러옴
function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      if (!window.Tesseract) await loadScript("tesseract.min.js");
      const base = new URL(".", location.href).href;
      const worker = await Tesseract.createWorker("eng", 1, {
        workerPath: base + "worker.min.js",
        corePath: base + "tesseract-core-simd-lstm.wasm.js",
        langPath: base.replace(/\/$/, ""),
        gzip: false,
        workerBlobURL: false,
        cacheMethod: "none", // 서비스 워커가 파일을 저장하므로 중복 저장하지 않음
      });
      await worker.setParameters({
        tessedit_char_whitelist: OCR_CHARS,
        tessedit_pageseg_mode: "7", // 한 줄 글자
      });
      return worker;
    })();
    ocrWorkerPromise.catch(() => { ocrWorkerPromise = null; });
  }
  return ocrWorkerPromise;
}

function setOcr(on) {
  $("ocrPanel").hidden = !on;
  $("videoWrap").classList.toggle("ocr", on);
  $("ocrBtn").classList.toggle("primary", on);
  if (on) {
    $("ocrCands").innerHTML = "";
    $("ocrPreview").hidden = true;
    $("ocrRaw").textContent = "띠 안에 라벨 글자를 맞추고 [글자 읽기]를 누르세요";
    getOcrWorker().catch(() => {}); // 미리 준비
  }
}

$("ocrBtn").addEventListener("click", () => setOcr($("ocrPanel").hidden));
$("ocrReadBtn").addEventListener("click", readText);

function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, th = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = gray.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const diff = sumB / wB - (sum - sumB) / wF;
    const between = wB * wF * diff * diff;
    if (between > best) { best = between; th = i; }
  }
  return th;
}

// 띠 영역을 흑백으로 바꾸고 글자가 충분히 크도록 확대
function ocrImage(sx, sy, sw, sh, binarize) {
  const k = Math.min(3, Math.max(1, 160 / sh));
  const c = document.createElement("canvas");
  c.width = Math.round(sw * k);
  c.height = Math.round(sh * k);
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const img = cx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const gray = new Uint8Array(c.width * c.height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0;
  }
  const th = binarize ? otsuThreshold(gray) : -1;
  for (let i = 0; i < gray.length; i++) {
    const v = binarize ? (gray[i] > th ? 255 : 0) : gray[i];
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  cx.putImageData(img, 0, 0);
  return c;
}

// 흑백 이미지에서 글자 덩어리만 남김
// - 테두리에 닿은 덩어리(배경), 작은 점을 품은 덩어리(Data Matrix) 제거
// - 비슷한 높이로 한 줄에 놓인 덩어리만 글자로 판단
function isolateText(bin) {
  const W = bin.width, H = bin.height;
  const px = bin.getContext("2d").getImageData(0, 0, W, H).data;
  const fg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) fg[i] = px[i * 4] < 128 ? 1 : 0;

  const label = new Int32Array(W * H);
  const comps = [];
  const stack = [];
  for (let i = 0; i < W * H; i++) {
    if (!fg[i] || label[i]) continue;
    const c = { id: comps.length + 1, minx: W, miny: H, maxx: 0, maxy: 0, border: false };
    label[i] = c.id;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p / W) | 0;
      if (x < c.minx) c.minx = x;
      if (x > c.maxx) c.maxx = x;
      if (y < c.miny) c.miny = y;
      if (y > c.maxy) c.maxy = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) c.border = true;
      const near = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W];
      for (const q of near) {
        if (q >= 0 && q < W * H && fg[q] && !label[q]) {
          label[q] = c.id;
          stack.push(q);
        }
      }
    }
    c.w = c.maxx - c.minx + 1;
    c.h = c.maxy - c.miny + 1;
    comps.push(c);
  }

  const innerCount = (c) => comps.filter((o) => o !== c &&
    o.minx >= c.minx && o.maxx <= c.maxx && o.miny >= c.miny && o.maxy <= c.maxy).length;
  const cand = comps.filter((c) => !c.border && c.h >= H * 0.15 && c.h <= H * 0.95 &&
    c.w / c.h <= 0.95 && innerCount(c) < 3);
  if (!cand.length) return null;

  // 글자 높이(중앙값)와 글자 줄의 세로 위치
  const mid = (arr) => arr.sort((a, b) => a - b)[arr.length >> 1];
  const mh = mid(cand.map((c) => c.h));
  const line = cand.filter((c) => c.h >= mh * 0.7 && c.h <= mh * 1.3);
  const cy = mid(line.map((c) => (c.miny + c.maxy) / 2));
  const keep = comps.filter((c) => !c.border && c.h >= mh * 0.2 && c.h <= mh * 1.3 && c.w <= mh * 1.2 &&
    Math.abs((c.miny + c.maxy) / 2 - cy) <= mh * 0.6 &&
    !(c.w / c.h > 0.95 && c.h > mh * 0.7) && innerCount(c) < 3);
  if (!keep.length) return null;

  const ids = new Set(keep.map((c) => c.id));
  const x0 = Math.min(...keep.map((c) => c.minx)), x1 = Math.max(...keep.map((c) => c.maxx));
  const y0 = Math.min(...keep.map((c) => c.miny)), y1 = Math.max(...keep.map((c) => c.maxy));
  const m = Math.round(mh * 0.4);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1 + m * 2;
  out.height = y1 - y0 + 1 + m * 2;
  const octx = out.getContext("2d");
  const od = octx.createImageData(out.width, out.height);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const sx = x + x0 - m, sy = y + y0 - m;
      const on = sx >= 0 && sy >= 0 && sx < W && sy < H && ids.has(label[sy * W + sx]);
      const k = (y * out.width + x) * 4;
      od.data[k] = od.data[k + 1] = od.data[k + 2] = on ? 0 : 255;
      od.data[k + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return { canvas: out, charHeight: mh };
}

// 라벨 글꼴은 폭이 좁아 가로로 늘리고 획을 두껍게 하면 잘 읽힘
function ocrVariant(src, charHeight, targetH, stretch, thicken) {
  const k = targetH / charHeight;
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * k * stretch);
  c.height = Math.round(src.height * k);
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.fillStyle = "#fff";
  cx.fillRect(0, 0, c.width, c.height);
  cx.imageSmoothingQuality = "high";
  cx.drawImage(src, 0, 0, c.width, c.height);
  if (thicken) {
    const W = c.width, H = c.height;
    const img = cx.getImageData(0, 0, W, H);
    const dark = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) dark[i] = img.data[i * 4] < 160 ? 1 : 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let on = 0;
        for (let dy = -thicken; dy <= thicken && !on; dy++) {
          for (let dx = -thicken; dx <= thicken && !on; dx++) {
            const X = x + dx, Y = y + dy;
            on = X >= 0 && Y >= 0 && X < W && Y < H && dark[Y * W + X];
          }
        }
        const k4 = (y * W + x) * 4;
        img.data[k4] = img.data[k4 + 1] = img.data[k4 + 2] = on ? 0 : 255;
      }
    }
    cx.putImageData(img, 0, 0);
  }
  return c;
}

async function readText() {
  if (!stream || video.readyState < 2) return;
  const btn = $("ocrReadBtn");
  btn.disabled = true;
  btn.textContent = "읽는 중...";
  try {
    const worker = await getOcrWorker();
    const [x, y, w, h] = regionRect($("ocrBand"), video.videoWidth, video.videoHeight, 0.03);
    const bin = ocrImage(x, y, w, h, true);
    const text = isolateText(bin);
    let variants;
    if (text) {
      variants = [
        ocrVariant(text.canvas, text.charHeight, 32, 1.4, 1),
        ocrVariant(text.canvas, text.charHeight, 40, 1.6, 1),
        ocrVariant(text.canvas, text.charHeight, 48, 1.4, 2),
      ];
      $("ocrPreview").src = text.canvas.toDataURL();
    } else {
      // 글자 덩어리를 못 찾으면 띠 전체를 그대로 읽음
      variants = [bin, ocrImage(x, y, w, h, false)];
      $("ocrPreview").src = bin.toDataURL();
    }
    $("ocrPreview").hidden = false;
    const texts = [];
    for (const c of variants) texts.push((await worker.recognize(c)).data.text);
    showOcrResult(texts);
  } catch (err) {
    console.error(err);
    $("ocrRaw").textContent = "글자 인식 엔진을 불러오지 못했습니다 (tesseract 파일, eng.traineddata 업로드 확인)";
  } finally {
    btn.disabled = false;
    btn.textContent = "📷 글자 읽기";
  }
}

// 여러 번 읽은 결과에서 후보 단어를 많이 나온 순으로
function ocrTokens(texts) {
  const count = new Map();
  for (const t of texts) {
    const words = t.toUpperCase().split(/\s+/).map((w) => w.replace(/[^A-Z0-9]/g, "")).filter(Boolean);
    const found = new Set(words);
    if (words.length > 1) found.add(words.join("")); // "ZIT 4372M" 처럼 띄어 읽은 경우
    found.forEach((w) => count.set(w, (count.get(w) || 0) + 1));
  }
  return [...count.keys()]
    .filter((w) => w.length >= 4 && /\d/.test(w))
    .sort((a, b) => count.get(b) - count.get(a));
}

const canon = (s) => s.replace(/[A-Z0-9]/g, (c) => CONFUSABLE[c] || c);

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// 읽은 글자와 가장 비슷한 등록 Serial (최대 3개)
function matchSerials(tokens) {
  const ct = tokens.map(canon);
  const scored = serials
    .map((s) => ({ s, d: Math.min(...ct.map((t) => editDistance(t, canon(s)))) }))
    .filter(({ s, d }) => d <= Math.max(1, Math.floor(s.length / 4)))
    .sort((a, b) => a.d - b.d || compare(a.s, b.s));
  return scored.filter(({ d }) => d === scored[0]?.d).slice(0, 3);
}

function addCandidate(text, tag, onPick) {
  const b = document.createElement("button");
  b.className = "cand";
  const main = document.createElement("span");
  main.textContent = text;
  const small = document.createElement("small");
  small.textContent = tag;
  b.append(main, small);
  b.addEventListener("click", onPick);
  $("ocrCands").appendChild(b);
}

function showOcrResult(texts) {
  const tokens = ocrTokens(texts);
  $("ocrCands").innerHTML = "";
  if (!tokens.length) {
    $("ocrRaw").textContent = "글자를 읽지 못했습니다. 띠 안에 글자를 크게 맞추고 다시 시도해 주세요";
    feedback("error");
    return;
  }
  $("ocrRaw").textContent = `읽은 글자: ${tokens.join(", ")}`;

  if (mode === "check") {
    const matches = matchSerials(tokens);
    if (!matches.length) {
      $("ocrRaw").textContent += " → 비슷한 Serial 없음";
      feedback("error");
      return;
    }
    $("ocrRaw").textContent += " → 맞는 Serial을 눌러 주세요";
    matches.forEach(({ s, d }) =>
      addCandidate(`${s} (No. ${serials.indexOf(s) + 1})`, d === 0 ? "일치" : "유사", () => {
        handleCode(s, false);
        $("ocrCands").innerHTML = "";
      })
    );
  } else {
    $("ocrRaw").textContent += " → 눌러서 입력칸에 넣은 뒤 확인하고 [등록]";
    tokens.slice(0, 4).forEach((t) =>
      addCandidate(t, "입력칸으로", () => {
        $("manualInput").value = t;
        $("manualInput").focus();
      })
    );
  }
  feedback("warn");
}

// ===== 라벨 만들기 =====
$("labelFromList").addEventListener("click", () => {
  $("labelText").value = serials.join("\n");
});
$("labelClear").addEventListener("click", () => {
  $("labelText").value = "";
  $("labelSheet").innerHTML = "";
  $("labelActions").hidden = true;
});
$("labelMake").addEventListener("click", makeLabels);
$("labelPrint").addEventListener("click", () => window.print());

// ZXing이 만든 SVG를 크기 조절이 가능하도록 정리
function cleanSvg(svg) {
  return svg
    .replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>|<desc>[^<]*<\/desc>/g, "")
    .replace(/<svg width="(\d+)" height="(\d+)"/, '<svg viewBox="0 0 $1 $2" shape-rendering="crispEdges"');
}

async function makeLabels() {
  const texts = [...new Set($("labelText").value.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean))];
  const sheet = $("labelSheet");
  sheet.innerHTML = "";
  if (!texts.length) {
    $("labelActions").hidden = true;
    return;
  }
  try {
    await zxingReady;
  } catch {
    $("labelCount").textContent = "코드 생성 엔진을 불러오지 못했습니다 (zxing_full.wasm 업로드 확인)";
    $("labelActions").hidden = false;
    return;
  }

  const format = $("labelFormat").value;
  const showText = $("labelShowText").checked;
  sheet.style.setProperty("--code-size", `${$("labelSize").value}mm`);
  const failed = [];
  for (const t of texts) {
    const r = await ZXingWASM.writeBarcode(t, { format, withQuietZones: false });
    if (r.error || !r.svg) {
      failed.push(t);
      continue;
    }
    const cell = document.createElement("div");
    cell.className = "label";
    const code = document.createElement("div");
    code.className = "label-code";
    code.innerHTML = cleanSvg(r.svg);
    cell.appendChild(code);
    if (showText) {
      const p = document.createElement("div");
      p.className = "label-text";
      p.textContent = t;
      cell.appendChild(p);
    }
    sheet.appendChild(cell);
  }
  $("labelCount").textContent = `${texts.length - failed.length}개 생성` +
    (failed.length ? ` · 실패 ${failed.length}개 (${failed.join(", ")})` : "");
  $("labelActions").hidden = false;
}

// ===== 오프라인 앱(PWA) =====
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js")
    .then(() => navigator.serviceWorker.ready)
    .then(() => { $("offlineTag").hidden = false; })
    .catch((err) => console.warn("서비스 워커 등록 실패", err));
}

let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  $("installBtn").hidden = false;
});
$("installBtn").addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $("installBtn").hidden = true;
});
window.addEventListener("appinstalled", () => { $("installBtn").hidden = true; });

// ===== 초기화 =====
load();
setMode("register");
