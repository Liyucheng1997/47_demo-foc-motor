/* =========================================================================
   charts.js —— 2D 图表：示波器、Clarke/Park 双视角矢量图、气隙磁密、dq 平面
   ========================================================================= */
(function (FOC) {
'use strict';
const { PI, TAU, park } = FOC.math;
const U = FOC.ui;

/* ---------- 示波器 ---------- */
const WINDOWS = [0, 0.001, 0.005, 0.02, 0.05, 0.2, 1, 4];   // 0 = 自动
class Scope {
  constructor(cv) { this.cv = cv; this.ctx = cv.getContext('2d'); this.tab = 'abc'; this.win = 0; this.ranges = {}; this.cols = {}; }
  windowLabel(sim) { return WINDOWS[this.win] ? U.fmtTime(WINDOWS[this.win]) : `自动（${U.fmtTime(this._autoWin(sim))}）`; }
  _autoWin(sim) {
    const fastCov = sim.fast.count > 1 ? sim.fast.t[sim.fast.idx(sim.fast.count - 1)] - sim.fast.t[sim.fast.idx(0)] : 0.01;
    const we = Math.abs(sim.motor.omega * sim.motor.p);
    if (this.tab === 'abc') return Math.max(16 / sim.fpwm, Math.min(we > 1 ? 2 * TAU / we : 0.2, fastCov || 0.2, 0.4));
    if (this.tab === 'dq') return Math.min(0.05, fastCov || 0.05);
    return this.tab === 'speed' ? 1 : 0.5;
  }
  render(sim) {
    const { W, H, dpr } = U.fitCanvas(this.cv), ctx = this.ctx, C = U.COLORS;
    ctx.clearRect(0, 0, W, H);
    const fast = this.tab === 'abc' || this.tab === 'dq';
    const rec = fast ? sim.fast : sim.slow;
    if (rec.count < 2) return;
    const tEnd = rec.t[rec.idx(rec.count - 1)];
    let win = WINDOWS[this.win] || this._autoWin(sim);
    const t0 = tEnd - win;
    const L = 40 * dpr, R = 10 * dpr;
    const panels = {
      abc: [{ s: [['ia', C.pa], ['ib', C.pb], ['ic', C.pc]], unit: 'A', key: 'i', names: ['i_a', 'i_b', 'i_c'] }],
      dq: [{ s: [['id', C.d], ['idRef', C.d, true], ['iq', C.q], ['iqRef', C.q, true]], unit: 'A', key: 'idq', names: ['i_d', 'i_d*', 'i_q', 'i_q*'] }],
      speed: [{ s: [['w', '#e6edf3'], ['wRef', C.accent, true]], unit: 'rpm', key: 'w', names: ['转速 n', '指令 n*'] },
              { s: [['Te', C.q], ['TL', C.alpha, true]], unit: 'N·m', key: 'T', names: ['电磁转矩 Tₑ', '负载 T_L'] }],
      volt: [{ s: [['vd', C.d], ['vq', C.q]], unit: 'V', key: 'v', names: ['u_d', 'u_q'] },
             { s: [['vRatio', C.alpha]], unit: '%', key: 'm', names: ['电压需求 |u|/V_max'], scale: 100, fixed: [0, 140], limit: 100 }],
    }[this.tab];
    const top = 18 * dpr, gap = 16 * dpr, bottom = 18 * dpr;
    const ph = (H - top - bottom - gap * (panels.length - 1)) / panels.length;
    const i0 = Math.max(0, rec.lowerBound(t0) - 1);
    panels.forEach((pn, k) => {
      const y0 = top + k * (ph + gap), rect = { x: L, y: y0, w: W - L - R, h: ph };
      const ncol = Math.max(2, Math.floor(rect.w / dpr));
      // 逐列 min/max 抽取
      const data = pn.s.map(([ch]) => {
        const key = pn.key + ch, arr = this.cols[key] && this.cols[key].length === ncol * 2 ? this.cols[key] : (this.cols[key] = new Float32Array(ncol * 2));
        arr.fill(NaN);
        const src = rec.ch[ch], sc = pn.scale || 1;
        for (let i = i0; i < rec.count; i++) {
          const ix = rec.idx(i), t = rec.t[ix];
          let c = Math.floor((t - t0) / win * (ncol - 1)); if (c < 0) continue; if (c >= ncol) c = ncol - 1;
          const v = src[ix] * sc;
          if (Number.isNaN(arr[2 * c]) || v < arr[2 * c]) arr[2 * c] = v;
          if (Number.isNaN(arr[2 * c + 1]) || v > arr[2 * c + 1]) arr[2 * c + 1] = v;
        }
        return arr;
      });
      let lo, hi;
      if (pn.fixed) [lo, hi] = pn.fixed;
      else {
        let m = 0; data.forEach(a => { for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i])) m = Math.max(m, Math.abs(a[i])); });
        const ar = this.ranges[pn.key] || (this.ranges[pn.key] = new U.AutoRange(pn.unit === 'rpm' ? 100 : 1));
        hi = ar.update(m); lo = -hi;
      }
      const Y = v => rect.y + rect.h * (1 - (v - lo) / (hi - lo));
      // 网格
      ctx.strokeStyle = '#1a2230'; ctx.lineWidth = 1; ctx.fillStyle = C.dim; ctx.font = `${9.5 * dpr}px sans-serif`;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      const st = U.niceStep(hi - lo, 4);
      for (let v = Math.ceil(lo / st) * st; v <= hi + 1e-9; v += st) {
        ctx.beginPath(); ctx.moveTo(rect.x, Y(v)); ctx.lineTo(rect.x + rect.w, Y(v)); ctx.stroke();
        ctx.fillText(Math.abs(v) < 1e-9 ? '0' : +v.toPrecision(3), rect.x - 4 * dpr, Y(v));
      }
      if (lo < 0 && hi > 0) { ctx.strokeStyle = '#2b3646'; ctx.beginPath(); ctx.moveTo(rect.x, Y(0)); ctx.lineTo(rect.x + rect.w, Y(0)); ctx.stroke(); }
      if (pn.limit) { ctx.strokeStyle = C.bad; ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.beginPath(); ctx.moveTo(rect.x, Y(pn.limit)); ctx.lineTo(rect.x + rect.w, Y(pn.limit)); ctx.stroke(); ctx.setLineDash([]); }
      ctx.save(); ctx.translate(10 * dpr, rect.y + rect.h / 2); ctx.rotate(-PI / 2); ctx.textAlign = 'center'; ctx.fillText(pn.unit, 0, 0); ctx.restore();
      // 曲线
      ctx.save(); ctx.beginPath(); ctx.rect(rect.x, rect.y - 2, rect.w, rect.h + 4); ctx.clip();
      pn.s.forEach(([, col, dash], si) => {
        const a = data[si]; ctx.strokeStyle = col; ctx.lineWidth = (dash ? 1.2 : 1.6) * dpr; ctx.setLineDash(dash ? [5 * dpr, 4 * dpr] : []);
        ctx.beginPath(); let started = false;
        for (let c = 0; c < ncol; c++) {
          if (Number.isNaN(a[2 * c])) continue;
          const x = rect.x + c / (ncol - 1) * rect.w;
          if (!started) { ctx.moveTo(x, Y(a[2 * c])); started = true; } else ctx.lineTo(x, Y(a[2 * c]));
          if (a[2 * c + 1] !== a[2 * c]) ctx.lineTo(x, Y(a[2 * c + 1]));
        }
        ctx.stroke();
      });
      ctx.setLineDash([]); ctx.restore();
      // 图例
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.font = `${10.5 * dpr}px "Segoe UI",sans-serif`;
      let lx = rect.x + 4 * dpr;
      pn.names.forEach((n, si) => { ctx.fillStyle = pn.s[si][1]; ctx.fillText(n, lx, rect.y - 4 * dpr); lx += ctx.measureText(n).width + 12 * dpr; });
    });
    // 时间轴
    ctx.fillStyle = C.dim; ctx.font = `${9.5 * dpr}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const tw = W - L - R, st = U.niceStep(win, 5);
    for (let v = 0; v <= win + 1e-12; v += st) {
      const x = L + tw * (1 - v / win);
      ctx.fillText(v === 0 ? '现在' : '−' + U.fmtTime(v), x, H - 4 * dpr);
    }
  }
}

/* ---------- Clarke / Park 双视角矢量图 ---------- */
class VectorChart {
  constructor(cv) { this.cv = cv; this.ctx = cv.getContext('2d'); this.trail = []; this.ar = new U.AutoRange(2); }
  render(sim, snap) {
    const { W, H, dpr } = U.fitCanvas(this.cv), ctx = this.ctx, C = U.COLORS, o = sim.ctrl.out;
    ctx.clearRect(0, 0, W, H);
    const R = Math.min(W / 4.3, H / 2.35), cyy = H / 2 + 8 * dpr;
    // 自动量程：按当前电流幅值缩放，小电流也看得清
    const Imax = this.ar.update(Math.max(Math.hypot(snap.ialpha, snap.ibeta), Math.hypot(o.idRef, o.iqRef))), sc = R * 0.9 / Imax;
    const th = o.thetaCtrl;
    const panel = (cx, title) => {
      ctx.strokeStyle = '#1a2230'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cyy, R, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cyy, R / 2, 0, TAU); ctx.stroke();
      ctx.fillStyle = C.muted; ctx.font = `600 ${11 * dpr}px "Segoe UI",sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(title, cx, 13 * dpr);
      ctx.fillStyle = C.dim; ctx.font = `${9.5 * dpr}px sans-serif`; ctx.fillText(`外圈 = ${+Imax.toFixed(1)} A`, cx, H - 5 * dpr);
    };
    const P = (cx, a, m) => [cx + Math.cos(a) * m * sc, cyy - Math.sin(a) * m * sc];
    const vec = (cx, x0, y0, a, m, col, lw) => {
      const x1 = x0 + Math.cos(a) * m * sc, y1 = y0 - Math.sin(a) * m * sc;
      U.arrow(ctx, x0, y0, x1, y1, col, lw * dpr, 8 * dpr); return [x1, y1];
    };
    // 左：静止坐标
    const cL = W * 0.26; panel(cL, '静止坐标 abc / αβ');
    ctx.font = `${10.5 * dpr}px sans-serif`;
    [['A', 0, C.pa], ['B', TAU / 3, C.pb], ['C', 2 * TAU / 3, C.pc]].forEach(([n, a, col]) => {
      ctx.strokeStyle = col; ctx.globalAlpha = 0.35; ctx.setLineDash([3 * dpr, 4 * dpr]);
      const [x, y] = P(cL, a, Imax * 1.08), [x2, y2] = P(cL, a + PI, Imax * 1.08);
      ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.fillStyle = col; ctx.fillText(n, ...P(cL, a, Imax * 1.17));
    });
    ctx.fillStyle = C.alpha; ctx.fillText('α', ...P(cL, -0.12, Imax * 1.17));
    ctx.fillStyle = C.beta; ctx.fillText('β', ...P(cL, PI / 2 + 0.1, Imax * 1.17));
    // 旋转的 dq 轴
    ctx.setLineDash([5 * dpr, 4 * dpr]); ctx.lineWidth = 1.2 * dpr;
    [[th, C.d, 'd'], [th + PI / 2, C.q, 'q']].forEach(([a, col, n]) => {
      ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(...P(cL, a + PI, Imax)); ctx.lineTo(...P(cL, a, Imax)); ctx.stroke();
      ctx.fillStyle = col; ctx.fillText(n, ...P(cL, a, Imax * 0.9 + 0.6));
    });
    ctx.setLineDash([]);
    // 三相分量首尾相接（幅值不变 Clarke 系数 2/3）
    let x = cL, y = cyy;
    [[snap.ia, 0, C.pa], [snap.ib, TAU / 3, C.pb], [snap.ic, 2 * TAU / 3, C.pc]].forEach(([i, a, col]) => {
      const m = (2 / 3) * i;
      [x, y] = vec(cL, x, y, m >= 0 ? a : a + PI, Math.abs(m), col, 1.6);
    });
    // α/β 投影
    const ex = cL + snap.ialpha * sc, ey = cyy - snap.ibeta * sc;
    ctx.strokeStyle = '#3a4656'; ctx.setLineDash([2 * dpr, 3 * dpr]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex, cyy); ctx.moveTo(ex, ey); ctx.lineTo(cL, ey); ctx.stroke(); ctx.setLineDash([]);
    vec(cL, cL, cyy, snap.ialpha >= 0 ? 0 : PI, Math.abs(snap.ialpha), C.alpha, 2);
    vec(cL, cL, cyy, snap.ibeta >= 0 ? PI / 2 : -PI / 2, Math.abs(snap.ibeta), C.beta, 2);
    vec(cL, cL, cyy, Math.atan2(snap.ibeta, snap.ialpha), Math.hypot(snap.ialpha, snap.ibeta), C.stator, 3);

    // 中间箭头
    ctx.fillStyle = C.muted; ctx.font = `${10.5 * dpr}px sans-serif`; ctx.textAlign = 'center';
    ctx.fillText('Park 变换', W / 2, cyy - 8 * dpr); ctx.fillText('旋转 −θₑ', W / 2, cyy + 16 * dpr);
    U.arrow(ctx, W / 2 - 24 * dpr, cyy + 2 * dpr, W / 2 + 24 * dpr, cyy + 2 * dpr, C.muted, 1.4 * dpr, 7 * dpr);

    // 右：转子坐标
    const cR = W * 0.74; panel(cR, '转子坐标 dq（随转子旋转）');
    const [id, iq] = park(snap.ialpha, snap.ibeta, th);
    ctx.strokeStyle = C.d; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cR - R, cyy); ctx.lineTo(cR + R, cyy); ctx.stroke();
    ctx.strokeStyle = C.q; ctx.beginPath(); ctx.moveTo(cR, cyy + R); ctx.lineTo(cR, cyy - R); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = C.d; ctx.fillText('d', cR + R + 8 * dpr, cyy + 4 * dpr);
    ctx.fillStyle = C.q; ctx.fillText('q', cR, cyy - R - 5 * dpr);
    this.trail.push([id, iq]); if (this.trail.length > 70) this.trail.shift();
    ctx.fillStyle = C.stator;
    this.trail.forEach(([a, b], i) => { ctx.globalAlpha = i / this.trail.length * 0.5; ctx.beginPath(); ctx.arc(cR + a * sc, cyy - b * sc, 1.6 * dpr, 0, TAU); ctx.fill(); });
    ctx.globalAlpha = 1;
    vec(cR, cR, cyy, id >= 0 ? 0 : PI, Math.abs(id), C.d, 2.2);
    vec(cR, cR, cyy, iq >= 0 ? PI / 2 : -PI / 2, Math.abs(iq), C.q, 2.2);
    vec(cR, cR, cyy, Math.atan2(iq, id), Math.hypot(id, iq), C.stator, 3);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.arc(cR + o.idRef * sc, cyy - o.iqRef * sc, 6 * dpr, 0, TAU); ctx.stroke();
  }
}

