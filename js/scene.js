/* VRM の表示（操作画面のプレビューと出力画面で共通）。
   操作画面から届く「目標の姿勢」に向かって毎フレームなめらかに近づけて描く。 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '../vendor/three-vrm.module.min.js';

export const EXPRESSIONS = ['blink', 'blinkLeft', 'blinkRight', 'aa', 'ih', 'ou', 'ee', 'oh', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
const ANGLES = ['headX', 'headY', 'headZ', 'leanZ', 'twistY', 'lookYaw', 'lookPitch'];
// 腕の向き（キャラクターから見た方向。+X＝キャラの左、+Y＝上、+Z＝前）。下ろした腕を基本にする。
export const REST = {
  L: { up: new THREE.Vector3(0.42, -0.9, 0.06).normalize(), low: new THREE.Vector3(0.28, -0.9, 0.3).normalize() },
  R: { up: new THREE.Vector3(-0.42, -0.9, 0.06).normalize(), low: new THREE.Vector3(-0.28, -0.9, 0.3).normalize() },
};
export const neutralState = () => ({ expr: {}, headX: 0, headY: 0, headZ: 0, leanZ: 0, twistY: 0, lookYaw: 0, lookPitch: 0, arms: { L: null, R: null }, breath: true });

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3(), _q3 = new THREE.Quaternion();
const X_POS = new THREE.Vector3(1, 0, 0), X_NEG = new THREE.Vector3(-1, 0, 0);

export class VRMView {
  constructor(canvas, { controls = false, fixed = null } = {}) {
    this.canvas = canvas; this.fixed = fixed;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(fixed ? 1 : Math.min(2, window.devicePixelRatio || 1));
    if (fixed) r.setSize(fixed[0], fixed[1], false);
    this.scene = new THREE.Scene();
    this.bg = '#00ff00'; this.scene.background = new THREE.Color(this.bg);
    this.camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.05, 50);
    this.camera.position.set(0, 1.3, 1.4);
    const light = new THREE.DirectionalLight(0xffffff, Math.PI); light.position.set(0.6, 1, 1.4).normalize(); this.scene.add(light);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    this.target = new THREE.Vector3(0, 1.3, 0);
    if (controls) {
      const c = this.controls = new OrbitControls(this.camera, canvas);
      c.enableDamping = true; c.dampingFactor = 0.15; c.screenSpacePanning = true;
      c.minDistance = 0.25; c.maxDistance = 12; c.zoomSpeed = 0.8; c.rotateSpeed = 0.7;
      c.target.copy(this.target);
      c.addEventListener('change', () => { this.onViewChange && this.onViewChange(); });
    }
    this.camera.lookAt(this.target);
    this.vrm = null; this.modelRotY = 0;
    this.goal = neutralState(); this.cur = neutralState(); this.cur.arms = this._restArms(); this.goalArms = this._restArms();
    this.clock = new THREE.Clock(); this.t = 0;
    this.onFrame = null;
    this._loop = this._loop.bind(this); requestAnimationFrame(this._loop);
  }
  _restArms() { return { L: { up: REST.L.up.clone(), low: REST.L.low.clone() }, R: { up: REST.R.up.clone(), low: REST.R.low.clone() } }; }

  resize() {
    if (this.fixed) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const pr = this.renderer.getPixelRatio();
    if (this.canvas.width !== Math.round(w * pr) || this.canvas.height !== Math.round(h * pr)) this.renderer.setSize(w, h, false);
  }
  setBg(color) { this.bg = color; this.scene.background = new THREE.Color(color); }
  /* 視点：カメラの位置・注視点・画角。出力画面に同じ値を送れば同じ構図になる */
  getView() {
    const t = this.controls ? this.controls.target : this.target;
    return { pos: this.camera.position.toArray(), target: t.toArray(), fov: this.camera.fov, rotY: this.modelRotY };
  }
  setView(v) {
    if (!v) return;
    this.camera.position.fromArray(v.pos); this.camera.fov = v.fov || 30; this.camera.updateProjectionMatrix();
    (this.controls ? this.controls.target : this.target).fromArray(v.target);
    this.camera.lookAt(this.controls ? this.controls.target : this.target);
    if (this.controls) this.controls.update();
    this.setModelRot(v.rotY || 0);
  }
  setModelRot(deg) { this.modelRotY = deg; if (this.vrm) this.vrm.scene.rotation.y = deg * Math.PI / 180; }
  /* 構図のプリセット：顔／上半身／全身 */
  frame(kind) {
    if (!this.vrm) return;
    const head = this.vrm.humanoid.getNormalizedBoneNode('head');
    this.vrm.scene.updateMatrixWorld(true);
    const hp = head.getWorldPosition(new THREE.Vector3());
    const top = hp.y + 0.2, dir = new THREE.Vector3(Math.sin(this.modelRotY * Math.PI / 180), 0, Math.cos(this.modelRotY * Math.PI / 180));
    let tgt, h;
    if (kind === 'face') { tgt = new THREE.Vector3(hp.x, hp.y + 0.03, hp.z); h = 0.42; }
    else if (kind === 'full') { tgt = new THREE.Vector3(hp.x, top / 2, hp.z); h = top * 1.15; }
    else { tgt = new THREE.Vector3(hp.x, hp.y - 0.18, hp.z); h = 0.85; }
    const d = h / 2 / Math.tan(this.camera.fov * Math.PI / 360);
    this.camera.position.copy(tgt).addScaledVector(dir, d);
    (this.controls ? this.controls.target : this.target).copy(tgt);
    this.camera.lookAt(tgt); if (this.controls) this.controls.update();
    this.onViewChange && this.onViewChange();
  }

  async load(data) {
    const loader = new GLTFLoader();
    loader.register(p => new VRMLoaderPlugin(p));
    const buf = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
    const gltf = await loader.parseAsync(buf, '');
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('VRMファイルではないようです（.vrm を選んでください）');
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm);                       // 古い形式（VRM0.x）もこちらを向くようにそろえる
    vrm.scene.traverse(o => { o.frustumCulled = false; });
    if (vrm.lookAt) vrm.lookAt.autoUpdate = false;
    if (this.vrm) { this.scene.remove(this.vrm.scene); VRMUtils.deepDispose(this.vrm.scene); }
    this.vrm = vrm; this.scene.add(vrm.scene);
    vrm.scene.rotation.y = this.modelRotY * Math.PI / 180;
    this.hasExpr = new Set(EXPRESSIONS.filter(n => vrm.expressionManager && vrm.expressionManager.getExpression(n)));
    this._applyPose(this.cur, 0); vrm.update(0);
    const m = vrm.meta || {};
    return { name: m.name || m.title || '', authors: m.authors ? m.authors.join(', ') : (m.author || ''), version: m.metaVersion || '', expr: [...this.hasExpr] };
  }

  /* 目標の姿勢を受け取る（実際の動きは毎フレームなめらかに近づける） */
  setGoal(s) {
    this.goal = s;
    for (const side of ['L', 'R']) {
      const a = s.arms && s.arms[side], g = this.goalArms[side];
      if (a) { g.up.fromArray(a.up).normalize(); g.low.fromArray(a.low).normalize(); }
      else { g.up.copy(REST[side].up); g.low.copy(REST[side].low); }
    }
  }

  _loop() {
    requestAnimationFrame(this._loop);
    const dt = Math.min(0.1, this.clock.getDelta()); this.t += dt;
    this.resize();
    if (this.controls) this.controls.update();
    if (this.vrm) {
      const k = 1 - Math.exp(-dt * 22), ka = 1 - Math.exp(-dt * 14);
      const c = this.cur, g = this.goal;
      for (const a of ANGLES) c[a] += ((g[a] || 0) - c[a]) * k;
      for (const n of EXPRESSIONS) { const v = (g.expr && g.expr[n]) || 0; c.expr[n] = (c.expr[n] || 0) + (v - (c.expr[n] || 0)) * (n.startsWith('blink') ? 0.6 : k); }
      for (const side of ['L', 'R']) { c.arms[side].up.lerp(this.goalArms[side].up, ka).normalize(); c.arms[side].low.lerp(this.goalArms[side].low, ka).normalize(); }
      this._applyPose(c, this.t);
      this.vrm.update(dt);
    }
    this.onFrame && this.onFrame(dt);
    if (!window.__NO_RENDER) this.renderer.render(this.scene, this.camera);
  }

  _applyPose(c, t) {
    const vrm = this.vrm, H = vrm.humanoid, node = n => H.getNormalizedBoneNode(n);
    const set = (n, x, y, z) => { const b = node(n); if (b) b.quaternion.setFromEuler(_e.set(x, y, z, 'YXZ')); };
    const D = Math.PI / 180, br = this.goal.breath === false ? 0 : Math.sin(t * 2 * Math.PI / 4.2);
    // 体：傾き（左右）とひねり。背骨と胸に分けて少しずつ曲げると自然に見える
    set('spine', br * 0.6 * D, c.twistY * 0.3 * D, c.leanZ * 0.5 * D);
    set('chest', -br * 0.9 * D, c.twistY * 0.4 * D, c.leanZ * 0.3 * D);
    if (node('upperChest')) set('upperChest', 0, c.twistY * 0.3 * D, c.leanZ * 0.2 * D);
    // 頭：首に4割、頭に6割（体をひねった分は差し引く）
    const hy = c.headY - c.twistY;
    set('neck', c.headX * 0.4 * D, hy * 0.4 * D, c.headZ * 0.4 * D - c.leanZ * 0.5 * D);
    set('head', c.headX * 0.6 * D, hy * 0.6 * D, c.headZ * 0.6 * D - c.leanZ * 0.5 * D);
    // 腕：向き（ベクトル）から回転を求める
    for (const side of ['L', 'R']) {
      const pre = side === 'L' ? 'left' : 'right', rest = side === 'L' ? X_POS : X_NEG;
      const up = node(pre + 'UpperArm'), low = node(pre + 'LowerArm'), hand = node(pre + 'Hand');
      if (!up || !low) continue;
      const a = c.arms[side];
      this._aim(up, rest, a.up); this._aim(low, rest, a.low);
      if (hand) hand.quaternion.identity();
    }
    // 表情
    const em = vrm.expressionManager;
    if (em) for (const n of this.hasExpr) em.setValue(n, Math.max(0, Math.min(1, c.expr[n] || 0)));
    if (vrm.lookAt) { vrm.lookAt.yaw = c.lookYaw; vrm.lookAt.pitch = c.lookPitch; }
  }
  /* 骨の向きを、キャラクターから見た方向 dir に向ける（体の回転を差し引いて親からの回転にする） */
  _aim(bone, restDir, dir) {
    const want = _q.setFromUnitVectors(restDir, _v.copy(dir));
    bone.parent.updateWorldMatrix(true, false);
    const parentQ = bone.parent.getWorldQuaternion(_q2);
    parentQ.premultiply(_q3.copy(this.vrm.scene.quaternion).invert());           // キャラの向きを変えても腕の向きは体基準のまま
    bone.quaternion.copy(parentQ.invert().multiply(want));
  }
}
