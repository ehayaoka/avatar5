/* 操作画面：カメラで顔と上半身の動きを読み取り、VRM の表情・頭・体・腕を動かす。 */
import { FilesetResolver, FaceLandmarker, PoseLandmarker, HandLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';
import { VRMView, neutralState } from './scene.js';

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const R2D = 180 / Math.PI;
const LS_KEY = 'vrmavatar.settings.v1';
const ch = new BroadcastChannel(CHANNEL);

/* ---------- 設定（このブラウザに保存） ---------- */
const DEFAULT_THR = { blink: 0.35, mouth: 0.08, ou: 0.4, happy: 0.35, angry: 0.2, troubled: 0.22, surprised: 0.35 };
const DEFAULTS = {
  thr: { ...DEFAULT_THR }, base: null, baseX: null, holdMs: 120,
  bg: '#00ff00', view: null, rotY: 0, head: 1, body: 1, smooth: 0.35,
  usePose: true, useHands: true, useGaze: true, wink: false, mirror: true, monitor: true, camId: '',
};
let S = load();
function load() {
  let s = {}; try { s = JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) {}
  return { ...DEFAULTS, ...s, thr: { ...DEFAULTS.thr, ...(s.thr || {}) } };
}
let saveTimer = 0;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {} }, 300); };

/* ---------- 通知 ---------- */
let toastTimer = 0;
function toast(msg, isErr) {
  const t = $('#toast'); t.textContent = msg; t.className = isErr ? 'err' : '';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hide'), isErr ? 8000 : 3500);
}
function pill(id, text, kind) { const p = $(id); p.textContent = text; p.className = 'pill ' + kind; }

/* ---------- 3D表示（プレビュー） ---------- */
const view = new VRMView($('#cv'), { controls: true });
window.__view = view;
let viewTimer = 0;
view.onViewChange = () => {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { S.view = view.getView(); save(); }, 300);
  sendView();
};
let lastViewSent = 0;
function sendView() {
  const now = performance.now(); if (now - lastViewSent < 30) return; lastViewSent = now;
  ch.postMessage({ type: 'view', view: view.getView(), bg: S.bg });
}

/* ---------- VRMモデル ---------- */
let modelInfo = null, modelVer = 0;
async function useModel(blob, name, { store = true } = {}) {
  $('#modelInfo').textContent = '読み込み中…';
  try {
    const info = await view.load(blob);
    modelInfo = { ...info, file: name };
    if (store) { modelVer = Date.now(); await filePut('vrm', { blob, name, ver: modelVer }); }
    ch.postMessage({ type: 'model', ver: modelVer });
    renderModelInfo();
    if (S.view) view.setView({ ...S.view, rotY: S.rotY }); else view.frame('bust');
    sendView();
    return true;
  } catch (e) {
    console.error(e); toast('VRMを読み込めませんでした：' + e.message, true); renderModelInfo(); return false;
  }
}
function renderModelInfo() {
  const box = $('#modelInfo');
  if (!modelInfo) { box.textContent = 'モデルが読み込まれていません'; return; }
  const miss = ['blink', 'aa', 'happy', 'angry', 'sad', 'surprised'].filter(n => !modelInfo.expr.includes(n));
  box.innerHTML = '';
  box.append(el('b', '', modelInfo.name || modelInfo.file || '（名前なし）'));
  if (modelInfo.authors) box.append(el('span', 'muted', `　作者：${modelInfo.authors}`));
  if (miss.length) box.append(el('div', 'warnline', `⚠ このモデルには ${miss.join('・')} の表情がありません（その表情は変化しません）`));
}
async function loadSample() {
  $('#modelInfo').textContent = 'サンプルをダウンロード中…（約20MB）';
  try {
    const r = await fetch(window.__TEST_SAMPLE || 'samples/lily_hat.vrm'); if (!r.ok) throw new Error('サンプルのファイルが見つかりません');
    const b = await r.blob(); await useModel(b, 'lily_hat.vrm');
  } catch (e) { toast(e.message, true); renderModelInfo(); }
}
async function openFile(file) {
  if (!file) return;
  if (!/\.(vrm|glb)$/i.test(file.name)) { toast('「.vrm」のファイルを選んでください。', true); return; }
  if (await useModel(file, file.name)) toast(`「${file.name}」を読み込みました。`);
}

/* ---------- 出力画面との通信 ---------- */
let lastStageSeen = 0;
ch.onmessage = ev => {
  const m = ev.data; if (!m) return;
  if (m.type === 'hb' || m.type === 'hello') lastStageSeen = Date.now();
  if (m.type === 'hello') { ch.postMessage({ type: 'model', ver: modelVer }); lastViewSent = 0; sendView(); }
};
setInterval(() => { const ok = Date.now() - lastStageSeen < 2500; pill('#stageStatus', ok ? '出力画面：接続中' : '出力画面：未接続', ok ? 'ok' : 'ng'); }, 1000);

/* ---------- 顔・上半身の判定（MediaPipe） ---------- */
let faceLM = null, poseLM = null, handLM = null, stream = null, running = false;
const video = $('#video');
async function initModel() {
  pill('#camStatus', '判定：準備中…', 'wait');
  const fs = await FilesetResolver.forVisionTasks(new URL('../vendor/mediapipe/wasm', import.meta.url).href);
  const mk = async (Cls, file, extra) => {
    const opts = delegate => ({ baseOptions: { modelAssetPath: new URL('../vendor/mediapipe/' + file, import.meta.url).href, delegate }, runningMode: 'VIDEO', ...extra });
    if (window.__MP_CPU) return Cls.createFromOptions(fs, opts('CPU'));   // 動作確認用
    try { return await Cls.createFromOptions(fs, opts('GPU')); }
    catch (e) { console.warn('GPU が使えないため CPU で動かします', e); return Cls.createFromOptions(fs, opts('CPU')); }
  };
  faceLM = await mk(FaceLandmarker, 'face_landmarker.task', { numFaces: 1, outputFaceBlendshapes: true });
  try { poseLM = await mk(PoseLandmarker, 'pose_landmarker_lite.task', { numPoses: 1 }); }
  catch (e) { console.warn('上半身の判定を使えません', e); poseLM = null; }
  try { handLM = await mk(HandLandmarker, 'hand_landmarker.task', { numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 }); }
  catch (e) { console.warn('手の判定を使えません', e); handLM = null; }
  pill('#camStatus', '判定：カメラ停止中', 'wait');
  $('#btnCam').disabled = false;
}
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('このページではカメラを使えません。https:// で始まるURLから開いてください。', true); return; }
  stopCamera();
  const v = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } };
  if (S.camId) v.deviceId = { exact: S.camId }; else v.facingMode = 'user';
  try { stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false }); }
  catch (e) {
    if (S.camId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) { S.camId = ''; save(); return startCamera(); }
    const msg = { NotAllowedError: 'カメラの使用が許可されていません。アドレスバーのカメラのマークから「許可」にしてください。',
      NotFoundError: 'カメラが見つかりません。', NotReadableError: 'カメラを開けません。Zoom など、ほかのアプリがカメラを使っていないか確認してください。' }[e.name];
    toast(msg || 'カメラを開けませんでした：' + e.message, true); return;
  }
  video.srcObject = stream; await video.play().catch(() => {});
  running = true; judge.reset(); lastSeen = performance.now();
  $('#btnCam').textContent = '■ カメラ停止'; $('#btnCam').classList.remove('primary');
  listCameras();
}
function stopCamera() {
  running = false; T.face = false; T.arms = { L: null, R: null }; T.body = false; T.hands = { L: null, R: null };
  if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null;
  $('#btnCam').textContent = '▶ カメラ開始'; $('#btnCam').classList.add('primary');
  if (faceLM) pill('#camStatus', '判定：カメラ停止中', 'wait');
  $('#monLabel').textContent = 'カメラ停止中'; $('#monLabel').className = '';
  og.clearRect(0, 0, ov.width, ov.height);
}
async function listCameras() {
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const sel = $('#selCam'); sel.textContent = '';
    const o0 = el('option', '', '標準のカメラ'); o0.value = ''; sel.append(o0);
    cams.forEach((d, i) => { if (!d.deviceId) return; const o = el('option', '', d.label || `カメラ ${i + 1}`); o.value = d.deviceId; sel.append(o); });
    sel.value = cams.some(d => d.deviceId === S.camId) ? S.camId : '';
  } catch (e) {}
}

