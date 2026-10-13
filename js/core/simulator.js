/* =========================================================================
   simulator.js —— 开关级逆变器 + PMSM dq 模型 + 机械系统 的时间推进
   - 中心对齐 PWM：每个开关周期 Ts 内按三相占空比切出最多 7 段恒定开关状态，
     段内用 RK2 积分电机方程 → 自然得到 PWM 电流纹波
   - 每周期起点（载波顶点、零矢量 000 中心）采样电流并运行 FOC，
     新占空比在下一周期生效（数字控制 1 拍延时）
   - 记录器：快速通道（每 Ts/8）+ 慢速通道（每 0.5 ms）环形缓冲
   ========================================================================= */
(function (root, factory) {
  const FOC = root.FOC = root.FOC || {};
  factory(FOC);
  if (typeof module === 'object' && module.exports) module.exports = FOC;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (FOC) {
'use strict';

const { PI, TAU, RPM, clamp, wrap2Pi, park, invPark, invClarke, clarke } = FOC.math;

/* ---------- 环形缓冲记录器 ---------- */
class Recorder {
  constructor(n, channels) {
    this.n = n; this.head = 0; this.count = 0;
    this.t = new Float64Array(n);
    this.ch = {};
    channels.forEach(c => { this.ch[c] = new Float32Array(n); });
    this.names = channels;
  }
  push(t, src) {
    const h = this.head;
    this.t[h] = t;
    for (let i = 0; i < this.names.length; i++) this.ch[this.names[i]][h] = src[this.names[i]];
    this.head = (h + 1) % this.n;
    if (this.count < this.n) this.count++;
  }
  clear() { this.head = 0; this.count = 0; }
  /* 逻辑索引 0 = 最旧 */
  idx(i) { return (this.head - this.count + i + this.n) % this.n; }
  /* 二分查找：第一个 t ≥ t0 的逻辑索引 */
  lowerBound(t0) {
    let lo = 0, hi = this.count;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.t[this.idx(m)] < t0) lo = m + 1; else hi = m; }
    return lo;
  }
}

/* ---------- PMSM 电机模型（转子 dq 坐标系） ---------- */
class PMSM {
  constructor(params) {
    Object.assign(this, params);
    this.id = 0; this.iq = 0; this.omega = 0; this.thetaM = 0;
    this.Te = 0; this.TL = 0;
    this.load = { torque: 0.15, type: 'const' };   // 负载
    this.dyno = { on: false, rpm: 0 };              // 测功机拖动（转速由外部强制）
  }
  get thetaE() { return wrap2Pi(this.p * this.thetaM); }
  get Kt() { return 1.5 * this.p * this.psi; }
  loadTorque(w) {
    const T = this.load.torque;
    if (this.load.type === 'fan') { const r = w / (3000 * RPM); return T * r * Math.abs(r); }
    return T * Math.tanh(w / 3);                      // 恒转矩（摩擦型，过零平滑）
  }
  /* 状态导数；vAB 为静止坐标系电压 */
  deriv(id, iq, w, th, va, vb, out) {
    const p = this.p, we = p * w;
    const [vd, vq] = park(va, vb, p * th);
    out[0] = (vd - this.R * id + we * this.Lq * iq) / this.Ld;
    out[1] = (vq - this.R * iq - we * (this.Ld * id + this.psi)) / this.Lq;
    const Te = 1.5 * p * (this.psi * iq + (this.Ld - this.Lq) * id * iq);
    if (this.dyno.on) out[2] = (this.dyno.rpm * RPM - w) / 0.15;
    else out[2] = (Te - this.B * w - this.loadTorque(w)) / this.J;
    out[3] = w;
    return Te;
  }
}

/* ---------- 仿真器 ---------- */
const FAST_CH = ['ia', 'ib', 'ic', 'id', 'iq', 'idRef', 'iqRef', 'da', 'db', 'dc'];
const SLOW_CH = ['w', 'wRef', 'Te', 'TL', 'id', 'iq', 'idRef', 'iqRef', 'vd', 'vq', 'vRatio'];

class Simulator {
  constructor(designId = '6s2p') {
    this.ctrl = new FOC.FocController();
    this.Vdc = 48;
    this.fpwm = 10000;
    this.t = 0;
    this.tIn = 0;                      // 当前开关周期内已过时间
    this.duty = [0.5, 0.5, 0.5];       // 本周期生效的占空比
    this.dutyNext = [0.5, 0.5, 0.5];
    this.svApplied = FOC.svpwm(0, 0, this.Vdc);
    this.svNext = this.svApplied;
    this.sw = [0, 0, 0];
    this.fast = new Recorder(32768, FAST_CH);
    this.slow = new Recorder(8192, SLOW_CH);
    this._k = new Float64Array(4); this._k2 = new Float64Array(4);
    this._recFast = {}; this._recSlow = {};
    this.nextFast = 0; this.nextSlow = 0;
    this.setDesign(designId);
  }

  get Ts() { return 1 / this.fpwm; }

  setDesign(id) {
    this.design = FOC.machine.makeDesign(id);
    const old = this.motor;
    this.motor = new PMSM(this.design.elec);
    if (old) {   // 保留负载设置与机械状态（电角度重新计算）
      this.motor.load = old.load; this.motor.dyno = old.dyno;
      this.motor.omega = old.omega; this.motor.thetaM = old.thetaM;
    }
    this.ctrl.tune(this.motor);
  }
  setMotorParam(key, v) { this.motor[key] = v; this.ctrl.tune(this.motor); }
  retune() { this.ctrl.tune(this.motor); }

  /* 电流（abc）由 dq 状态得到 */
  phaseCurrents() {
    const m = this.motor;
    const [a, b] = invPark(m.id, m.iq, m.thetaE);
    return invClarke(a, b);
  }

  /* 周期起点：采样 + 运行控制器，并把上一拍算好的占空比投入使用 */
  _periodStart() {
    this.duty = this.dutyNext; this.svApplied = this.svNext;
    const [ia, ib, ic] = this.phaseCurrents();
    const m = this.motor;
    const [va, vb] = this.ctrl.update({ ia, ib, ic, thetaE: m.thetaE, omegaM: m.omega }, this.Ts, m, this.Vdc);
    this.svNext = FOC.svpwm(va, vb, this.Vdc);
    this.dutyNext = [this.svNext.da, this.svNext.db, this.svNext.dc];
  }

  /* 中心对齐三角载波：tri = |1 − 2τ/Ts|，d > tri 时上管导通 */
  switchStateAt(frac) {
    const tri = Math.abs(1 - 2 * frac), d = this.duty;
    return [d[0] > tri ? 1 : 0, d[1] > tri ? 1 : 0, d[2] > tri ? 1 : 0];
  }
  _nextEdge(frac) {
    let nx = 1;
    for (let i = 0; i < 3; i++) {
      const d = this.duty[i], e0 = (1 - d) / 2, e1 = (1 + d) / 2;
      if (e0 > frac + 1e-12 && e0 < nx) nx = e0;
      if (e1 > frac + 1e-12 && e1 < nx) nx = e1;
    }
    return nx;
  }

  /* RK2（中点法）积分一个子步，电压恒定 */
  _integrate(h, va, vb) {
    const m = this.motor, k = this._k, k2 = this._k2;
    m.deriv(m.id, m.iq, m.omega, m.thetaM, va, vb, k);
    const Te = m.deriv(m.id + 0.5 * h * k[0], m.iq + 0.5 * h * k[1], m.omega + 0.5 * h * k[2],
      m.thetaM + 0.5 * h * k[3], va, vb, k2);
    m.id += h * k2[0]; m.iq += h * k2[1]; m.omega += h * k2[2];
    m.thetaM = wrap2Pi(m.thetaM + h * k2[3]);
    m.Te = Te;
    m.TL = m.dyno.on ? Te - m.B * m.omega : m.loadTorque(m.omega);
  }

  _record() {
    const m = this.motor, o = this.ctrl.out, Ts = this.Ts;
    if (this.t >= this.nextFast) {
      const [ia, ib, ic] = this.phaseCurrents();
      const r = this._recFast;
      r.ia = ia; r.ib = ib; r.ic = ic;
      // 记录“控制坐标系”下的 dq（与控制器看到的一致），以便与指令对比
      const [al, be] = clarke(ia, ib, ic);
      [r.id, r.iq] = park(al, be, o.thetaCtrl);
      r.idRef = o.idRef; r.iqRef = o.iqRef;
      r.da = this.duty[0]; r.db = this.duty[1]; r.dc = this.duty[2];
      this.fast.push(this.t, r);
      this.nextFast = this.t + Ts / 8 * 0.999;
    }
    if (this.t >= this.nextSlow) {
      const r = this._recSlow;
      r.w = m.omega / RPM; r.wRef = (this.ctrl.mode === 'speed' ? o.wRef : this.ctrl.mode === 'openloop' ? this.ctrl.omegaOL / m.p : m.omega) / RPM;
      r.Te = m.Te; r.TL = m.TL;
      r.id = o.id; r.iq = o.iq; r.idRef = o.idRef; r.iqRef = o.iqRef;
      r.vd = o.vd; r.vq = o.vq; r.vRatio = o.vRatio;
      this.slow.push(this.t, r);
      this.nextSlow = this.t + 0.0005;
    }
  }

  /* 推进仿真时间 T（秒）；maxPeriods 防止单帧计算量过大 */
  advance(T, maxPeriods = 4000) {
    const Ts = this.Ts, hMax = Ts / 8;
    let remaining = T, periods = 0;
    while (remaining > 1e-12) {
      if (this.tIn <= 1e-15) {
        if (periods++ >= maxPeriods) return false;
        this._periodStart();
      }
      const frac = this.tIn / Ts;
      const edge = this._nextEdge(frac) * Ts;
      const tEnd = Math.min(edge, this.tIn + remaining);
      const span = tEnd - this.tIn;
      // 段中点的开关状态 → 相电压（αβ）
      this.sw = this.switchStateAt((this.tIn + tEnd) / 2 / Ts);
      const [va, vb] = FOC.switchVoltageAB(this.sw[0], this.sw[1], this.sw[2], this.Vdc);
      const n = Math.max(1, Math.ceil(span / hMax - 1e-9)), h = span / n;
      for (let i = 0; i < n; i++) { this._integrate(h, va, vb); this.t += h; this._record(); }
      remaining -= span;
      this.tIn = tEnd;
      if (this.tIn >= Ts - 1e-15) this.tIn = 0;
    }
    this.sw = this.switchStateAt(this.tIn / Ts);
    return true;
  }

  get carrierFrac() { return this.tIn / this.Ts; }

  /* 便于显示的派生量 */
  snapshot() {
    const m = this.motor, o = this.ctrl.out;
    const [ia, ib, ic] = this.phaseCurrents();
    const [ial, ibe] = clarke(ia, ib, ic);
    const Pcu = 1.5 * m.R * (m.id * m.id + m.iq * m.iq);
    const Pmech = m.Te * m.omega;
    const Pin = 1.5 * (o.vd * o.id + o.vq * o.iq);
    return {
      t: this.t, ia, ib, ic, ialpha: ial, ibeta: ibe,
      id: m.id, iq: m.iq, thetaE: m.thetaE, thetaM: m.thetaM, omega: m.omega,
      rpm: m.omega / RPM, Te: m.Te, TL: m.TL, Pcu, Pmech, Pin,
      eff: Pin > 1 && Pmech > 0 ? Pmech / Pin : null,
    };
  }
}

FOC.Recorder = Recorder;
FOC.PMSM = PMSM;
FOC.Simulator = Simulator;
});