/* ---------- 气隙磁密展开图 ---------- */
class GapChart {
  constructor(cv) { this.cv = cv; this.ctx = cv.getContext('2d'); }
  render(sim, snap, field, design) {
    const { W, H, dpr } = U.fitCanvas(this.cv), ctx = this.ctx, C = U.COLORS, g = design.g, p = g.p;
    ctx.clearRect(0, 0, W, H);
    const L = 34 * dpr, R = 10 * dpr, T = 20 * dpr, B = 30 * dpr, w = W - L - R, h = H - T - B;
    const Bm = 1.4, X = th => L + th / TAU * w, Y = v => T + h / 2 - v / Bm * h / 2;
    ctx.strokeStyle = '#1a2230'; ctx.lineWidth = 1; ctx.fillStyle = C.dim; ctx.font = `${9.5 * dpr}px sans-serif`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    [-1, -0.5, 0, 0.5, 1].forEach(v => { ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(L + w, Y(v)); ctx.stroke(); ctx.fillText(v.toFixed(1), L - 4 * dpr, Y(v)); });
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (let d = 0; d <= 360; d += 60) ctx.fillText(d + '°', X(d / 180 * PI), H - 4 * dpr);
    // 齿位置 + 相别
    const PC = U.PHASE_COLOR();
    design.winding.coils.forEach(c => {
      const x = X(c.angle);
      ctx.fillStyle = PC[c.phase]; ctx.globalAlpha = 0.12; ctx.fillRect(X(c.angle - g.tipHalf), T, X(2 * g.tipHalf) - L, h); ctx.globalAlpha = 1;
      ctx.font = `700 ${9.5 * dpr}px sans-serif`; ctx.fillText(c.phase.toUpperCase() + (c.sign < 0 ? '′' : ''), x, H - 16 * dpr);
    });
    const N = field.N;
    const line = (fn, col, lw, dash) => {
      ctx.strokeStyle = col; ctx.lineWidth = lw * dpr; ctx.setLineDash(dash ? [5 * dpr, 4 * dpr] : []);
      ctx.beginPath(); for (let k = 0; k <= N; k++) { const kk = k % N, x = X(k / N * TAU), y = Y(fn(kk, k / N * TAU)); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke(); ctx.setLineDash([]);
    };
    const fu = field.fundamental(field.Barm);
    // 电枢磁场通常只有永磁磁场的零点几，按需放大显示（标注倍数）
    const kA = fu.amp > 0.25 ? 1 : fu.amp > 0.1 ? 2 : fu.amp > 0.04 ? 5 : fu.amp > 0.015 ? 10 : 20;
    line(k => field.Bpm[k], C.d, 1.6);
    line(k => field.Barm[k] * kA, C.stator, 1.4);
    line((k, th) => kA * fu.amp * Math.cos(p * th - fu.elec), C.stator, 1.2, true);
    line(k => field.Bpm[k] + field.Barm[k], '#f0f4f8', 1.8);
    // 转子 d 轴、定子磁场基波峰
    const rot = ((snap.thetaM + design.winding.axis.a / p) % TAU + TAU) % TAU;
    const mark = (a, col, txt) => {
      for (let k = 0; k < p; k++) {
        const x = X(((a + k * TAU / p) % TAU + TAU) % TAU);
        ctx.strokeStyle = col; ctx.lineWidth = 1.2 * dpr; ctx.setLineDash([2 * dpr, 3 * dpr]);
        ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + h); ctx.stroke(); ctx.setLineDash([]);
        if (k === 0) { ctx.fillStyle = col; ctx.font = `700 ${10 * dpr}px sans-serif`; ctx.fillText(txt, x, T - 5 * dpr); }
      }
    };
    mark(rot, C.d, 'N(d)');
    if (fu.amp > 0.005) mark(fu.elec / p, C.stator, '定子磁场');
    ctx.textAlign = 'left'; ctx.font = `${10 * dpr}px sans-serif`; ctx.fillStyle = C.muted;
    const lead = ((fu.elec - (snap.thetaM * p + design.winding.axis.a)) * 180 / PI % 360 + 540) % 360 - 180;
    ctx.fillText(fu.amp > 0.005 ? `电枢基波 ${fu.amp.toFixed(3)} T（品红曲线 ×${kA} 显示），超前转子 N 极 ${lead.toFixed(0)}° 电角` : '定子无电流', L + 4 * dpr, T + 12 * dpr);
  }
}