/* ---------- 判定結果 → 動きの目標 ---------- */
const judge = new DETECT.Judge();
const BASE0 = { ...DETECT.DEFAULT_BASE, blink: 0.12, pucker: 0.05, funnel: 0.02 };
const BX0 = { roll: 0, yaw: 0, pitch: 0.48, cx: 0.5, cy: 0.45, gh: 0, gv: 0, earL: 0.28, earR: 0.28, sTilt: 0, sMid: 0.5, sTwist: 0 };
// T：いまの判定結果（ガイドと出力のもと）
const T = { face: false, body: false, f: null, sc: null, r: null, ratio: {}, out: neutralState(), arms: { L: null, R: null }, hands: { L: null, R: null }, handPts: [], raw: {} };
let lastVideoTime = -1, lastTs = 0, lastSeen = 0, manual = null, calib = null, frames = 0, fpsT = performance.now();
const D = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function blendFeatures(b) {
  const f = DETECT.features(b);
  f.blink = ((b.eyeBlinkLeft || 0) + (b.eyeBlinkRight || 0)) / 2;
  f.pucker = b.mouthPucker || 0; f.funnel = b.mouthFunnel || 0;
  return f;
}
/* 頭の向き：両目の外側と鼻先の位置関係から求める（カメラ映像の縦横比をそろえるため画素の座標で計算） */
function headPose(lm, vw, vh) {
  const L = [lm[33].x * vw, lm[33].y * vh], R = [lm[263].x * vw, lm[263].y * vh], N = [lm[1].x * vw, lm[1].y * vh];
  const ex = R[0] - L[0], ey = R[1] - L[1], ed = Math.hypot(ex, ey) || 1e-3;
  const mx = (L[0] + R[0]) / 2, my = (L[1] + R[1]) / 2;
  return { roll: Math.atan2(ey, ex) * R2D, yaw: ((N[0] - mx) * ex + (N[1] - my) * ey) / ed / ed, pitch: (-(N[0] - mx) * ey + (N[1] - my) * ex) / ed / ed };
}
/* 顔の点から：顔の位置、黒目の位置（目線）、目の開き（左右別） */
function faceGeom(lm, vw, vh) {
  const P = i => [lm[i].x * vw, lm[i].y * vh];
  const R1 = P(33), R2 = P(133), L1 = P(362), L2 = P(263);
  const ex = [L2[0] - R1[0], L2[1] - R1[1]], el_ = Math.hypot(ex[0], ex[1]) || 1, ux = [ex[0] / el_, ex[1] / el_], uy = [-ux[1], ux[0]];
  const g = { cx: (lm[33].x + lm[263].x) / 2, cy: (lm[33].y + lm[263].y) / 2, earR: D(P(159), P(145)) / (D(R1, R2) || 1), earL: D(P(386), P(374)) / (D(L1, L2) || 1), gh: 0, gv: 0, iris: null };
  if (lm.length >= 478) {
    const c = s => { let x = 0, y = 0; for (let i = s; i < s + 5; i++) { x += lm[i].x * vw; y += lm[i].y * vh; } return [x / 5, y / 5]; };
    const i1 = c(468), i2 = c(473), mR = [(R1[0] + R2[0]) / 2, (R1[1] + R2[1]) / 2], mL = [(L1[0] + L2[0]) / 2, (L1[1] + L2[1]) / 2];
    // どちらの黒目がどちらの目か、近いほうで決める
    const [iR, iL] = D(i1, mR) + D(i2, mL) <= D(i1, mL) + D(i2, mR) ? [i1, i2] : [i2, i1];
    const off = (ir, m, w) => [((ir[0] - m[0]) * ux[0] + (ir[1] - m[1]) * ux[1]) / w, ((ir[0] - m[0]) * uy[0] + (ir[1] - m[1]) * uy[1]) / w];
    const a = off(iR, mR, D(R1, R2) || 1), b = off(iL, mL, D(L1, L2) || 1);
    g.gh = (a[0] + b[0]) / 2; g.gv = (a[1] + b[1]) / 2; g.iris = [iR, iL];
  }
  return g;
}
/* 上半身の点から：肩の傾き・ひねり、腕の向き */
const VIS = (p, v = 0.65) => p && (p.visibility ?? 1) > v && p.x > 0.01 && p.x < 0.99 && p.y > 0.01 && p.y < 0.97;
function bodyGeom(lm, wl, vw, vh) {
  const sL = lm[11], sR = lm[12];
  if (!VIS(sL, 0.6) || !VIS(sR, 0.6)) return null;
  const tilt = Math.atan2((sL.y - sR.y) * vh, (sL.x - sR.x) * vw) * R2D;
  const twist = wl ? Math.atan2(wl[11].z - wl[12].z, wl[11].x - wl[12].x) * R2D : 0;
  const mid = (sL.x + sR.x) / 2, sw = Math.abs(sL.x - sR.x) * vw;
  // 腕（人の左＝L）。手首が見えないときは、ひじまでの向きから自然に曲げる
  const arm = (s, e, w) => {
    if (!wl || !VIS(lm[e], 0.7)) return null;
    const v = (a, b) => [wl[b].x - wl[a].x, wl[b].y - wl[a].y, wl[b].z - wl[a].z];
    const up = v(s, e), low = VIS(lm[w], 0.6) ? v(e, w) : null;
    const raise = ((lm[s].y - (low ? lm[w].y : lm[e].y)) * vh) / (sw || 1);
    return { up, low, raise };
  };
  return { tilt, twist, mid, L: arm(11, 13, 15), R: arm(12, 14, 16), sL, sR };
}

