/* 出力画面：1920×1080 で VRM を描く。操作画面から BroadcastChannel で姿勢・構図・背景色を受け取る。 */
import { VRMView } from './scene.js';
const ch = new BroadcastChannel(CHANNEL);
const ID = Math.random().toString(36).slice(2);
const hint = document.getElementById('hint');
const view = new VRMView(document.getElementById('cv'), { fixed: [1920, 1080] });
window.__stage = view;
let ver = -1, loading = null, pendingView = null;

async function loadModel(v) {
  if (v === ver || !v) return;
  ver = v;
  const p = loading = (async () => {
    const saved = await fileGet('vrm');
    if (!saved || !saved.blob) return;
    await view.load(saved.blob);
    if (pendingView) view.setView(pendingView);
  })();
  try { await p; } catch (e) { console.error(e); showHint('モデルを読み込めませんでした'); ver = -1; }
}
ch.onmessage = ev => {
  const m = ev.data; if (!m) return;
  if (m.type === 'model') loadModel(m.ver);
  else if (m.type === 'view') { pendingView = m.view; view.setView(m.view); if (m.bg) { view.setBg(m.bg); document.body.style.background = m.bg; } }
  else if (m.type === 'state') view.setGoal(m.state);
  else if (m.type === 'who') hello();
};
function hello() { ch.postMessage({ type: 'hello', role: 'stage', id: ID }); }

let hintTimer = 0;
function showHint(text) {
  hint.textContent = text || 'ダブルクリックで全画面表示（Esc で解除）';
  hint.classList.remove('hide'); clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hint.classList.add('hide'), 8000);
}
function goFull() { if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {}); }
document.addEventListener('dblclick', goFull);
document.addEventListener('keydown', e => { if (e.key === 'f' || e.key === 'F') goFull(); });
document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) hint.classList.add('hide'); else showHint(); });
let curTimer = 0;
document.addEventListener('mousemove', () => {
  document.body.classList.remove('nocursor'); clearTimeout(curTimer);
  curTimer = setTimeout(() => document.body.classList.add('nocursor'), 2000);
});
showHint();
setInterval(() => ch.postMessage({ type: 'hb', role: 'stage', id: ID }), 1000);
hello();
// 操作画面より先に開いた場合にそなえて、保存済みのモデルを読み込んでおく
fileGet('vrm').then(s => { if (s && s.ver && ver === -1) loadModel(s.ver); }).catch(() => {});
