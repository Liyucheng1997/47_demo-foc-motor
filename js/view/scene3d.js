/* =========================================================================
   scene3d.js —— Three.js 电机三维模型
   结构：硅钢叠片定子（带齿靴）+ 逐匝建模的集中绕组 + 表贴磁钢转子 + 阶梯转轴
        + 滚珠轴承 + 编码器 + 剖切机壳；支持爆炸图、结构标注、相机预设
   叠加：导体电流 ⊙/⊗、气隙磁场、定子电流矢量、d/q 轴、δ 夹角、三相母线
   ========================================================================= */
(function (FOC) {
'use strict';
const { PI, TAU, wrapPi } = FOC.math;

const PHC = { a: 0xff5d5d, b: 0x36d399, c: 0x5d9bff };
const hexCss = n => '#' + n.toString(16).padStart(6, '0');
const basic = (color, extra = {}) => new THREE.MeshBasicMaterial(Object.assign({ color, depthTest: false, transparent: true, toneMapped: false }, extra));

/* ---------- 文字精灵 ---------- */
function makeLabel(text, o = {}) {
  const fontPx = o.fontPx || 64, pad = o.bg ? fontPx * 0.32 : 6;
  const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
  const font = `${o.weight || 700} ${fontPx}px "Segoe UI","Microsoft YaHei",sans-serif`;
  ctx.font = font;
  const tw = ctx.measureText(text).width;
  cv.width = Math.ceil(tw + pad * 2); cv.height = Math.ceil(fontPx * 1.5);
  ctx.font = font;
  if (o.bg) {
    const r = cv.height / 2 - 2;
    ctx.fillStyle = o.bg; ctx.strokeStyle = o.border || 'rgba(255,255,255,.25)'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(r + 2, 2); ctx.lineTo(cv.width - r - 2, 2); ctx.arc(cv.width - r - 2, cv.height / 2, r, -PI / 2, PI / 2);
    ctx.lineTo(r + 2, cv.height - 2); ctx.arc(r + 2, cv.height / 2, r, PI / 2, PI * 1.5); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  ctx.fillStyle = o.color || '#e6edf3'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, cv.width / 2, cv.height / 2 + fontPx * 0.05);
  const tex = new THREE.CanvasTexture(cv); tex.encoding = THREE.sRGBEncoding; tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false, sizeAttenuation: !o.screen }));
  const h = o.screen ? o.screen : (o.height || 0.42);      // screen：按屏幕高度比例固定大小（不随远近缩放）
  sp.scale.set(h * cv.width / cv.height, h, 1); sp.renderOrder = o.order || 1010;
  return sp;
}
/* 可重绘的文字精灵（固定画布） */
class DynLabel {
  constructor(w, h, height) {
    this.cv = document.createElement('canvas'); this.cv.width = w; this.cv.height = h;
    this.ctx = this.cv.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.cv); this.tex.encoding = THREE.sRGBEncoding;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, depthTest: false, transparent: true, toneMapped: false }));
    this.sprite.scale.set(height * w / h, height, 1); this.sprite.renderOrder = 1012;
    this.last = '';
  }
  set(text, color) {
    const key = text + color; if (key === this.last) return; this.last = key;
    const { ctx, cv } = this;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.font = `700 ${cv.height * 0.56}px "Segoe UI","Microsoft YaHei",sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = cv.height * 0.12; ctx.strokeStyle = 'rgba(8,11,16,.85)';
    ctx.strokeText(text, cv.width / 2, cv.height / 2); ctx.fillStyle = color;
    ctx.fillText(text, cv.width / 2, cv.height / 2);
    this.tex.needsUpdate = true;
  }
}

/* ⊙ / ⊗ 电流符号 */
function makeCurSym() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }));
  sp.renderOrder = 1002; sp.userData = { ctx: cv.getContext('2d'), tex, last: '' };
  return sp;
}
function drawCurSym(sp, out, color, alpha) {
  const ud = sp.userData, key = `${out}|${color}|${Math.round(alpha * 5)}`;
  if (key === ud.last) return; ud.last = key;
  const ctx = ud.ctx; ctx.clearRect(0, 0, 64, 64);
  ctx.globalAlpha = Math.max(0.15, alpha);
  ctx.fillStyle = 'rgba(8,11,16,.75)'; ctx.beginPath(); ctx.arc(32, 32, 26, 0, 7); ctx.fill();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(32, 32, 21, 0, 7); ctx.stroke();
  if (out) { ctx.beginPath(); ctx.arc(32, 32, 7, 0, 7); ctx.fill(); }
  else { ctx.beginPath(); ctx.moveTo(18, 18); ctx.lineTo(46, 46); ctx.moveTo(46, 18); ctx.lineTo(18, 46); ctx.stroke(); }
  ctx.globalAlpha = 1; ud.tex.needsUpdate = true;
}

/* 圆柱连杆（两点之间） */
function rod(p1, p2, rad, mat) {
  const a = new THREE.Vector3(...p1), b = new THREE.Vector3(...p2);
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, 8), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}
/* 平面内的箭头（默认指向 +Y，绕 Z 旋转到角度 a） */
function makeArrow(color, len, rad) {
  const g = new THREE.Group(), mat = basic(color, { opacity: 0.95 });
  const sl = len * 0.78;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, sl, 14), mat); body.position.y = sl / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(rad * 2.6, len * 0.22, 18), mat); head.position.y = sl + len * 0.11;
  body.renderOrder = head.renderOrder = 990;
  g.add(body, head); g.userData.base = len; g.userData.mat = mat;
  return g;
}
function aim(arrow, ang, len) {
  arrow.rotation.z = ang - PI / 2;
  arrow.scale.set(1, Math.max(0.001, len / arrow.userData.base), 1);
}
/* 环形扇区截面拉伸（机壳剖切、磁钢） */
function sectorShape(r0, r1, a0, a1) {
  const s = new THREE.Shape();
  s.absarc(0, 0, r1, a0, a1, false);
  s.absarc(0, 0, r0, a1, a0, true);
  return s;
}

/* ========================================================================= */
class MotorScene {
  constructor(container) {
    this.container = container;
    const R = this.renderer = new THREE.WebGLRenderer({ antialias: true });
    R.setPixelRatio(Math.min(devicePixelRatio, 2));
    R.outputEncoding = THREE.sRGBEncoding;
    R.toneMapping = THREE.ACESFilmicToneMapping; R.toneMappingExposure = 1.0;
    container.appendChild(R.domElement);

    const S = this.scene = new THREE.Scene();
    S.background = new THREE.Color(0x0b0f15);
    if (THREE.RoomEnvironment) {
      const pm = new THREE.PMREMGenerator(R);
      S.environment = pm.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
      pm.dispose();
    }
    S.add(new THREE.HemisphereLight(0xbcd4ff, 0x141820, 0.45));
    const key = new THREE.DirectionalLight(0xffffff, 1.1); key.position.set(6, 9, 8); S.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.6); rim.position.set(-7, 3, -6); S.add(rim);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    this.controls = new THREE.OrbitControls(this.camera, R.domElement);
    this.controls.enableDamping = true; this.controls.minDistance = 5; this.controls.maxDistance = 32;
    this.camAnim = null;
    this.setCamera('iso', true);

    // 地面网格（弱化）
    const grid = new THREE.GridHelper(30, 30, 0x1c2633, 0x141b25);
    grid.position.y = -4.6; grid.material.transparent = true; grid.material.opacity = 0.6; S.add(grid);

    this.mat = {
      lam: new THREE.MeshStandardMaterial({ color: 0x5f6876, metalness: 0.72, roughness: 0.46, envMapIntensity: 0.45 }),
      lamR: new THREE.MeshStandardMaterial({ color: 0x4f5968, metalness: 0.7, roughness: 0.5, envMapIntensity: 0.55 }),
      shaft: new THREE.MeshStandardMaterial({ color: 0xd5dbe3, metalness: 0.95, roughness: 0.16 }),
      bearing: new THREE.MeshStandardMaterial({ color: 0xb7c0cc, metalness: 0.95, roughness: 0.22 }),
      house: new THREE.MeshStandardMaterial({ color: 0x3b4c60, metalness: 0.55, roughness: 0.45, side: THREE.DoubleSide }),
      houseCut: new THREE.MeshStandardMaterial({ color: 0x7a8ba0, metalness: 0.5, roughness: 0.35 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x1d242e, metalness: 0.4, roughness: 0.6 }),
    };

    this.statorG = new THREE.Group(); S.add(this.statorG);
    this.rotorAsm = new THREE.Group(); S.add(this.rotorAsm);        // 爆炸时整体前移
    this.rotorG = new THREE.Group(); this.rotorAsm.add(this.rotorG); // 随转子旋转
    this.housingG = new THREE.Group(); this.housingG.visible = false; S.add(this.housingG);
    this.encG = new THREE.Group(); S.add(this.encG);
    this.ovG = new THREE.Group(); S.add(this.ovG);                  // 定子侧叠加层
    this.rotOv = new THREE.Group(); S.add(this.rotOv);              // 转子侧叠加层（d/q 轴）
    this.labelsG = [];                                               // 结构标注

    this.flags = { housing: false, explode: false, labels: false, bus: true, field: true, current: true, delta: true };
    this.explodeK = 0;
    this.prevRot = 0; this.ballAng = 0;

    this._buildStatic();
    new ResizeObserver(() => this.resize()).observe(container);
  }

  /* ---------- 与方案无关的部件：转轴、轴承、编码器、机壳 ---------- */
  _buildStatic() {
    const D = 1.6, zb = D / 2 + 0.75;
    this.zb = zb; this.FRONT = D / 2 + 0.62;
    // 阶梯转轴在 build() 中按方案的轴径生成
    const zr = -(D / 2 + 1.95), zf = D / 2 + 2.7;
    this.zr = zr; this.zf = zf;
    const key = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.9), this.mat.dark);
    key.position.set(0, 0.32, zf - 0.6); this.rotorG.add(key);       // 键：直观看出轴在转

    // 两个深沟球轴承：外圈静止、内圈随轴、滚珠以保持架转速（≈0.4ω）公转
    this.ballGroups = [];
    const ringProf = (r0, r1, w) => [[r0, -w / 2], [r1, -w / 2], [r1, w / 2], [r0, w / 2], [r0, -w / 2]].map(([r, z]) => new THREE.Vector2(r, z));
    [-zb, zb].forEach(z => {
      const outer = new THREE.Mesh(new THREE.LatheGeometry(ringProf(0.64, 0.78, 0.26), 40), this.mat.bearing);
      outer.rotation.x = PI / 2; outer.position.z = z; this.rotorAsm.add(outer);
      const inner = new THREE.Mesh(new THREE.LatheGeometry(ringProf(0.36, 0.47, 0.26), 40), this.mat.bearing);
      inner.rotation.x = PI / 2; inner.position.z = z; this.rotorG.add(inner);
      const balls = new THREE.Group(); balls.position.z = z;
      for (let k = 0; k < 9; k++) {
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.085, 14, 10), this.mat.shaft);
        b.position.set(Math.cos(k / 9 * TAU) * 0.555, Math.sin(k / 9 * TAU) * 0.555, 0); balls.add(b);
      }
      this.rotorAsm.add(balls); this.ballGroups.push(balls);
    });

    // 编码器：码盘（随轴）+ 读头（静止）
    const zE = -(D / 2 + 1.55);
    this.encG.position.z = zE;
    const cv = document.createElement('canvas'); cv.width = cv.height = 512;
    const c = cv.getContext('2d');
    c.fillStyle = '#1b2633'; c.beginPath(); c.arc(256, 256, 252, 0, 7); c.fill();
    c.strokeStyle = '#9fb3c8'; c.lineWidth = 2;
    for (let k = 0; k < 128; k++) {   // 增量刻线
      const a = k / 128 * TAU; c.beginPath();
      c.moveTo(256 + Math.cos(a) * 205, 256 + Math.sin(a) * 205); c.lineTo(256 + Math.cos(a) * 240, 256 + Math.sin(a) * 240); c.stroke();
    }
    c.fillStyle = '#c8d6e5';
    for (let k = 0; k < 16; k++) if ((k * 7) % 3) { c.beginPath(); c.arc(256, 256, 180, k / 16 * TAU, (k + 0.6) / 16 * TAU); c.arc(256, 256, 160, (k + 0.6) / 16 * TAU, k / 16 * TAU, true); c.fill(); }
    c.fillStyle = '#ffd34d'; c.fillRect(250, 18, 12, 30);              // 零位标记
    c.fillStyle = '#3a4656'; c.beginPath(); c.arc(256, 256, 60, 0, 7); c.fill();
    const tex = new THREE.CanvasTexture(cv); tex.encoding = THREE.sRGBEncoding;
    this.encDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.03, 64),
      [new THREE.MeshStandardMaterial({ color: 0x2a3644, metalness: 0.5, roughness: 0.3 }),
       new THREE.MeshStandardMaterial({ map: tex, metalness: 0.35, roughness: 0.3 }),
       new THREE.MeshStandardMaterial({ map: tex, metalness: 0.35, roughness: 0.3 })]);
    this.encDisc.rotation.x = PI / 2; this.encG.add(this.encDisc);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.34, 0.3), new THREE.MeshStandardMaterial({ color: 0x23303f, metalness: 0.3, roughness: 0.5 }));
    head.position.set(0, 0.92, 0); this.encG.add(head);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff4040, toneMapped: false }));
    led.position.set(0, 1.0, 0.16); this.encG.add(led);

    // 机壳：带 90° 剖切口的厚壁筒 + 散热片 + 后端盖 + 前支架 + 底脚 + 接线盒
    const H = this.housingG, z0 = -(D / 2 + 1.15), z1 = D / 2 + 0.95, Rh = 3.4;
    const cut0 = PI / 2, cut1 = TAU;          // 保留 90°→360°，切掉右上象限
    const shellGeo = new THREE.ExtrudeGeometry(sectorShape(Rh + 0.03, Rh + 0.28, cut0, cut1), { depth: z1 - z0, bevelEnabled: false, curveSegments: 72 });
    shellGeo.translate(0, 0, z0);
    H.add(new THREE.Mesh(shellGeo, [this.mat.house, this.mat.houseCut]));
    for (let k = 0; k < 30; k++) {
      const a = cut0 + 0.06 + (cut1 - cut0 - 0.12) * k / 29;
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.07, z1 - z0 - 0.2), this.mat.house);
      fin.position.set(Math.cos(a) * (Rh + 0.43), Math.sin(a) * (Rh + 0.43), (z0 + z1) / 2); fin.rotation.z = a; H.add(fin);
    }
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(Rh + 0.28, Rh + 0.2, 0.3, 64), this.mat.house);
    bell.rotation.x = PI / 2; bell.position.z = z0 - 0.15; H.add(bell);
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.5, 40), this.mat.house);
    boss.rotation.x = PI / 2; boss.position.z = -zb; H.add(boss);
    const hub = new THREE.Mesh(new THREE.LatheGeometry(ringProf(0.78, 1.0, 0.3), 40), this.mat.house);
    hub.rotation.x = PI / 2; hub.position.z = zb; H.add(hub);
    [PI / 2 + 0.6, PI + 0.9, 1.5 * PI + 0.7].forEach(a => {
      H.add(rod([Math.cos(a) * 0.95, Math.sin(a) * 0.95, zb], [Math.cos(a) * (Rh + 0.1), Math.sin(a) * (Rh + 0.1), zb], 0.09, this.mat.house));
    });
    const foot = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.32, z1 - z0), this.mat.house);
    foot.position.set(0, -(Rh + 0.75), (z0 + z1) / 2); H.add(foot);
    [-1, 1].forEach(s => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.6, z1 - z0 - 0.4), this.mat.house);
      leg.position.set(s * 1.1, -(Rh + 0.4), (z0 + z1) / 2); H.add(leg);
    });
    const jbox = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.8, 1.4), this.mat.house);
    jbox.position.set(Math.cos(PI * 0.72) * (Rh + 0.55), Math.sin(PI * 0.72) * (Rh + 0.55), -0.1); jbox.rotation.z = PI * 0.72 - PI / 2; H.add(jbox);

    // 叠加层：定子电流矢量、d/q 轴、δ
    const F = this.FRONT;
    this.statorVec = makeArrow(0xff4d8d, 3, 0.075); this.statorVec.position.z = F + 0.12; this.ovG.add(this.statorVec);
    this.isLabel = makeLabel('iₛ', { color: '#ff4d8d', height: 0.5 }); this.ovG.add(this.isLabel);
    this.dAxis = makeArrow(0x4dd0e1, 2.5, 0.07); this.dAxis.position.z = F + 0.06;
    this.qAxis = makeArrow(0xff79c6, 2.0, 0.055); this.qAxis.position.z = F + 0.04;
    this.dLabel = makeLabel('d', { color: '#4dd0e1', height: 0.55 });
    this.qLabel = makeLabel('q', { color: '#ff79c6', height: 0.55 });
    this.rotOv.add(this.dAxis, this.qAxis, this.dLabel, this.qLabel);

    this.deltaG = new THREE.Group(); this.ovG.add(this.deltaG);
    this.wedge = new THREE.Mesh(new THREE.CircleGeometry(1.2, 48, 0, 1), basic(0xffd34d, { opacity: 0.22, side: THREE.DoubleSide }));
    this.wedge.position.z = F + 0.02; this.wedge.renderOrder = 940; this.deltaG.add(this.wedge);
    this.deltaLabel = new DynLabel(320, 72, 0.42); this.deltaG.add(this.deltaLabel.sprite);

    // 定子矢量尖端拖尾
    this.trailN = 90; this.trailIdx = 0;
    this.trailPos = new Float32Array(this.trailN * 3);
    const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    this.trail = new THREE.Points(tg, new THREE.PointsMaterial({ color: 0xff4d8d, size: 0.07, transparent: true, opacity: 0.55, depthTest: false, toneMapped: false }));
    this.trail.renderOrder = 985; this.ovG.add(this.trail);

    // 结构标注
    const L = (group, text, anchor, at) => {
      const sp = makeLabel(text, { color: '#e6edf3', bg: 'rgba(17,24,34,.88)', border: 'rgba(255,211,77,.7)', screen: 0.042, fontPx: 48, weight: 600 });
      sp.position.set(...at);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...anchor), new THREE.Vector3(...at)]),
        new THREE.LineBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.8, depthTest: false }));
      line.renderOrder = 1009;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), basic(0xffd34d)); dot.position.set(...anchor);
      const g = new THREE.Group(); g.add(sp, line, dot); g.visible = false; group.add(g); this.labelsG.push(g);
    };
    L(this.rotorAsm, '转轴（阶梯轴 + 键）', [0, 0.3, zf - 0.3], [-1.2, 1.6, zf + 0.3]);
    L(this.rotorAsm, '深沟球轴承', [0.55, -0.55, zb + 0.13], [2.0, -2.0, zb + 1.0]);
    L(this.rotorAsm, '永磁体（钕铁硼，表贴）', [0, 1.85, D / 2], [-0.9, 2.6, D / 2 + 1.7]);
    L(this.rotorAsm, '转子铁芯', [-1.25, -0.4, D / 2], [-2.2, -1.5, D / 2 + 1.4]);
    L(this.encG, '编码器（测转子角 θ）', [-0.7, -0.6, 0], [-2.3, -1.6, -0.5]);
    L(this.housingG, '机壳 + 散热片', [-2.6, 2.6, 0], [-4.4, 3.7, 0.4]);
    this._labelAnchors = { L };
  }

  /* ---------- 随方案重建：叠片、绕组、磁钢、叠加层 ---------- */
  build(design) {
    this.design = design;
    const g = design.g, D = g.depth, F = this.FRONT;
    const kill = grp => { while (grp && grp.children.length) { const c = grp.children.pop(); c.traverse(o => { if (o.geometry) o.geometry.dispose(); }); } };
    [this.lamG, this.coilG, this.curG, this.busG, this.magG, this.gapG, this.phaseLabG, this.statorLab].forEach(kill);
    const mk = parent => { const gg = new THREE.Group(); parent.add(gg); return gg; };
    this.lamG = this.lamG || mk(this.statorG); this.coilG = this.coilG || mk(this.statorG);
    this.curG = this.curG || mk(this.statorG); this.busG = this.busG || mk(this.statorG);
    this.phaseLabG = this.phaseLabG || mk(this.statorG); this.statorLab = this.statorLab || mk(this.statorG);
    this.magG = this.magG || mk(this.rotorG); this.gapG = this.gapG || mk(this.ovG);

    // 1) 定子叠片：同一冲片几何复用 10 片，片间留缝
    const shape = new THREE.Shape(); shape.absarc(0, 0, g.Rout, 0, TAU, false);
    const hole = new THREE.Path(); FOC.machine.statorInnerContour(g, 8).forEach(([x, y], i) => i ? hole.lineTo(x, y) : hole.moveTo(x, y));
    hole.closePath(); shape.holes.push(hole);
    const nLam = 10, pitchZ = D / nLam, tLam = pitchZ * 0.86;
    const lamGeo = new THREE.ExtrudeGeometry(shape, { depth: tLam, bevelEnabled: false, curveSegments: 96 });
    for (let k = 0; k < nLam; k++) { const m = new THREE.Mesh(lamGeo, this.mat.lam); m.position.z = -D / 2 + k * pitchZ + (pitchZ - tLam) / 2; this.lamG.add(m); }
    // 转子轭叠片
    const rs = new THREE.Shape(); rs.absarc(0, 0, g.Rcore, 0, TAU, false);
    const rh = new THREE.Path(); rh.absarc(0, 0, g.Rshaft, 0, TAU, true); rs.holes.push(rh);
    const rGeo = new THREE.ExtrudeGeometry(rs, { depth: tLam, bevelEnabled: false, curveSegments: 72 });
    for (let k = 0; k < nLam; k++) { const m = new THREE.Mesh(rGeo, this.mat.lamR); m.position.z = -D / 2 + k * pitchZ + (pitchZ - tLam) / 2; this.magG.add(m); }

    // 转轴（铁芯段直径随方案变化）
    if (this.shaft) { this.rotorG.remove(this.shaft); this.shaft.geometry.dispose(); }
    const zb = this.zb, rc = g.Rshaft, zr = this.zr, zf = this.zf;
    const prof = [[0, zr], [0.26, zr], [0.28, zr + 0.02], [0.28, -zb - 0.3], [0.36, -zb - 0.28], [0.36, -zb + 0.2],
      [rc, -zb + 0.24], [rc, zb - 0.24], [0.36, zb - 0.2], [0.36, zb + 0.28], [0.32, zb + 0.3],
      [0.32, zf - 0.04], [0.29, zf], [0, zf]].map(([r, z]) => new THREE.Vector2(r, z));
    this.shaft = new THREE.Mesh(new THREE.LatheGeometry(prof, 40), this.mat.shaft);
    this.shaft.rotation.x = PI / 2; this.rotorG.add(this.shaft);

    // 2) 磁钢：2p 块，N 红 / S 蓝，带倒角
    const span = PI / g.p, arc = span * g.magArc;
    const magMats = [new THREE.MeshStandardMaterial({ color: 0xe5484d, metalness: 0.45, roughness: 0.3, emissive: 0x3a0608 }),
                     new THREE.MeshStandardMaterial({ color: 0x3e7bfa, metalness: 0.45, roughness: 0.3, emissive: 0x06173a })];
    this.magLabels = [];
    for (let k = 0; k < 2 * g.p; k++) {
      const c = k * span, isN = k % 2 === 0;
      const geo = new THREE.ExtrudeGeometry(sectorShape(g.Rcore + 0.005, g.Rmag - 0.012, c - arc / 2, c + arc / 2),
        { depth: D * 0.97 - 0.03, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.012, bevelSegments: 2, curveSegments: 32 });
      geo.translate(0, 0, -(D * 0.97 - 0.03) / 2);
      this.magG.add(new THREE.Mesh(geo, magMats[isN ? 0 : 1]));
      const lab = makeLabel(isN ? 'N' : 'S', { color: isN ? '#ffb3b5' : '#b9d0ff', height: g.p > 4 ? 0.3 : 0.42, order: 1003 });
      const rl = (g.Rcore + g.Rmag) / 2;
      lab.position.set(Math.cos(c) * rl, Math.sin(c) * rl, D / 2 + 0.08); this.magG.add(lab);
    }

    // 3) 绕组：逐匝 + 逐层的圆角矩形线圈（梯形槽满率），所有齿共享一份几何
    const coilGeo = this._coilGeometry(g);
    this.coils = design.winding.coils.map(cw => {
      const base = new THREE.Color(0xb87333).lerp(new THREE.Color(PHC[cw.phase]), 0.42);
      const mat = new THREE.MeshStandardMaterial({ color: base, metalness: 0.85, roughness: 0.32, emissive: PHC[cw.phase], emissiveIntensity: 0 });
      const m = new THREE.Mesh(coilGeo, mat); m.rotation.z = cw.angle; this.coilG.add(m);
      // 相别字母
      const lab = makeLabel(cw.phase.toUpperCase() + (cw.sign < 0 ? '′' : ''), { color: hexCss(PHC[cw.phase]), height: 0.46 });
      lab.position.set(Math.cos(cw.angle) * (g.Rout + 0.45), Math.sin(cw.angle) * (g.Rout + 0.45), F - 0.25);
      this.phaseLabG.add(lab);
      // 电流环：两条导体边 ⊙/⊗ + 端部弧 + 方向箭头
      const xm = (g.Rbody0 + g.Rbody1) / 2, ys = g.toothW / 2 + this.coilSide / 2, dA = Math.atan2(ys, xm), rm = Math.hypot(xm, ys);
      const symL = makeCurSym(), symU = makeCurSym(), sc = Math.min(0.42, ys * 1.05);
      symL.scale.set(sc, sc, 1); symU.scale.set(sc, sc, 1);
      symL.position.set(Math.cos(cw.angle - dA) * rm, Math.sin(cw.angle - dA) * rm, F);
      symU.position.set(Math.cos(cw.angle + dA) * rm, Math.sin(cw.angle + dA) * rm, F);
      const arcM = new THREE.Mesh(new THREE.TorusGeometry(rm, 0.025, 6, 24, 2 * dA), basic(PHC[cw.phase]));
      arcM.rotation.z = cw.angle - dA; arcM.position.z = F - 0.05; arcM.renderOrder = 995;
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.22, 10), basic(PHC[cw.phase]));
      head.position.set(Math.cos(cw.angle) * rm, Math.sin(cw.angle) * rm, F - 0.05); head.renderOrder = 996;
      this.curG.add(symL, symU, arcM, head);
      return { ...cw, mat, symL, symU, arcM, head };
    });

    // 4) 三相母线（星形）
    const ringR = { a: g.Rout + 0.8, b: g.Rout + 1.05, c: g.Rout + 1.3 }, zB = F - 0.3;
    const bm = { a: basic(PHC.a, { opacity: 0.9 }), b: basic(PHC.b, { opacity: 0.9 }), c: basic(PHC.c, { opacity: 0.9 }) };
    ['a', 'b', 'c'].forEach(ph => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(ringR[ph], 0.035, 8, 120), bm[ph]);
      ring.position.z = zB; ring.renderOrder = 900; this.busG.add(ring);
    });
    design.winding.coils.forEach(cw => {
      const a = cw.angle;
      const m = rod([Math.cos(a) * (g.Rslot - 0.1), Math.sin(a) * (g.Rslot - 0.1), D / 2 + 0.3], [Math.cos(a) * ringR[cw.phase], Math.sin(a) * ringR[cw.phase], zB], 0.022, bm[cw.phase]);
      m.renderOrder = 900; this.busG.add(m);
    });
    const Ny = g.Rout + 1.9;
    ['a', 'b', 'c'].forEach(ph => { const m = rod([0, ringR[ph], zB], [0, Ny, zB], 0.025, bm[ph]); m.renderOrder = 900; this.busG.add(m); });
    const node = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), basic(0xe6edf3)); node.position.set(0, Ny, zB); node.renderOrder = 901; this.busG.add(node);
    const nl = makeLabel('N（中性点）', { color: '#e6edf3', height: 0.34, fontPx: 48 }); nl.position.set(0, Ny + 0.38, zB); this.busG.add(nl);
    const term = { a: PI * 1.22, b: PI * 1.0, c: PI * 0.78 };
    ['a', 'b', 'c'].forEach(ph => {
      const ang = term[ph], r2 = ringR.c + 0.75;
      const m = rod([Math.cos(ang) * ringR[ph], Math.sin(ang) * ringR[ph], zB], [Math.cos(ang) * r2, Math.sin(ang) * r2, zB], 0.03, bm[ph]); m.renderOrder = 900; this.busG.add(m);
      const t = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), bm[ph]); t.position.set(Math.cos(ang) * r2, Math.sin(ang) * r2, zB); t.renderOrder = 901; this.busG.add(t);
      const l = makeLabel({ a: 'U', b: 'V', c: 'W' }[ph], { color: hexCss(PHC[ph]), height: 0.5 });
      l.position.set(Math.cos(ang) * (r2 + 0.42), Math.sin(ang) * (r2 + 0.42), zB); this.busG.add(l);
    });

    // 5) 气隙磁场：径向箭头 + 气隙色带
    this.NF = 48; this.fieldCones = [];
    for (let k = 0; k < this.NF; k++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.5, 8), basic(0xffffff, { opacity: 0.85 }));
      cone.renderOrder = 980; this.gapG.add(cone); this.fieldCones.push(cone);
    }
    const ringGeo = new THREE.RingGeometry(g.Rmag + 0.004, g.Rbore - 0.004, 360, 1);
    ringGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(ringGeo.attributes.position.count * 3), 3));
    this.gapRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false }));
    this.gapRing.position.z = D / 2 + 0.012; this.gapG.add(this.gapRing);

    // 6) 设计相关的结构标注
    const L = this._labelAnchors.L;
    this.labelsG = this.labelsG.filter(x => x.parent !== this.statorLab);
    const aC = design.winding.coils[Math.round(g.Ns * 0.6) % g.Ns].angle;
    L(this.statorLab, '定子铁芯（硅钢片叠压）', [Math.cos(PI * 1.12) * g.Rout, Math.sin(PI * 1.12) * g.Rout, D / 2 - 0.2], [-5.3, -1.2, 1.4]);
    L(this.statorLab, '集中绕组（漆包铜线）', [Math.cos(aC) * g.Rslot * 0.92, Math.sin(aC) * g.Rslot * 0.92, D / 2 + 0.25], [Math.cos(aC) * 5.2, Math.sin(aC) * 5.2 - 0.6, 1.5]);
    this._applyFlags();
  }

  /* 一个齿的线圈几何（齿局部坐标：x 沿齿轴径向，y 切向，z 轴向） */
  _coilGeometry(g) {
    const D = g.depth, w2 = g.toothW / 2, d = 0.072, rw = 0.031;
    const x0 = g.Rbody0 + 0.045, x1 = g.Rbody1 - 0.05;
    const nR = Math.max(2, Math.floor((x1 - x0) / d) + 1);
    const geos = []; let sideSum = 0;
    for (let k = 0; k < nR; k++) {
      const x = x0 + k * d;
      const avail = x * Math.tan(g.pitch / 2) - w2 - 0.035;
      const nL = Math.max(1, Math.min(6, Math.floor(avail / d)));
      sideSum += nL * d;
      for (let l = 0; l < nL; l++) {
        const off = 0.028 + (l + 0.5) * d, hy = w2 + off, hz = D / 2 + off, rc = Math.min(0.06 + off * 0.8, hy * 0.9);
        const pts = [];
        const corner = (cy, cz, a0) => { for (let s = 0; s <= 6; s++) { const a = a0 + s / 6 * PI / 2; pts.push(new THREE.Vector3(x, cy + Math.cos(a) * rc, cz + Math.sin(a) * rc)); } };
        corner(hy - rc, hz - rc, 0); corner(-(hy - rc), hz - rc, PI / 2); corner(-(hy - rc), -(hz - rc), PI); corner(hy - rc, -(hz - rc), 1.5 * PI);
        const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
        geos.push(new THREE.TubeGeometry(curve, 64, rw, 6, true));
      }
    }
    this.coilSide = sideSum / nR;
    const merged = THREE.BufferGeometryUtils.mergeBufferGeometries(geos);
    geos.forEach(x => x.dispose());
    return merged;
  }

  /* ---------- 开关 ---------- */
  setFlag(k, v) { this.flags[k] = v; this._applyFlags(); }
  _applyFlags() {
    const f = this.flags;
    this.housingG.visible = f.housing;
    if (this.busG) this.busG.visible = f.bus;
    if (this.curG) this.curG.visible = f.current;
    if (this.gapG) this.gapG.visible = f.field && this.explodeK < 0.05;
    this.deltaG.visible = f.delta && this.explodeK < 0.05;
    this.labelsG.forEach(x => { x.visible = f.labels; });
  }

  setCamera(name, instant = false) {
    const P = { iso: [8.6, 6.4, 13.2], front: [0, 0.3, 17], side: [16.5, 3.2, 2.5], back: [-5, 4.5, -14] }[name] || [8.6, 6.4, 13.2];
    const to = new THREE.Vector3(...P);
    if (instant) { this.camera.position.copy(to); this.controls && this.controls.target.set(0, 0, 0); return; }
    this.camAnim = { from: this.camera.position.clone(), to, fromT: this.controls.target.clone(), t: 0 };
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px'; this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  /* ---------- 每帧更新 ---------- */
  update(sim, snap, field, dt) {
    const des = this.design, g = des.g, p = g.p, F = this.FRONT;
    const phiA = des.winding.axis.a;

    // 爆炸图动画
    const tgt = this.flags.explode ? 1 : 0;
    if (Math.abs(this.explodeK - tgt) > 1e-3) {
      this.explodeK += (tgt - this.explodeK) * Math.min(1, dt * 4);
      this._applyFlags();
    }
    const ek = this.explodeK;
    this.rotorAsm.position.z = 3.4 * ek;
    this.rotOv.position.z = 3.4 * ek;
    this.housingG.position.z = -2.6 * ek;
    this.encG.position.z = -(g.depth / 2 + 1.55) - 3.6 * ek;
    this.busG.position.z = 0.6 * ek;

    // 转子角（场景坐标）：N 极中心 = θm + φA/p
    const rot = snap.thetaM + phiA / p;
    this.rotorG.rotation.z = rot;
    this.encDisc.rotation.y = rot;
    const dRot = wrapPi(rot - this.prevRot); this.prevRot = rot;
    this.ballAng += 0.4 * dRot;
    this.ballGroups.forEach(b => { b.rotation.z = this.ballAng; });

    // d / q 轴
    aim(this.dAxis, rot, 2.5); aim(this.qAxis, rot + PI / 2 / p, 2.0);
    this.dLabel.position.set(Math.cos(rot) * 2.85, Math.sin(rot) * 2.85, F + 0.1);
    this.qLabel.position.set(Math.cos(rot + PI / 2 / p) * 2.35, Math.sin(rot + PI / 2 / p) * 2.35, F + 0.1);

    // 定子电流矢量：电角 γ → 机械角 (γ+φA)/p + 2πk/p，取最靠近转子 q 轴的一份
    const imag = Math.hypot(snap.ialpha, snap.ibeta), gam = Math.atan2(snap.ibeta, snap.ialpha);
    let sAng = (gam + phiA) / p;
    const ref = rot + PI / 2 / p;
    sAng += Math.round((ref - sAng) / (TAU / p)) * (TAU / p);
    const sLen = Math.min(3.2, 0.35 + imag * 0.24);
    aim(this.statorVec, sAng, sLen);
    this.isLabel.position.set(Math.cos(sAng) * (sLen + 0.3), Math.sin(sAng) * (sLen + 0.3), F + 0.2);
    this.statorVec.visible = this.isLabel.visible = imag > 0.05;
    const ti = this.trailIdx * 3;
    this.trailPos[ti] = Math.cos(sAng) * sLen; this.trailPos[ti + 1] = Math.sin(sAng) * sLen; this.trailPos[ti + 2] = F + 0.1;
    this.trailIdx = (this.trailIdx + 1) % this.trailN;
    this.trail.geometry.attributes.position.needsUpdate = true;

    // δ：电流矢量相对 d 轴的电角（机械角 × p）
    if (this.deltaG.visible) {
      const rel = wrapPi(sAng - rot), start = rel >= 0 ? rot : sAng, len = Math.max(0.001, Math.abs(rel));
      this.wedge.geometry.dispose(); this.wedge.geometry = new THREE.CircleGeometry(1.25, 48, start, len);
      const mid = start + len / 2;
      this.deltaLabel.sprite.position.set(Math.cos(mid) * 1.65, Math.sin(mid) * 1.65, F + 0.2);
      const dm = Math.round(Math.abs(rel) * 180 / PI);
      this.deltaLabel.set(p === 1 ? `δ = ${dm}°` : `δ = ${dm}°机 = ${dm * p}°电`, '#ffd34d');
      this.deltaG.visible = imag > 0.05 && this.flags.delta;
    }

    // 绕组发光 + 导体电流方向
    const cur = { a: snap.ia, b: snap.ib, c: snap.ic };
    const Iref = Math.max(4, sim.ctrl.cfg.Imax * 0.7);
    this.coils.forEach(c => {
      const v = cur[c.phase] * c.sign, a = Math.min(1, Math.abs(v) / Iref);
      c.mat.emissiveIntensity = 0.04 + a * 1.1;
      if (!this.flags.current) return;
      const col = hexCss(PHC[c.phase]), ccw = v < 0;
      // v>0：线圈电流产生向外磁通；a+δ 边 ⊙（流出纸面）、a−δ 边 ⊗
      drawCurSym(c.symU, !ccw, col, 0.25 + a);
      drawCurSym(c.symL, ccw, col, 0.25 + a);
      c.head.rotation.z = ccw ? c.angle : c.angle - PI;   // 前端部：v>0 时电流由 a+δ 流向 a−δ（顺时针）
      c.head.material.opacity = c.arcM.material.opacity = 0.2 + 0.8 * a;
    });

    // 气隙磁场：箭头（向外 = 红，向内 = 蓝）+ 色带
    if (this.gapG.visible && field) {
      const N = field.N, rg = g.Rgap;
      for (let k = 0; k < this.NF; k++) {
        const th = k / this.NF * TAU, B = field.B[Math.round(th / TAU * N) % N];
        const cone = this.fieldCones[k], out = B >= 0;
        cone.position.set(Math.cos(th) * rg, Math.sin(th) * rg, F - 0.08);
        cone.rotation.z = (out ? th : th + PI) - PI / 2;
        const s = Math.min(1.2, Math.abs(B) / 0.9);
        cone.scale.set(0.6 + 0.4 * s, 0.05 + s * 1.3, 1);
        cone.material.color.setHex(out ? 0xff6b6b : 0x5b9cff);
        cone.material.opacity = 0.25 + 0.7 * Math.min(1, s);
      }
      const pos = this.gapRing.geometry.attributes.position, col = this.gapRing.geometry.attributes.color;
      for (let i = 0; i < pos.count; i++) {
        const th = Math.atan2(pos.getY(i), pos.getX(i));
        const B = field.B[Math.round(((th + TAU) % TAU) / TAU * N) % N], s = Math.min(1, Math.abs(B) / 1.0);
        if (B >= 0) col.setXYZ(i, 0.15 + 0.85 * s, 0.12 + 0.2 * s, 0.14);
        else col.setXYZ(i, 0.12, 0.2 + 0.35 * s, 0.18 + 0.82 * s);
      }
      col.needsUpdate = true;
    }

    // 相机动画
    if (this.camAnim) {
      const A = this.camAnim; A.t = Math.min(1, A.t + dt / 0.7);
      const e = A.t < 0.5 ? 2 * A.t * A.t : 1 - Math.pow(-2 * A.t + 2, 2) / 2;
      this.camera.position.lerpVectors(A.from, A.to, e);
      this.controls.target.lerpVectors(A.fromT, new THREE.Vector3(0, 0, 0), e);
      if (A.t >= 1) this.camAnim = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

FOC.MotorScene = MotorScene;
})(window.FOC);