/* 手：指の曲がり（関節ごとの角度）と、手首の向き（指先の方向・手のひらの向き） */
const HAND_CONN = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const len3 = v => Math.hypot(v[0], v[1], v[2]) || 1e-6;
const ang3 = (u, v) => Math.acos(clamp((u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / len3(u) / len3(v), -1, 1)) * R2D;
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function fingerCurls(w) {
  const c = [];
  // 親指：付け根は「親指の先が小指の付け根に近づいた度合い」、中・先は関節の角度
  const palm = len3(sub(w[5], w[17])), r = len3(sub(w[4], w[17])) / palm;
  c.push(clamp((1.6 - r) / 1.0, 0, 1) * 45, clamp(ang3(sub(w[2], w[1]), sub(w[3], w[2])) - 10, 0, 70), clamp(ang3(sub(w[3], w[2]), sub(w[4], w[3])) - 5, 0, 80));
  for (const b of [5, 9, 13, 17]) {
    c.push(clamp(ang3(sub(w[b], w[0]), sub(w[b + 1], w[b])) - 8, 0, 95),
           clamp(ang3(sub(w[b + 1], w[b]), sub(w[b + 2], w[b + 1])) - 5, 0, 105),
           clamp(ang3(sub(w[b + 2], w[b + 1]), sub(w[b + 3], w[b + 2])) - 5, 0, 80));
  }
  return c;
}
function handShape(c) {
  const ext = [1, 2, 3, 4].map(i => c[i * 3] + c[i * 3 + 1] < 75), thumb = c[0] < 20 && c[1] + c[2] < 60;
  const n = ext.filter(Boolean).length;
  if (n === 4) return 'パー';
  if (n === 0) return thumb ? 'グッド' : 'グー';
  if (ext[0] && ext[1] && !ext[2] && !ext[3]) return 'ピース';
  if (ext[0] && !ext[1] && !ext[2] && !ext[3]) return '指さし';
  return '指を曲げる';
}
function trackHands(hr, plm, flm, vw, vh) {
  T.handPts = [];
  const got = { L: null, R: null };
  if (hr && hr.landmarks && hr.landmarks.length) {
    const cx = flm ? flm[1].x : 0.5;
    const list = hr.landmarks.map((lm, i) => {
      const wx = lm[0].x, wy = lm[0].y;
      // 人のどちらの手か：上半身の手首に近いほう（見えないときは顔より右か左か。カメラ映像では人の左手が右に映る）
      let side = wx > cx ? 'L' : 'R';
      if (plm && S.usePose) {
        const d = j => (VIS(plm[j], 0.3) ? Math.hypot((plm[j].x - wx) * vw, (plm[j].y - wy) * vh) : 1e9);
        const dl = d(15), dr = d(16);
        if (Math.min(dl, dr) < 1e8) side = dl <= dr ? 'L' : 'R';
      }
      return { lm, w: hr.worldLandmarks[i], side, x: wx };
    });
    if (list.length === 2 && list[0].side === list[1].side) { const [a, b] = list[0].x > list[1].x ? [list[0], list[1]] : [list[1], list[0]]; a.side = 'L'; b.side = 'R'; }
    for (const h of list) {
      const cs = S.mirror ? (h.side === 'L' ? 'R' : 'L') : h.side;   // キャラのどちらの手か
      const mir = S.mirror ? -1 : 1, cv = v => [mir * v[0], -v[1], -v[2]];
      const w = h.w, curl = fingerCurls(w);
      let d = null, n = null;
      if (T.body && T.arms[cs]) {   // 腕が映っているときだけ手首も回す
        d = cv(sub(w[9], w[0]));
        const cr = cross3(cv(sub(w[5], w[0])), cv(sub(w[17], w[0]))), sg = cs === 'L' ? -1 : 1;
        const ln = Math.hypot(...cr) || 1; n = cr.map(x => x * sg / ln);
      }
      got[cs] = { c: curl, d, n, shape: handShape(curl), person: h.side };
      T.handPts.push({ lm: h.lm, cs });
    }
  }
  T.hands = got;
}

function tick() {
  if (running && faceLM && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const ts = Math.max(performance.now(), lastTs + 1); lastTs = ts;
    try {
      const fr = faceLM.detectForVideo(video, ts);
      const pr = S.usePose && poseLM ? poseLM.detectForVideo(video, ts) : null;
      const hr = S.useHands && handLM ? handLM.detectForVideo(video, ts) : null;
      onResult(fr, pr, hr, ts); frames++;
    } catch (e) { console.error(e); }
  }
  const now = performance.now();
  if (now - fpsT > 1000) { $('#fps').textContent = running ? `${Math.round(frames * 1000 / (now - fpsT))}fps` : ''; frames = 0; fpsT = now; }
  publish(now);
}
function onResult(fr, pr, hr, now) {
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
  const bs = fr.faceBlendshapes && fr.faceBlendshapes[0], lm = fr.faceLandmarks && fr.faceLandmarks[0];
  const plm = pr && pr.landmarks && pr.landmarks[0], pwl = pr && pr.worldLandmarks && pr.worldLandmarks[0];
  const body = plm ? bodyGeom(plm, pwl, vw, vh) : null;
  T.bodyGeom = body;
  trackHands(hr, plm, lm, vw, vh);
  if (!bs || !lm) {
    if (now - lastSeen > 300) {
      T.face = false; pill('#camStatus', '判定：顔が見つかりません', 'ng'); $('#monLabel').textContent = '顔が見つかりません'; $('#monLabel').className = 'lost';
      if (now - lastSeen > 1500) judge.reset();
    }
    track(null, null, null, body); drawOverlay(null, plm, body); return;
  }
  lastSeen = now; T.face = true;
  const b = {}; for (const c of bs.categories) b[c.categoryName] = c.score;
  const f = blendFeatures(b), p = headPose(lm, vw, vh), g = faceGeom(lm, vw, vh);
  if (calib) calib.push({ f, p, g, body });
  pill('#camStatus', '判定：動作中', 'ok'); $('#monLabel').className = '';
  track(f, p, g, body);
  drawOverlay(lm, plm, body, g);
}

/* 判定値 → キャラクターの動き（目標値）。人による違いは「いつもの顔」の値を引いて補正する */
const ramp = (r, s = 0.3) => (r < 1 ? 0 : Math.min(1, s + (1 - s) * (r - 1) / 1.2));
function track(f, p, g, body) {
  const o = T.out, mir = S.mirror ? -1 : 1, B = { ...BASE0, ...(S.base || {}) }, X = { ...BX0, ...(S.baseX || {}) };
  const tgt = { expr: {}, headX: 0, headY: 0, headZ: 0, leanZ: 0, twistY: 0, lookYaw: 0, lookPitch: 0 };
  const ratio = {};
  if (f) {
    const sc = DETECT.scores(f, S.base || undefined);
    const r = judge.update(sc, S.thr, performance.now(), S.holdMs); T.r = r; T.sc = sc;
    Object.assign(ratio, r.ratios);
    ratio.mouth = sc.mouth / S.thr.mouth;
    ratio.blink = Math.max(0, f.blink - B.blink) / S.thr.blink;
    // 「う」：怒った顔でも口がすぼまって見えるので、怒りが強いときは弱める
    ratio.ou = Math.max(0, f.pucker - B.pucker) / S.thr.ou * Math.max(0, 1 - (ratio.angry || 0));
    const emo = manual || r.emotion;
    const map = { happy: 'happy', angry: 'angry', troubled: 'sad', surprised: 'surprised' };
    if (map[emo]) tgt.expr[map[emo]] = manual ? 1 : clamp(0.5 + (ratio[emo] - 1) * 0.5, 0.3, 1);
    const aa = ramp(ratio.mouth, 0.25), ou = ramp(ratio.ou, 0.3);
    tgt.expr.aa = aa * (1 - ou * 0.6); tgt.expr.ou = ou;
    tgt.expr.oh = aa > 0.2 ? clamp((f.funnel - B.funnel) / 0.3, 0, 1) * 0.6 : 0;
    // まばたき：ふだんは左右そろえる（ウインクを使う設定のときだけ左右別々）
    const bl = ramp(ratio.blink, 0.5);
    if (S.wink && g) {
      const cL = clamp((X.earL - g.earL) / (X.earL * 0.55), 0, 1), cR = clamp((X.earR - g.earR) / (X.earR * 0.55), 0, 1);
      const a = S.mirror ? cR : cL, c = S.mirror ? cL : cR;   // キャラの左目／右目
      tgt.expr.blinkLeft = Math.max(bl * 0.3, a > 0.5 ? 1 : a); tgt.expr.blinkRight = Math.max(bl * 0.3, c > 0.5 ? 1 : c);
    } else tgt.expr.blink = bl;
    T.blinkOut = Math.max(tgt.expr.blink || 0, tgt.expr.blinkLeft || 0, tgt.expr.blinkRight || 0);
  }
  if (p) {
    const k = S.head;
    const yaw = Math.atan2(p.yaw - X.yaw, 0.45) * R2D, pitch = Math.atan2(p.pitch - X.pitch, 0.55) * R2D, roll = p.roll - X.roll;
    tgt.headY = clamp(mir * yaw * k, -50, 50); tgt.headX = clamp(pitch * k, -35, 35); tgt.headZ = clamp(-mir * roll * k, -35, 35);
  }
  if (g && S.useGaze) {
    tgt.lookYaw = clamp(mir * (g.gh - X.gh) / 0.22 * 25, -25, 25);
    tgt.lookPitch = clamp((g.gv - X.gv) / 0.14 * 15, -15, 15);
    if (Math.abs(tgt.lookYaw) < 3) tgt.lookYaw = 0;
  }
  // 体の傾き・ひねり：上半身が見えていれば肩の線から、見えなければ顔の位置から
  const kb = S.body;
  if (body && S.usePose) {
    const shift = (body.mid - X.sMid) * 60;
    tgt.leanZ = clamp(-mir * ((body.tilt - X.sTilt) + shift) * 0.8 * kb, -25, 25);
    tgt.twistY = clamp(mir * (body.twist - X.sTwist) * 0.8 * kb, -35, 35);
    const arm = (src, dst) => {
      const a = body[src]; if (!a) return null;
      const cv = v => [mir * v[0], -v[1], -v[2] * 0.6];
      const up = cv(a.up), low = a.low ? cv(a.low) : [up[0] * 0.6, up[1] * 0.6 - 0.3, up[2] * 0.6 + 0.5];
      return { up, low, raise: a.raise };
    };
    // 鏡のとき：人の右腕 → キャラの左腕
    const A = { L: arm(S.mirror ? 'R' : 'L'), R: arm(S.mirror ? 'L' : 'R') };
    T.arms = A; T.body = true;
  } else {
    if (g) tgt.leanZ = clamp(-mir * (g.cx - X.cx) * 120 * kb, -20, 20);
    T.arms = { L: null, R: null }; T.body = false;
  }
  if (!f && !p) {   // 顔が見えないときは、ゆっくり正面に戻す
    tgt.leanZ = 0;
  }
  T.ratio = ratio;
  // なめらかにする（設定「なめらかさ」）
  const a = 1 - S.smooth * 0.9;
  for (const kk of ['headX', 'headY', 'headZ', 'leanZ', 'twistY', 'lookYaw', 'lookPitch']) o[kk] += (tgt[kk] - o[kk]) * a;
  const ex = {}; for (const n of new Set([...Object.keys(o.expr), ...Object.keys(tgt.expr)])) {
    const v = tgt.expr[n] || 0, sm = n.startsWith('blink') ? 1 : Math.min(1, a * 1.3);
    ex[n] = (o.expr[n] || 0) + (v - (o.expr[n] || 0)) * sm; if (ex[n] < 0.005) delete ex[n];
  }
  o.expr = ex;
  for (const side of ['L', 'R']) {
    const n = T.arms[side];
    if (!n) { o.arms[side] = null; continue; }
    const prev = o.arms[side];
    const mixv = (pv, nv) => { const r = pv ? pv.map((x, i) => x + (nv[i] - x) * a) : nv.slice(); const l = Math.hypot(...r) || 1; return r.map(x => x / l); };
    o.arms[side] = { up: mixv(prev && prev.up, n.up), low: mixv(prev && prev.low, n.low) };
  }
  smoothHands(a);
}
function smoothHands(a) {
  const o = T.out;
  for (const side of ['L', 'R']) {
    const n = S.useHands ? T.hands[side] : null, prev = o.hands[side];
    if (!n) { o.hands[side] = null; continue; }
    const c = prev ? prev.c.map((x, i) => x + (n.c[i] - x) * Math.min(1, a * 1.3)) : n.c.slice();
    o.hands[side] = { c, d: n.d, n: n.n };
  }
}

/* 出力：顔が見えないとき・カメラ停止中は、自動でまばたきだけする */
let idleBlinkAt = performance.now() + 3000, sentAt = 0;
function publish(now) {
  const o = T.out, faceOk = running && T.face;
  if (!faceOk) {
    const k = 0.08;
    for (const kk of ['headX', 'headY', 'headZ', 'leanZ', 'twistY', 'lookYaw', 'lookPitch']) o[kk] *= (1 - k);
    const ex = {}; for (const n in o.expr) if (!n.startsWith('blink') && o.expr[n] * (1 - k) > 0.01) ex[n] = o.expr[n] * (1 - k);
    if (manual) { const m = { happy: 'happy', angry: 'angry', troubled: 'sad', surprised: 'surprised' }[manual]; if (m) ex[m] = 1; }
    if (now > idleBlinkAt) { ex.blink = 1; if (now > idleBlinkAt + 130) idleBlinkAt = now + 2500 + Math.random() * 3000; }
    o.expr = ex;
    if (!running || !T.body) o.arms = { L: null, R: null };
    if (!running) o.hands = { L: null, R: null };
  }
  const state = { expr: o.expr, headX: o.headX, headY: o.headY, headZ: o.headZ, leanZ: o.leanZ, twistY: o.twistY, lookYaw: o.lookYaw, lookPitch: o.lookPitch, arms: o.arms, hands: o.hands, breath: true };
  view.setGoal(state);
  if (now - sentAt > 30) { sentAt = now; ch.postMessage({ type: 'state', state }); }
  updateGuide();
}

/* 画面が見えているときは描画に合わせ、隠れているときは Worker のタイマーで続ける（出力画面を止めないため） */
const worker = new Worker(URL.createObjectURL(new Blob(['let t=0;onmessage=e=>{clearTimeout(t);t=setTimeout(()=>postMessage(0),e.data)}'], { type: 'text/javascript' })));
let scheduled = false;
function schedule() {
  if (scheduled) return; scheduled = true;
  if (document.hidden) worker.postMessage(33); else requestAnimationFrame(loop);
}
function loop() { scheduled = false; try { tick(); } catch (e) { console.error(e); } schedule(); }
worker.onmessage = loop;
document.addEventListener('visibilitychange', () => { scheduled = false; schedule(); });

/* ---------- カメラ横のガイド（体の動き → キャラクターの変化） ---------- */
const GUIDE = [
  { id: 'blink', act: '目を閉じる', to: 'まばたき', color: '#a3e635' },
  { id: 'mouth', act: '口を開ける', to: '口「あ」', color: '#fb923c' },
  { id: 'ou', act: '口をすぼめる', to: '口「う」', color: '#fdba74' },
  { id: 'happy', act: '口角を上げる', to: '喜び', color: '#facc15' },
  { id: 'angry', act: '眉を寄せる', to: '怒り', color: '#f87171' },
  { id: 'troubled', act: '眉頭だけ上げる', to: '困り', color: '#c084fc' },
  { id: 'surprised', act: '目を見開く', to: '驚き', color: '#38bdf8' },
  { id: 'lookYaw', act: '目だけ動かす', to: '目線', color: '#5eead4', bi: true, max: 25, dir: ['左を見る', '右を見る'] },
  { sep: true },
  { id: 'headY', act: '顔を左右に向ける', to: '左右を向く', color: '#4ade80', bi: true, max: 40, dir: ['左を向く', '右を向く'] },
  { id: 'headX', act: 'うなずく・見上げる', to: '上下を向く', color: '#4ade80', bi: true, max: 30, dir: ['上を向く', '下を向く'] },
  { id: 'headZ', act: '首をかしげる', to: '頭が傾く', color: '#4ade80', bi: true, max: 30, dir: ['左へ傾く', '右へ傾く'] },
  { id: 'leanZ', act: '体を傾ける', to: '体が傾く', color: '#22d3ee', bi: true, max: 20, dir: ['左へ傾く', '右へ傾く'] },
  { id: 'twistY', act: '体をひねる', to: '体が回る', color: '#22d3ee', bi: true, max: 30, dir: ['左へ回る', '右へ回る'], pose: true },
  { id: 'armS', act: '', to: '', color: '#f472b6', arm: 'S' },
  { id: 'armO', act: '', to: '', color: '#f472b6', arm: 'O' },
  { id: 'handS', act: '', to: '', color: '#fbbf24', hand: 'S' },
  { id: 'handO', act: '', to: '', color: '#fbbf24', hand: 'O' },
];
const gEls = {};
function buildGuide() {
  let box = $('#gFace'); $('#gFace').textContent = ''; $('#gBody').textContent = '';
  for (const g of GUIDE) {
    if (g.sep) { box = $('#gBody'); continue; }
    const row = el('div', 'grow' + (g.bi ? ' bi' : '')), d = el('span', 'gd'), dot = el('i'), txt = el('span', '', g.act);
    dot.style.background = g.color; d.append(dot, txt);
    const bar = el('div', 'gb'), fill = el('b'); fill.style.background = g.color; bar.append(fill, el('u'));
    const res = el('span', 'gr', '→ ' + g.to);
    row.append(d, bar, res); box.append(row); gEls[g.id] = { row, fill, res, txt, g };
  }
}
/* 腕の行：鏡のときは「右手を上げる → 画面の右側の腕」のように、見たままの左右で書く */
function armRows() {
  // 画面の右側に見える腕＝キャラの左腕（L）。
  return [{ id: 'armS', hand: S.mirror ? '右手' : '左手', side: 'L' }, { id: 'armO', hand: S.mirror ? '左手' : '右手', side: 'R' }];
}
function updateGuide() {
  const on = running && T.face;
  $('#guide').classList.toggle('off', !running);
  const o = T.out;
  for (const id in gEls) {
    const { row, fill, res, txt, g } = gEls[id];
    let act = false, text = '→ ' + g.to;
    if (g.hand) {
      const sideC = (g.hand === 'S') ? 'L' : 'R', handName = (g.hand === 'S') === S.mirror ? '右手' : '左手';
      txt.textContent = `${handName}の指を曲げる`;
      if (!S.useHands || !handLM) { row.classList.add('na'); fill.style.width = '0'; res.textContent = handLM || !running ? '（オフ）' : '（使えません）'; row.classList.remove('on'); continue; }
      row.classList.remove('na');
      const h = running ? T.hands[sideC] : null;
      const v = h ? clamp([3, 6, 9, 12].reduce((s2, i) => s2 + h.c[i] + h.c[i + 1], 0) / 4 / 170, 0.04, 1) : 0;
      fill.style.left = '0'; fill.style.width = v * 100 + '%';
      act = !!h; text = h ? `✓ ${sideC === 'L' ? '右' : '左'}側の手：${h.shape}` : '→ 指が動く';
    } else if (g.arm) {
      const a = armRows().find(x => x.id === id), tracked = running && T.body && T.arms[a.side];
      txt.textContent = `${a.hand}を上げる`;
      if (!S.usePose) { row.classList.add('na'); fill.style.width = '0'; res.textContent = '（オフ）'; row.classList.remove('on'); continue; }
      row.classList.remove('na');
      const v = tracked ? clamp((T.arms[a.side].raise + 0.6) / 1.6, 0.04, 1) : 0;
      fill.style.left = '0'; fill.style.width = v * 100 + '%';
      act = !!tracked; text = act ? '✓ ' + (a.side === 'L' ? '右' : '左') + '側の腕が動く' : '→ 腕が動く';
    } else if (!g.bi) {
      const v = on ? (T.ratio[id] || 0) : 0;
      fill.style.left = '0'; fill.style.width = Math.min(100, v * 50) + '%';
      if (on) act = id === 'blink' ? (T.blinkOut || 0) > 0.3 : id === 'mouth' ? (o.expr.aa || 0) > 0.15 : id === 'ou' ? (o.expr.ou || 0) > 0.15 : (manual || (T.r && T.r.emotion)) === id;
      text = (act ? '✓ ' : '→ ') + g.to;
    } else {
      if (g.pose && !(S.usePose && T.body)) { row.classList.add('na'); fill.style.width = '0'; res.textContent = '（肩が映ると動く）'; row.classList.remove('on'); continue; }
      row.classList.remove('na');
      // 画面で見た向き：キャラの +X は画面の右
      let val = o[id] || 0;
      if (id === 'headZ' || id === 'leanZ') val = -val;          // +Z回転は画面の左へ傾く
      const v = on || (id === 'leanZ' && running) ? clamp(val / g.max, -1, 1) : 0;
      fill.style.left = (50 + Math.min(0, v) * 50) + '%'; fill.style.width = Math.abs(v) * 50 + '%';
      act = Math.abs(v) > 0.25;
      if (id === 'headX') text = act ? '✓ ' + (v > 0 ? '下を向く' : '上を向く') : '→ ' + g.to;
      else text = act ? '✓ ' + (v > 0 ? g.dir[1] : g.dir[0]) : '→ ' + g.to;
    }
    row.classList.toggle('on', act); res.textContent = text;
  }
  // いまの出力
  const ex = o.expr, names = { happy: '喜び', angry: '怒り', sad: '困り', surprised: '驚き' };
  let emo = '通常'; for (const n in names) if ((ex[n] || 0) > 0.25) emo = names[n];
  const mouth = (ex.aa || 0) > 0.15 ? `口「あ」${Math.round(ex.aa * 100)}%` : (ex.ou || 0) > 0.15 ? '口「う」' : '口 閉';
  $('#gNow').textContent = `${emo}${manual ? '（固定）' : ''}・${mouth}${running && T.body ? '・上半身' : ''}`;
  $('#monLabel').textContent = !running ? 'カメラ停止中' : T.face ? `${emo}・${mouth}` : '顔が見つかりません';
  renderFaceButtons();
}

/* カメラ映像の上に、判定に使っている顔のパーツと肩・腕を色分けして描く */
const LMI = {
  lips: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61],
  innerLips: [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78],
  eyeR: [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7, 33],
  eyeL: [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249, 263],
  browR: [46, 53, 52, 65, 55], browL: [276, 283, 282, 295, 285],
};
const ov = $('#ov'), og = ov.getContext('2d');
function drawOverlay(lm, plm, body, geo) {
  const W = ov.clientWidth, H = ov.clientHeight, dpr = window.devicePixelRatio || 1;
  if (ov.width !== Math.round(W * dpr) || ov.height !== Math.round(H * dpr)) { ov.width = Math.round(W * dpr); ov.height = Math.round(H * dpr); }
  og.setTransform(dpr, 0, 0, dpr, 0, 0); og.clearRect(0, 0, W, H);
  const vw = video.videoWidth || 640, vh = video.videoHeight || 480, k = Math.max(W / vw, H / vh);
  const ox = (W - vw * k) / 2, oy = (H - vh * k) / 2;
  const Q = p => [ox + p.x * vw * k, oy + p.y * vh * k];
  const col = id => GUIDE.find(g => g.id === id).color, dim = 'rgba(255,255,255,.55)';
  // 上半身（肩・腕）
  if (plm && S.usePose && body) {
    const seg = (a, b, c, w) => { const [x1, y1] = Q(plm[a]), [x2, y2] = Q(plm[b]); og.beginPath(); og.moveTo(x1, y1); og.lineTo(x2, y2); og.strokeStyle = c; og.lineWidth = w; og.stroke(); };
    const lean = Math.abs(T.out.leanZ) / 20 > 0.2 || Math.abs(T.out.twistY) / 30 > 0.2;
    seg(11, 12, lean ? col('leanZ') : 'rgba(34,211,238,.5)', lean ? 3 : 2);
    for (const [s, e, w, side] of [[11, 13, 15, 'L'], [12, 14, 16, 'R']]) {
      const tr = !!body[side]; const c = tr ? col('armS') : 'rgba(244,114,182,.35)';
      if (VIS(plm[e], 0.3)) seg(s, e, c, tr ? 3 : 1.5);
      if (tr && body[side].low) seg(e, w, c, 3);
    }
  }
  if (S.useHands) for (const h of T.handPts) {
    og.strokeStyle = col('handS'); og.lineWidth = 2;
    for (const [a1, b1] of HAND_CONN) { const [x1, y1] = Q(h.lm[a1]), [x2, y2] = Q(h.lm[b1]); og.beginPath(); og.moveTo(x1, y1); og.lineTo(x2, y2); og.stroke(); }
    for (const t of [4, 8, 12, 16, 20]) { const [x, y] = Q(h.lm[t]); og.beginPath(); og.arc(x, y, 3, 0, 7); og.fillStyle = col('handS'); og.fill(); }
  }
  if (!lm) return;
  const P = i => Q(lm[i]);
  const line = (idx, color, w) => { og.beginPath(); idx.forEach((i, n) => { const [x, y] = P(i); n ? og.lineTo(x, y) : og.moveTo(x, y); }); og.strokeStyle = color; og.lineWidth = w; og.stroke(); };
  const dot = (p, color, rad) => { const [x, y] = Array.isArray(p) ? p : P(p); og.beginPath(); og.arc(x, y, rad, 0, 7); og.fillStyle = color; og.fill(); };
  const r = T.r, ratios = r ? r.ratios : {};
  const browId = ['angry', 'troubled', 'surprised'].reduce((a, b) => ((ratios[b] || 0) > (ratios[a] || 0) ? b : a));
  const browOn = (ratios[browId] || 0) >= 0.5, browCol = browOn ? col(browId) : dim;
  line(LMI.browR, browCol, 2); line(LMI.browL, browCol, 2);
  const blinkOn = (T.blinkOut || 0) > 0.3;
  const eyeCol = blinkOn ? col('blink') : (ratios.surprised || 0) >= 0.5 && browId === 'surprised' ? col('surprised') : (ratios.angry || 0) >= 0.5 && browId === 'angry' ? col('angry') : dim;
  line(LMI.eyeR, eyeCol, blinkOn ? 2.5 : 1.5); line(LMI.eyeL, eyeCol, blinkOn ? 2.5 : 1.5);
  if (geo && geo.iris && S.useGaze) {
    const gOn = Math.abs(T.out.lookYaw) / 25 > 0.2;
    for (const ir of geo.iris) dot([ox + ir[0] * k, oy + ir[1] * k], gOn ? col('lookYaw') : 'rgba(94,234,212,.6)', 2.5);
  }
  const mOpen = (T.out.expr.aa || 0) > 0.15, ouOn = (T.out.expr.ou || 0) > 0.15;
  line(LMI.lips, mOpen ? col('mouth') : ouOn ? col('ou') : dim, mOpen || ouOn ? 3 : 1.5);
  if (mOpen) line(LMI.innerLips, col('mouth'), 1.5);
  const smileOn = (ratios.happy || 0) >= 0.5;
  dot(61, smileOn ? col('happy') : dim, smileOn ? 5 : 2.5); dot(291, smileOn ? col('happy') : dim, smileOn ? 5 : 2.5);
  // 頭の向き：鼻から伸びる矢印
  const [nx, ny] = P(1), [x1, y1] = P(33), [x2, y2] = P(263), cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, len = Math.hypot(x2 - x1, y2 - y1) * 0.9;
  og.setLineDash([4, 4]); og.beginPath(); og.moveTo(cx - len, cy); og.lineTo(cx + len, cy); og.strokeStyle = 'rgba(255,255,255,.4)'; og.lineWidth = 1; og.stroke(); og.setLineDash([]);
  const a = Math.atan2(y2 - y1, x2 - x1), tilt = Math.abs(T.out.headZ) / 30 > 0.2;
  og.beginPath(); og.moveTo(cx - Math.cos(a) * len, cy - Math.sin(a) * len); og.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
  og.strokeStyle = tilt ? col('headZ') : 'rgba(74,222,128,.45)'; og.lineWidth = tilt ? 2.5 : 1.5; og.stroke();
  const X = { ...BX0, ...(S.baseX || {}) }, turn = Math.abs(T.out.headY) / 40 > 0.2 || Math.abs(T.out.headX) / 30 > 0.2;
  const ex = nx - (cx + (X.yaw || 0) * (x2 - x1)), ey2 = ny - cy - (X.pitch || 0.65) * len / 0.9 * 1;
  og.beginPath(); og.moveTo(nx, ny); og.lineTo(nx + ex * 2.2, ny + ey2 * 2.2); og.strokeStyle = turn ? col('headY') : 'rgba(74,222,128,.5)'; og.lineWidth = turn ? 3 : 1.5; og.stroke();
  dot(1, turn ? col('headY') : 'rgba(74,222,128,.7)', 4);
}