/* ---------- dq 平面：电流圆 / 电压圆 / 工作点 ---------- */
class DqPlane {
  constructor(cv) { this.cv = cv; this.ctx = cv.getContext('2d'); this.trail = []; }
  render(sim) {
    const { W, H, dpr } = U.fitCanvas(this.cv), ctx = this.ctx, C = U.COLORS, m = sim.motor, o = sim.ctrl.out;
    ctx.clearRect(0, 0, W, H);
    const Imax = sim.ctrl.cfg.Imax, ich = m.psi / m.Ld;
    const xmin = -Math.max(1.3 * Imax, ich * 1.12), xmax = 0.55 * Imax, ymax = 1.25 * Imax;
    const s = Math.min((W - 20 * dpr) / (xmax - xmin), (H - 24 * dpr) / (2 * ymax));
    const ox = 10 * dpr + (-xmin) * s + ((W - 20 * dpr) - (xmax - xmin) * s) / 2, oy = H / 2;
    const X = v => ox + v * s, Y = v => oy - v * s;
    ctx.strokeStyle = '#1a2230'; ctx.lineWidth = 1;
    const st = U.niceStep(ymax, 3);
    for (let v = Math.ceil(xmin / st) * st; v <= xmax; v += st) { ctx.beginPath(); ctx.moveTo(X(v), 0); ctx.lineTo(X(v), H); ctx.stroke(); }
    for (let v = -Math.floor(ymax / st) * st; v <= ymax; v += st) { ctx.beginPath(); ctx.moveTo(0, Y(v)); ctx.lineTo(W, Y(v)); ctx.stroke(); }
    ctx.strokeStyle = '#3a4656'; ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(W, oy); ctx.moveTo(X(0), 0); ctx.lineTo(X(0), H); ctx.stroke();
    ctx.fillStyle = C.d; ctx.font = `${10.5 * dpr}px sans-serif`; ctx.textAlign = 'right'; ctx.fillText('i_d (A)', W - 6 * dpr, oy - 6 * dpr);
    ctx.fillStyle = C.q; ctx.textAlign = 'left'; ctx.fillText('i_q (A)', X(0) + 5 * dpr, 13 * dpr);
    const we = Math.abs(m.omega * m.p), Vmax = sim.Vdc / Math.sqrt(3);
    const rV = we > 1 ? Vmax / (we * m.Ld) : Infinity;
    // 可行域 = 电流圆 ∩ 电压圆
    ctx.save();
    ctx.beginPath(); ctx.arc(X(0), Y(0), Imax * s, 0, TAU); ctx.clip();
    if (isFinite(rV)) { ctx.beginPath(); ctx.arc(X(-ich), Y(0), Math.min(rV, 1e4) * s, 0, TAU); ctx.clip(); }
    ctx.fillStyle = 'rgba(61,220,151,.09)'; ctx.fillRect(0, 0, W, H);
    ctx.restore();
    ctx.strokeStyle = '#8b97a7'; ctx.lineWidth = 1.4 * dpr; ctx.beginPath(); ctx.arc(X(0), Y(0), Imax * s, 0, TAU); ctx.stroke();
    if (isFinite(rV) && rV * s < 1e5) { ctx.strokeStyle = C.alpha; ctx.beginPath(); ctx.arc(X(-ich), Y(0), rV * s, 0, TAU); ctx.stroke(); }
    ctx.fillStyle = C.alpha; ctx.beginPath(); ctx.arc(X(-ich), Y(0), 3 * dpr, 0, TAU); ctx.fill();
    ctx.font = `${10 * dpr}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText('−ψf/L', X(-ich), Y(0) + 13 * dpr);
    // MTPA 与等转矩线
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.strokeStyle = C.good; ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(X(0), Y(-Imax)); ctx.lineTo(X(0), Y(Imax)); ctx.stroke(); ctx.globalAlpha = 1;
    const iqT = m.Te / m.Kt;
    ctx.strokeStyle = C.q; ctx.beginPath(); ctx.moveTo(0, Y(iqT)); ctx.lineTo(W, Y(iqT)); ctx.stroke();
    ctx.setLineDash([]);
    // 工作点
    this.trail.push([o.id, o.iq]); if (this.trail.length > 120) this.trail.shift();
    ctx.fillStyle = '#fff';
    this.trail.forEach(([a, b], i) => { ctx.globalAlpha = i / this.trail.length * 0.4; ctx.beginPath(); ctx.arc(X(a), Y(b), 1.5 * dpr, 0, TAU); ctx.fill(); });
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 * dpr; ctx.beginPath(); ctx.arc(X(o.idRef), Y(o.iqRef), 6 * dpr, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(X(o.id), Y(o.iq), 4 * dpr, 0, TAU); ctx.fill();
    // 注释
    ctx.textAlign = 'left'; ctx.fillStyle = C.muted; ctx.font = `${10.5 * dpr}px sans-serif`;
    const lines = [`n = ${(m.omega * 30 / PI).toFixed(0)} rpm，V_max = ${Vmax.toFixed(1)} V`,
      isFinite(rV) ? `电压圆半径 ${rV.toFixed(1)} A` : '静止：电压圆无穷大', `工作点 (${o.id.toFixed(2)}, ${o.iq.toFixed(2)}) A`];
    lines.forEach((t, i) => ctx.fillText(t, 8 * dpr, 16 * dpr + i * 14 * dpr));
    ctx.fillStyle = C.good; ctx.fillText('MTPA (i_d = 0)', X(0) + 5 * dpr, Y(-Imax) + 2 * dpr);
  }
}

FOC.charts = { Scope, VectorChart, GapChart, DqPlane, WINDOWS };
})(window.FOC);
