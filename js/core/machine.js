/* =========================================================================
   machine.js —— 电机本体设计：槽极配合、绕组排布、几何、气隙磁场模型
   - 7 种常见“分数槽集中绕组 / 教学”槽极方案
   - 槽电势星形图（star of slots）自动生成双层齿绕组的相别与极性
   - 绕组系数 kw = kd·kp，相轴电角 φA/φB/φC
   - 气隙径向磁密：永磁体（梯形波）+ 电枢反应（齿 MMF 阶梯波）
   - 二维磁通函数 ψ(r,θ)：用于画磁力线与 |B| 云图
   ========================================================================= */
(function (root, factory) {
  const FOC = root.FOC = root.FOC || {};
  factory(FOC);
  if (typeof module === 'object' && module.exports) module.exports = FOC;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (FOC) {
'use strict';

const PI = Math.PI, TAU = 2 * PI;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const wrapPi = x => { x = (x + PI) % TAU; if (x < 0) x += TAU; return x - PI; };
const wrap2Pi = x => { x %= TAU; return x < 0 ? x + TAU : x; };
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

/* ---------- 槽极方案 ---------- */
const PRESETS = [
  { id: '6s2p',   Ns: 6,  p: 1, name: '6 槽 2 极 · 教学模型',
    note: '每相两个线圈正对放置，电角度 = 机械角度，最直观。绕组系数低，实际产品很少用。' },
  { id: '6s4p',   Ns: 6,  p: 2, name: '6 槽 4 极',
    note: '最简单的分数槽集中绕组，常见于风扇、小功率无刷电机。' },
  { id: '9s6p',   Ns: 9,  p: 3, name: '9 槽 6 极',
    note: '每相 3 个线圈同极性分布，常见于电动工具与车载泵。' },
  { id: '12s8p',  Ns: 12, p: 4, name: '12 槽 8 极',
    note: '9s6p 的倍数结构，径向力对称，伺服与工业电机常用。' },
  { id: '9s8p',   Ns: 9,  p: 4, name: '9 槽 8 极',
    note: '槽极数接近，绕组系数高(0.945)、齿槽转矩小，但存在不平衡径向力。' },
  { id: '12s10p', Ns: 12, p: 5, name: '12 槽 10 极',
    note: '绕组系数 0.933、齿槽转矩小，机器人关节/伺服电机的经典方案。' },
  { id: '12s14p', Ns: 12, p: 7, name: '12 槽 14 极',
    note: '外转子无人机电机最常见的方案（此处画成内转子），低速大转矩。' },
];

/* ---------- 槽电势星形图 → 双层齿绕组 ----------
   第 i 个齿线圈的电势相量角 = p·θi（电角）。按 60° 相带划分：
   [−30,30) A+  [30,90) C−  [90,150) B+  [150,210) A−  [210,270) C+  [270,330) B−  */
const BELTS = [['a', 1], ['c', -1], ['b', 1], ['a', -1], ['c', 1], ['b', -1]];
function layoutWinding(Ns, p) {
  const pitch = TAU / Ns;
  const coils = [];
  for (let i = 0; i < Ns; i++) {
    const thMech = i * pitch;
    const elec = wrap2Pi(p * thMech);
    const deg = Math.round(elec * 180 / PI * 1e6) / 1e6;
    const belt = Math.floor(((deg + 30) % 360) / 60);
    const [phase, sign] = BELTS[belt];
    coils.push({ tooth: i, angle: thMech, elec, phase, sign });
  }
  // 各相相量和 → 相轴电角与分布系数
  const sum = { a: [0, 0], b: [0, 0], c: [0, 0] }, count = { a: 0, b: 0, c: 0 };
  coils.forEach(c => {
    sum[c.phase][0] += c.sign * Math.cos(c.elec);
    sum[c.phase][1] += c.sign * Math.sin(c.elec);
    count[c.phase]++;
  });
  let axis = {}; ['a', 'b', 'c'].forEach(ph => { axis[ph] = Math.atan2(sum[ph][1], sum[ph][0]); });
  // 保证正相序：φB − φA = +120°；否则交换 B/C
  if (Math.abs(wrapPi(axis.b - axis.a - TAU / 3)) > 0.01) {
    coils.forEach(c => { if (c.phase === 'b') c.phase = 'c'; else if (c.phase === 'c') c.phase = 'b'; });
    [axis.b, axis.c] = [axis.c, axis.b];
    [sum.b, sum.c] = [sum.c, sum.b];
  }
  const kd = Math.hypot(sum.a[0], sum.a[1]) / count.a;
  const kp = Math.abs(Math.sin(p * pitch / 2));     // 线圈跨距 = 1 个齿距
  const balanced = count.a === count.b && count.b === count.c &&
    Math.abs(wrapPi(axis.b - axis.a - TAU / 3)) < 1e-6 && Math.abs(wrapPi(axis.c - axis.a + TAU / 3)) < 1e-6;
  const seq = coils.map(c => c.phase.toUpperCase() + (c.sign < 0 ? '′' : '')).join(' ');
  return { coils, axis, kd, kp, kw: kd * kp, balanced, seq };
}

/* ---------- 几何（场景单位，与 3D/2D 共用） ----------
   按“磁路设计”确定尺寸：轭部要承载半个极的磁通，极数越少轭越厚（2 极电机定子轭最厚、转子最小）；
   齿宽按齿距的固定比例，使齿部磁密约 1.4~1.6 T */
const B_PM = 0.8, K_ARM = 0.03;           // 磁钢气隙磁密（T）、电枢磁密系数（T/A，示意标定）
const B_YOKE = 1.45;                      // 轭部设计磁密
function geometry(Ns, p) {
  const Rbore = p === 1 ? 1.62 : p === 2 ? 1.88 : 2.0;
  const g = {
    Ns, p, depth: 1.6,
    Rout: 3.4, Rbore,                       // 定子外径 / 内径（齿顶）
    Rmag: Rbore - 0.1,                      // 磁钢外径（气隙 0.1）
    shoe: 0.09, taper: 0.11,                // 齿靴厚度 / 齿靴过渡
    slotOpen: 0.17,                         // 槽口宽（弧长）
    magArc: 0.84,                           // 极弧系数
  };
  g.Rcore = g.Rmag - 0.22;                  // 转子轭外径（磁钢厚 0.22）
  g.Rgap = (g.Rbore + g.Rmag) / 2;
  g.phiYoke = B_PM * g.Rgap * (PI / (2 * p)) * g.magArc;   // 轭部最大磁通 ≈ 半个极的磁通
  g.Rslot = g.Rout - clamp(g.phiYoke / B_YOKE, 0.42, 1.25);
  g.Rshaft = clamp(g.Rcore - g.phiYoke / 1.6, 0.3, 0.45);
  g.pitch = TAU / Ns;
  g.toothW = clamp(0.54 * TAU * g.Rbore / Ns, 0.3, 1.1);
  g.tipHalf = g.pitch / 2 - (g.slotOpen / 2) / g.Rbore;   // 齿顶半角
  g.Rbody0 = g.Rbore + g.shoe + g.taper;                  // 齿身起点
  g.Rbody1 = Math.sqrt(g.Rslot * g.Rslot - (g.toothW / 2) ** 2);
  return g;
}

/* 定子冲片内轮廓（逆时针多边形），3D 拉伸与 2D 剖面共用 */
function statorInnerContour(g, arcSeg = 10) {
  const pts = [];
  const P = (r, a) => pts.push([r * Math.cos(a), r * Math.sin(a)]);
  const L = (a, xl, yl) => {   // 齿局部坐标（x 沿齿轴，y 切向）→ 全局
    const c = Math.cos(a), s = Math.sin(a);
    pts.push([xl * c - yl * s, xl * s + yl * c]);
  };
  const hw = g.toothW / 2;
  for (let i = 0; i < g.Ns; i++) {
    const a = i * g.pitch;
    L(a, g.Rbody1, -hw);                                // 齿身右下（顺时针侧）
    L(a, g.Rbody0, -hw);
    P(g.Rbore + g.shoe, a - g.tipHalf);                 // 齿靴
    for (let k = 0; k <= arcSeg; k++) P(g.Rbore, a - g.tipHalf + 2 * g.tipHalf * k / arcSeg);
    P(g.Rbore + g.shoe, a + g.tipHalf);
    L(a, g.Rbody0, hw);
    L(a, g.Rbody1, hw);
    // 槽底圆弧 → 下一个齿
    const a0 = a + Math.atan2(hw, g.Rbody1), a1 = a + g.pitch - Math.atan2(hw, g.Rbody1);
    for (let k = 1; k < arcSeg; k++) P(g.Rslot, a0 + (a1 - a0) * k / arcSeg);
  }
  return pts;
}

/* 区域判别（极坐标，定子坐标系）。转子区域需额外给转子角 */
const REG = { OUT: 0, YOKE: 1, TOOTH: 2, SLOT: 3, GAP: 4, MAGN: 5, MAGS: 6, RYOKE: 7, SHAFT: 8 };
function statorRegion(g, r, th) {
  if (r > g.Rout) return REG.OUT;
  if (r < g.Rbore) return -1;   // 交给转子
  const i = Math.round(th / g.pitch);
  const d = wrapPi(th - i * g.pitch);
  const xl = r * Math.cos(d), yl = Math.abs(r * Math.sin(d));
  if (r >= g.Rslot) return REG.YOKE;
  if (r < g.Rbore + g.shoe) return Math.abs(d) <= g.tipHalf ? REG.TOOTH : REG.SLOT;
  if (xl < g.Rbody0) {
    const t = (xl - g.Rbore - g.shoe) / g.taper;
    const yEdge = (g.Rbore + g.shoe) * Math.sin(g.tipHalf) * (1 - t) + (g.toothW / 2) * t;
    return yl <= yEdge ? REG.TOOTH : REG.SLOT;
  }
  return yl <= g.toothW / 2 ? REG.TOOTH : REG.SLOT;
}
function rotorRegion(g, r, th, rotAngle) {
  if (r < g.Rshaft) return REG.SHAFT;
  if (r < g.Rcore) return REG.RYOKE;
  if (r < g.Rmag) {
    const phi = wrapPi(g.p * (th - rotAngle));       // 电角，0 为 N 极中心
    const half = g.magArc * PI / 2;
    if (Math.abs(phi) <= half) return REG.MAGN;
    if (Math.abs(wrapPi(phi - PI)) <= half) return REG.MAGS;
    return REG.GAP;
  }
  return REG.GAP;
}

/* ---------- 气隙磁场模型 ----------
   B_pm(θ)：表贴磁钢，极弧系数 magArc，边缘按漏磁平滑
   B_arm(θ)：每个齿顶的 MMF = Σ(线圈极性 × 相电流)，槽口内线性过渡
   常数见 geometry() 上方：B_PM、K_ARM */
class AirgapField {
  constructor(design, N = 720) {
    this.d = design; this.N = N;
    this.th = new Float64Array(N);
    for (let k = 0; k < N; k++) this.th[k] = k / N * TAU;
    this.Bpm = new Float64Array(N); this.Barm = new Float64Array(N); this.B = new Float64Array(N);
    this.Phi = new Float64Array(N);       // 当前视图下的磁通函数
    this.toothMMF = new Float64Array(design.g.Ns);
  }
  /* view: 'total' | 'pm' | 'arm'；rotAngle：转子 N 极中心的机械角（场景坐标） */
  compute(rotAngle, ia, ib, ic, view = 'total') {
    const { g, winding } = this.d, N = this.N, p = g.p;
    const cur = { a: ia, b: ib, c: ic };
    let mean = 0;
    winding.coils.forEach((c, i) => { this.toothMMF[i] = c.sign * cur[c.phase]; mean += this.toothMMF[i]; });
    mean /= g.Ns;
    for (let i = 0; i < g.Ns; i++) this.toothMMF[i] -= mean;
    const half = g.magArc * PI / 2, soft = 0.09 * p + 0.05;
    for (let k = 0; k < N; k++) {
      const th = this.th[k];
      // 永磁体
      const phi = wrapPi(p * (th - rotAngle));
      const eN = half - Math.abs(phi), eS = half - Math.abs(wrapPi(phi - PI));
      this.Bpm[k] = B_PM * (smooth(-soft, soft, eN) - smooth(-soft, soft, eS));
      // 电枢：齿顶内为该齿 MMF，槽口内在相邻两齿之间线性过渡
      const t = th / g.pitch, i0 = Math.round(t), dd = wrapPi(th - i0 * g.pitch);
      const iT = ((i0 % g.Ns) + g.Ns) % g.Ns;
      let F;
      if (Math.abs(dd) <= g.tipHalf) F = this.toothMMF[iT];
      else {
        const iN = (iT + (dd > 0 ? 1 : g.Ns - 1)) % g.Ns;
        const fr = (Math.abs(dd) - g.tipHalf) / (2 * (g.pitch / 2 - g.tipHalf));
        F = this.toothMMF[iT] * (1 - fr) + this.toothMMF[iN] * fr;
      }
      this.Barm[k] = K_ARM * F;
      this.B[k] = view === 'pm' ? this.Bpm[k] : view === 'arm' ? this.Barm[k] : this.Bpm[k] + this.Barm[k];
    }
    // Φ(θ) = ∫ B·Rgap dθ，去均值
    const dth = TAU / N, R = g.Rgap;
    let acc = 0, s = 0;
    for (let k = 0; k < N; k++) {
      this.Phi[k] = acc;
      acc += 0.5 * (this.B[k] + this.B[(k + 1) % N]) * R * dth;
      s += this.Phi[k];
    }
    s /= N;
    for (let k = 0; k < N; k++) this.Phi[k] -= s;
    return this;
  }
  phiAt(th) {           // 线性插值 Φ(θ)
    const x = wrap2Pi(th) / TAU * this.N, k = Math.floor(x), f = x - k;
    return this.Phi[k % this.N] * (1 - f) + this.Phi[(k + 1) % this.N] * f;
  }
  /* 齿身内的磁通函数：磁通被约束在齿里，槽内 ψ 为常数（不穿过槽） */
  phiChannel(th, r) {
    const g = this.d.g;
    const i = Math.round(th / g.pitch), d = wrapPi(th - i * g.pitch);
    const hb = Math.asin(Math.min(1, (g.toothW / 2) / r));
    const ai = i * g.pitch;
    const sL = this.phiAt(ai - g.pitch / 2), sR = this.phiAt(ai + g.pitch / 2);
    if (Math.abs(d) <= hb) return sL + (sR - sL) * (d + hb) / (2 * hb);
    return d > 0 ? sR : sL;
  }
  /* 二维磁通函数 ψ(r,θ)：等值线即磁力线（相邻线间磁通相等） */
  psi(r, th) {
    const g = this.d.g;
    if (r >= g.Rslot) return this.phiChannel(th, g.Rslot) * (g.Rout - r) / (g.Rout - g.Rslot);
    if (r >= g.Rbody0) return this.phiChannel(th, r);
    if (r >= g.Rbore) {
      const t = smooth(0, 1, (r - g.Rbore) / (g.shoe + g.taper));
      return this.phiAt(th) * (1 - t) + this.phiChannel(th, Math.max(r, g.Rbody0)) * t;
    }
    if (r >= g.Rcore) return this.phiAt(th);
    if (r >= g.Rshaft) return this.phiAt(th) * (r - g.Rshaft) / (g.Rcore - g.Rshaft);
    return 0;
  }
  /* 基波：定子磁场方向（机械角）与幅值 */
  fundamental(arr) {
    const p = this.d.g.p, N = this.N; let re = 0, im = 0;
    for (let k = 0; k < N; k++) { re += arr[k] * Math.cos(p * this.th[k]); im += arr[k] * Math.sin(p * this.th[k]); }
    return { amp: 2 * Math.hypot(re, im) / N, elec: Math.atan2(im, re) };
  }
}

/* ---------- 电机电气参数（随极对数缩放，使不同方案的外特性可比） ----------
   Kt = 1.5·p·ψf 固定 0.09 N·m/A；L ∝ 1/p 使 ωe·L 与 p 无关 */
function electrical(p) {
  return { p, R: 0.35, Ld: 0.0045 / p, Lq: 0.0045 / p, psi: 0.09 / (1.5 * p), J: 2.0e-4, B: 2.0e-4 };
}

function makeDesign(id) {
  const pr = PRESETS.find(x => x.id === id) || PRESETS[0];
  const g = geometry(pr.Ns, pr.p);
  const winding = layoutWinding(pr.Ns, pr.p);
  const q = pr.Ns / (3 * 2 * pr.p);
  const lcm = pr.Ns * 2 * pr.p / gcd(pr.Ns, 2 * pr.p);
  return { ...pr, g, winding, q, cogPeriods: lcm, elec: electrical(pr.p) };
}

FOC.machine = { PRESETS, REG, B_PM, K_ARM, layoutWinding, geometry, statorInnerContour, statorRegion, rotorRegion, AirgapField, electrical, makeDesign, gcd };
});