/* ---------- メーター（判定の強さとしきい値） ---------- */
const METERS = [{ id: 'blink', label: 'まばたき' }, { id: 'mouth', label: '口の開き' }, { id: 'ou', label: '口すぼめ' }, { id: 'happy', label: '喜び' }, { id: 'angry', label: '怒り' }, { id: 'troubled', label: '困り' }, { id: 'surprised', label: '驚き' }];
const SCALE = 0.8;
const meterEls = {};
function buildMeters() {
  const box = $('#meters'); box.textContent = '';
  for (const m of METERS) {
    const row = el('div', 'mrow'), meter = el('div', 'meter'), bar = el('b'), line = el('i');
    meter.append(bar, line);
    const r = el('input'); Object.assign(r, { type: 'range', min: 0.03, max: SCALE, step: 0.01, title: 'しきい値（左ほど反応しやすい）' });
    r.value = S.thr[m.id];
    const place = () => { line.style.left = `calc(${S.thr[m.id] / SCALE * 100}% - 1px)`; };
    r.oninput = () => { S.thr[m.id] = Number(r.value); place(); save(); };
    r.onchange = () => r.blur();
    place();
    row.append(el('span', 'lb', m.label), meter, r); box.append(row);
    meterEls[m.id] = { row, bar, r, place };
  }
}
setInterval(() => {
  for (const m of METERS) {
    const e = meterEls[m.id]; if (!e) continue;
    const v = running && T.face ? (T.ratio[m.id] || 0) * S.thr[m.id] : 0;
    e.bar.style.width = Math.min(100, v / SCALE * 100) + '%';
    e.row.classList.toggle('on', gEls[m.id] ? gEls[m.id].row.classList.contains('on') : false);
  }
}, 80);

/* ---------- いつもの顔を登録 ---------- */
async function calibrate() {
  if (!running) { toast('先に「カメラ開始」を押してください。', true); return; }
  const cd = $('#countdown');
  cd.classList.remove('hide');
  for (const n of [3, 2, 1]) { cd.innerHTML = `${n}<small>正面を向いて、力を抜いた顔と姿勢をしてください</small>`; await sleep(1000); }
  cd.innerHTML = '記録中…<small>そのまま動かないでください</small>';
  calib = []; await sleep(1500);
  const c = calib; calib = null; cd.classList.add('hide');
  if (c.length < 3) { toast('顔がうまく見えませんでした。カメラの正面に顔が入るようにして、もう一度押してください。', true); return; }
  const mean = list => { const o = {}; for (const k of Object.keys(list[0])) if (typeof list[0][k] === 'number') o[k] = list.reduce((s, x) => s + x[k], 0) / list.length; return o; };
  S.base = mean(c.map(x => x.f));
  const p = mean(c.map(x => x.p)), g = mean(c.map(x => x.g)), bs = c.map(x => x.body).filter(Boolean);
  S.baseX = { roll: p.roll, yaw: p.yaw, pitch: p.pitch, cx: g.cx, cy: g.cy, gh: g.gh, gv: g.gv, earL: g.earL, earR: g.earR };
  if (bs.length) { const b = mean(bs); Object.assign(S.baseX, { sTilt: b.tilt, sMid: b.mid, sTwist: b.twist }); }
  save(); judge.reset();
  const B = S.base, odd = B.smile > 0.3 ? '笑顔' : B.jaw > 0.25 ? '口が開いた顔' : B.blink > 0.45 ? '目を閉じた顔' : B.inner - B.outer > 0.2 ? '眉が上がった顔' : B.browDown > 0.2 ? '眉をひそめた顔' : '';
  if (odd) toast(`${odd}のまま登録されたようです。力を抜いた真顔で、もう一度「いつもの顔を登録」を押してください。`, true);
  else toast('いつもの顔と姿勢を登録しました。ガイドを見ながら、顔や体を動かしてみてください。');
}

/* ---------- 表情の固定 ---------- */
const FACES = [['自動', null], ['通常', 'normal'], ['喜び', 'happy'], ['怒り', 'angry'], ['困り', 'troubled'], ['驚き', 'surprised']];
function setManual(id) { manual = id === 'normal' ? 'normal' : id; renderFaceButtons(true); }
function renderFaceButtons(force) {
  const box = $('#faceButtons'); const want = manual || 'auto';
  if (!force && box.dataset.on === want && box.children.length) return;
  box.dataset.on = want; box.textContent = '';
  FACES.forEach(([label, id], i) => { const b = el('button', want === (id || 'auto') ? 'on' : '', label); b.title = `キー ${i}`; b.onclick = () => { setManual(id); b.blur(); }; box.append(b); });
}

/* ---------- 画面の操作 ---------- */
function bindRange(sel, out, get, setv, fmt) {
  const r = $(sel), o = $(out);
  const show = () => { o.textContent = fmt(Number(r.value)); };
  r.value = get(); show();
  r.oninput = () => { setv(Number(r.value)); show(); save(); };
  r.onchange = () => r.blur();
}
function setBg(c) {
  S.bg = c; view.setBg(c); save(); lastViewSent = 0; sendView();
  for (const b of document.querySelectorAll('#bgButtons button')) b.classList.toggle('on', b.dataset.bg === c);
  $('#bgCustom').value = /^#[0-9a-f]{6}$/i.test(c) ? c : '#00ff00';
}
function applyMirror() { $('#monitor').classList.toggle('mirror', S.mirror); }
function applyMonitor() { $('#monitor').classList.toggle('hide', !S.monitor); $('#chkMonitor').checked = S.monitor; }
function togglePanel() { document.body.classList.toggle('nopanel'); $('#btnPanel').textContent = document.body.classList.contains('nopanel') ? '設定を出す' : '設定を隠す'; }
function goFull() { const w = $('#stageWrap'); if (!document.fullscreenElement) w.requestFullscreen().catch(() => {}); else document.exitFullscreen(); }
function openStage() {
  const w = window.open('stage.html', 'vrm-avatar-stage', 'width=960,height=540');
  if (!w) toast('ポップアップがブロックされました。アドレスバー右のアイコンから許可してください。', true);
}

function bindUI() {
  $('#btnCam').onclick = e => { e.target.blur(); running ? stopCamera() : startCamera(); };
  $('#btnOpenStage').onclick = e => { e.target.blur(); openStage(); };
  $('#btnFull').onclick = e => { e.target.blur(); goFull(); };
  $('#btnPanel').onclick = e => { e.target.blur(); togglePanel(); };
  $('#btnCalib').onclick = e => { e.target.blur(); calibrate(); };
  $('#btnResetDetect').onclick = e => {
    e.target.blur(); if (!confirm('しきい値と「いつもの顔」の登録を元に戻します。よろしいですか？')) return;
    S.thr = { ...DEFAULT_THR }; S.base = null; S.baseX = null; save(); buildMeters(); judge.reset();
  };
  bindRange('#rngHold', '#outHold', () => S.holdMs, v => { S.holdMs = v; }, v => `${v}ms`);
  bindRange('#rngHead', '#outHead', () => S.head, v => { S.head = v; }, v => `${Math.round(v * 100)}%`);
  bindRange('#rngBody', '#outBody', () => S.body, v => { S.body = v; }, v => `${Math.round(v * 100)}%`);
  bindRange('#rngSmooth', '#outSmooth', () => S.smooth, v => { S.smooth = v; }, v => `${Math.round(v * 100)}%`);
  bindRange('#rngRot', '#outRot', () => S.rotY, v => { S.rotY = v; view.setModelRot(v); lastViewSent = 0; sendView(); }, v => `${v}°`);
  for (const [id, key, fn] of [['#chkPose', 'usePose'], ['#chkHands', 'useHands'], ['#chkGaze', 'useGaze'], ['#chkWink', 'wink'], ['#chkMirror', 'mirror', applyMirror], ['#chkMonitor', 'monitor', applyMonitor]]) {
    const c = $(id); c.checked = S[key];
    c.onchange = () => { S[key] = c.checked; save(); fn && fn(); c.blur(); };
  }
  for (const b of document.querySelectorAll('#bgButtons button')) b.onclick = () => { setBg(b.dataset.bg); b.blur(); };
  $('#bgCustom').oninput = e => setBg(e.target.value);
  for (const b of document.querySelectorAll('[data-frame]')) b.onclick = () => { view.frame(b.dataset.frame); b.blur(); };
  $('#btnFront').onclick = e => { e.target.blur(); S.rotY = 0; $('#rngRot').value = 0; $('#outRot').textContent = '0°'; view.setModelRot(0); view.frame('bust'); };
  $('#selCam').onchange = e => { S.camId = e.target.value; save(); e.target.blur(); if (running) startCamera(); };
  $('#btnFile').onclick = e => { e.target.blur(); $('#fileVrm').click(); };
  $('#fileVrm').onchange = e => { const f = e.target.files[0]; e.target.value = ''; openFile(f); };
  $('#btnSample').onclick = e => { e.target.blur(); loadSample(); };
  const wrap = $('#stageWrap');
  wrap.addEventListener('dragover', e => { e.preventDefault(); wrap.classList.add('drag'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drag'));
  wrap.addEventListener('drop', e => { e.preventDefault(); wrap.classList.remove('drag'); openFile(e.dataTransfer.files[0]); });
  window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => e.preventDefault());
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'f') goFull(); else if (k === 'h') togglePanel(); else if (k === 'm') { S.monitor = !S.monitor; save(); applyMonitor(); }
    else if (/^[0-5]$/.test(k)) setManual(FACES[Number(k)][1]);
    else return;
    e.preventDefault();
  });
}

/* ---------- 起動 ---------- */
async function init() {
  if (location.protocol === 'file:') toast('ファイルを直接開くと動きません。Webサーバー上のURL（https://…）から開いてください。', true);
  buildGuide(); buildMeters(); bindUI(); renderFaceButtons(true);
  setBg(S.bg); applyMirror(); applyMonitor();
  view.setModelRot(S.rotY);
  schedule();
  ch.postMessage({ type: 'who' });
  // 前回のモデル（なければサンプル）を読み込む
  let saved = null; try { saved = await fileGet('vrm'); } catch (e) {}
  if (saved && saved.blob) { modelVer = saved.ver || 1; await useModel(saved.blob, saved.name, { store: false }); }
  else await loadSample();
  initModel().catch(e => { console.error(e); pill('#camStatus', '判定：準備に失敗', 'ng'); toast('顔の判定の準備に失敗しました：' + e.message, true); });
}
window.__app = { S, T, calibrate, view, get running() { return running; } };
init().catch(e => { console.error(e); toast('起動に失敗しました：' + e.message, true); });
