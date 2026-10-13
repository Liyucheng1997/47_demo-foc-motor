/* =========================================================================
   fluxmap.js —— 二维磁场剖面：|B| 云图 + 磁力线（磁通函数 ψ 的等值线）
   ψ(r,θ) 由 machine.AirgapField 给出；在极坐标网格上：
     |B| = sqrt((1/r·∂ψ/∂θ)² + (∂ψ/∂r)²)，磁力线 = marching squares 等值线
   相邻两条磁力线之间的磁通量相等，所以线越密磁场越强
   ========================================================================= */
(function (FOC) {
'use strict';
const { PI, TAU, wrapPi } = FOC.math;
const M = FOC.machine, REG = M.REG;
const REG_NAME = ['外部', '定子轭', '定子齿', '槽（绕组）', '气隙', '磁钢 N 极', '磁钢 S 极', '转子轭', '转轴'];

/* 云图配色（深蓝 → 青 → 黄 → 橙红），0 ~ BMAX 特斯拉 */
const BMAX = 2.0;
const LUT = (() => {
  const stops = [[0, [13, 27, 42]], [0.2, [31, 92, 160]], [0.4, [38, 160, 170]], [0.6, [150, 200, 90]], [0.75, [242, 193, 78]], [0.88, [240, 110, 60]], [1, [215, 38, 61]]];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255; let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1], f = (t - t0) / (t1 - t0);
    for (let j = 0; j < 3; j++) lut[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * f;
  }
  return lut;
})();

class FluxMap {
  constructor(canvas, hoverEl) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.off = document.createElement('canvas'); this.offCtx = this.off.getContext('2d');
    this.hoverEl = hoverEl; this.mouse = null;
    canvas.addEventListener('mousemove', e => { const r = canvas.getBoundingClientRect(); this.mouse = [e.clientX - r.left, e.clientY - r.top]; });
    canvas.addEventListener('mouseleave', () => { this.mouse = null; if (hoverEl) hoverEl.textContent = ''; });
  }

  setDesign(design) {
    this.design = design;
    const g = design.g;
    this.Nt = 720; this.Nr = 104;
    const { Nr, Nt } = this;
    this.r = new Float64Array(Nr);
    for (let i = 0; i < Nr; i++) this.r[i] = g.Rshaft + (g.Rout - g.Rshaft) * i / (Nr - 1);
    this.dr = this.r[1] - this.r[0]; this.dt = TAU / Nt;
    this.cosT = new Float64Array(Nt); this.sinT = new Float64Array(Nt);
    this.tIdx = new Int16Array(Nt); this.tOff = new Float64Array(Nt);
    for (let j = 0; j < Nt; j++) {
      const th = j * this.dt; this.cosT[j] = Math.cos(th); this.sinT[j] = Math.sin(th);
      const i = Math.round(th / g.pitch); this.tIdx[j] = i % g.Ns; this.tOff[j] = wrapPi(th - i * g.pitch);
    }
    this.hb = new Float64Array(Nr);
    for (let i = 0; i < Nr; i++) this.hb[i] = Math.asin(Math.min(1, (g.toothW / 2) / this.r[i]));
    this.hbSlot = Math.asin(Math.min(1, (g.toothW / 2) / g.Rslot));
    this.psi = new Float64Array(Nr * Nt); this.Bm = new Float32Array(Nr * Nt);
    this.sL = new Float64Array(g.Ns); this.sR = new Float64Array(g.Ns);
    this.contour = M.statorInnerContour(g, 8);
    // 参考磁力线间距：空载永磁磁通的 1/6（每半个极约 6 条线）
    const f = new M.AirgapField(design).compute(0, 0, 0, 0, 'pm');
    let mx = 0; for (let k = 0; k < f.N; k++) mx = Math.max(mx, Math.abs(f.Phi[k]));
    this.stepPM = mx / 6;
    this.pixKey = '';
  }

  /* 画布像素 ↔ 电机坐标的映射与逐像素查表（尺寸或方案变化时重建） */
  _layout(W, H) {
    const g = this.design.g;
    this.Rv = g.Rout + 0.02;
    const cb = 64 * (this.dpr || 1);                 // 右侧给色标留白
    this.s = Math.min(W - cb, H - 30 * (this.dpr || 1)) / 2 / (g.Rout + 0.8);
    this.cx = (W - cb) / 2; this.cy = H / 2;
    const Nh = Math.min(440, Math.round(2 * this.Rv * this.s / (this.dpr > 1.5 ? 2 : 1.4)));
    const key = `${Nh}|${this.design.id}`;
    if (key === this.pixKey) return;
    this.pixKey = key; this.Nh = Nh;
    this.off.width = this.off.height = Nh;
    this.img = this.offCtx.createImageData(Nh, Nh);
    const n = Nh * Nh;
    this.pFr = new Float32Array(n); this.pFt = new Float32Array(n);
    this.pR = new Float32Array(n); this.pT = new Float32Array(n); this.pReg = new Int8Array(n);
    for (let v = 0; v < Nh; v++) for (let u = 0; u < Nh; u++) {
      const k = v * Nh + u;
      const x = ((u + 0.5) / Nh * 2 - 1) * this.Rv, y = (1 - (v + 0.5) / Nh * 2) * this.Rv;
      const r = Math.hypot(x, y), th = (Math.atan2(y, x) + TAU) % TAU;
      this.pR[k] = r; this.pT[k] = th;
      this.pFr[k] = (r - g.Rshaft) / this.dr; this.pFt[k] = th / this.dt;
      this.pReg[k] = r > g.Rout ? REG.OUT : M.statorRegion(g, r, th);   // −1 = 转子侧，逐帧判断
    }
  }

  _fillPsi(field) {
    const g = this.design.g, { Nr, Nt, r, hb, psi, tIdx, tOff, sL, sR } = this;
    const Phi = field.Phi;
    for (let i = 0; i < g.Ns; i++) { sL[i] = field.phiAt(i * g.pitch - g.pitch / 2); sR[i] = field.phiAt(i * g.pitch + g.pitch / 2); }
    const ch = (j, h) => {
      const i = tIdx[j], d = tOff[j];
      if (d >= -h && d <= h) return sL[i] + (sR[i] - sL[i]) * (d + h) / (2 * h);
      return d > 0 ? sR[i] : sL[i];
    };
    const blendW = g.shoe + g.taper;
    for (let i = 0; i < Nr; i++) {
      const ri = r[i], row = i * Nt;
      if (ri >= g.Rslot) {
        const f = (g.Rout - ri) / (g.Rout - g.Rslot);
        for (let j = 0; j < Nt; j++) psi[row + j] = ch(j, this.hbSlot) * f;
      } else if (ri >= g.Rbody0) {
        for (let j = 0; j < Nt; j++) psi[row + j] = ch(j, hb[i]);
      } else if (ri >= g.Rbore) {
        let t = (ri - g.Rbore) / blendW; t = t * t * (3 - 2 * t);
        const h = Math.asin(Math.min(1, (g.toothW / 2) / g.Rbody0));
        for (let j = 0; j < Nt; j++) psi[row + j] = Phi[j] * (1 - t) + ch(j, h) * t;
      } else if (ri >= g.Rcore) {
        for (let j = 0; j < Nt; j++) psi[row + j] = Phi[j];
      } else {
        const f = (ri - g.Rshaft) / (g.Rcore - g.Rshaft);
        for (let j = 0; j < Nt; j++) psi[row + j] = Phi[j] * f;
      }
    }
    // |B|：中心差分（θ 方向周期）
    const { Bm, dr, dt } = this;
    for (let i = 0; i < Nr; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(Nr - 1, i + 1), ri = r[i];
      for (let j = 0; j < Nt; j++) {
        const jm = (j + Nt - 1) % Nt, jp = (j + 1) % Nt;
        const Br = (psi[i * Nt + jp] - psi[i * Nt + jm]) / (2 * dt * ri);
        const Bt = (psi[i1 * Nt + j] - psi[i0 * Nt + j]) / ((i1 - i0) * dr);
        Bm[i * Nt + j] = Math.hypot(Br, Bt);
      }
    }
  }

  _sampleB(fr, ft) {
    const { Nr, Nt, Bm } = this;
    if (fr < 0) fr = 0; if (fr > Nr - 1.001) fr = Nr - 1.001;
    const i = fr | 0, j = ft | 0, a = fr - i, b = ft - j, j0 = j % Nt, j1 = (j + 1) % Nt;
    return (Bm[i * Nt + j0] * (1 - b) + Bm[i * Nt + j1] * b) * (1 - a) + (Bm[(i + 1) * Nt + j0] * (1 - b) + Bm[(i + 1) * Nt + j1] * b) * a;
  }

  _heat(rot) {
    const g = this.design.g, n = this.Nh * this.Nh, d = this.img.data;
    const { pFr, pFt, pR, pT, pReg } = this;
    for (let k = 0; k < n; k++) {
      let reg = pReg[k];
      const o = k * 4;
      if (reg === REG.OUT) { d[o + 3] = 0; continue; }
      if (reg < 0) reg = M.rotorRegion(g, pR[k], pT[k], rot);
      if (reg === REG.SLOT) { d[o] = 20; d[o + 1] = 26; d[o + 2] = 35; d[o + 3] = 255; continue; }
      if (reg === REG.SHAFT) { d[o] = 58; d[o + 1] = 66; d[o + 2] = 78; d[o + 3] = 255; continue; }
      const B = this._sampleB(pFr[k], pFt[k]);
      const li = Math.min(255, (B / BMAX * 255) | 0) * 3;
      let rr = LUT[li], gg = LUT[li + 1], bb = LUT[li + 2];
      if (reg === REG.GAP) { rr = rr * 0.45 + 8; gg = gg * 0.45 + 11; bb = bb * 0.45 + 16; }
      else if (reg === REG.MAGN) { rr = rr * 0.35 + 150; gg = gg * 0.35 + 40; bb = bb * 0.35 + 48; }
      else if (reg === REG.MAGS) { rr = rr * 0.35 + 34; gg = gg * 0.35 + 76; bb = bb * 0.35 + 170; }
      d[o] = rr; d[o + 1] = gg; d[o + 2] = bb; d[o + 3] = 255;
    }
    this.offCtx.putImageData(this.img, 0, 0);
  }

  /* marching squares：一次性收集所有线段再描边 */
  _contours(step) {
    const { Nr, Nt, psi, r, cosT, sinT, ctx, cx, cy, s } = this;
    if (!(step > 0)) return;
    const P = (ri, j, fj) => {           // 半格插值点 → 画布坐标
      const c = cosT[j] + (cosT[(j + 1) % Nt] - cosT[j]) * fj, sn = sinT[j] + (sinT[(j + 1) % Nt] - sinT[j]) * fj;
      return [cx + ri * c * s, cy - ri * sn * s];
    };
    ctx.beginPath();
    for (let i = 0; i < Nr - 1; i++) {
      const r0 = r[i], r1 = r[i + 1];
      for (let j = 0; j < Nt; j++) {
        const jp = (j + 1) % Nt;
        const a = psi[i * Nt + j], b = psi[i * Nt + jp], c = psi[(i + 1) * Nt + jp], d = psi[(i + 1) * Nt + j];
        const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
        if (hi - lo < 1e-12) continue;
        const k0 = Math.ceil(lo / step - 0.5), k1 = Math.floor(hi / step - 0.5);
        for (let k = k0; k <= k1; k++) {
          const L = (k + 0.5) * step;
          const pts = [];
          // 边：a-b（r0, θ 向），b-c（θ1, r 向），c-d（r1），d-a（θ0）
          if ((a - L) * (b - L) < 0) pts.push(P(r0, j, (L - a) / (b - a)));
          if ((b - L) * (c - L) < 0) { const f = (L - b) / (c - b), rr = r0 + (r1 - r0) * f; pts.push([cx + rr * cosT[jp] * s, cy - rr * sinT[jp] * s]); }
          if ((d - L) * (c - L) < 0) pts.push(P(r1, j, (L - d) / (c - d)));
          if ((a - L) * (d - L) < 0) { const f = (L - a) / (d - a), rr = r0 + (r1 - r0) * f; pts.push([cx + rr * cosT[j] * s, cy - rr * sinT[j] * s]); }
          if (pts.length >= 2) { ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); }
          if (pts.length === 4) { ctx.moveTo(pts[2][0], pts[2][1]); ctx.lineTo(pts[3][0], pts[3][1]); }
        }
      }
    }
    ctx.stroke();
  }

  render(sim, snap, field, view) {
    const { W, H, dpr } = FOC.ui.fitCanvas(this.cv, true);
    this.dpr = dpr;
    if (!this.design) return;
    this._layout(W, H);
    const ctx = this.ctx, des = this.design, g = des.g, p = g.p, s = this.s, cx = this.cx, cy = this.cy;
    const phiA = des.winding.axis.a, rot = snap.thetaM + phiA / p;
    const C = FOC.ui.COLORS, X = (x, y) => [cx + x * s, cy - y * s];

    this._fillPsi(field);
    this._heat(rot);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.off, cx - this.Rv * s, cy - this.Rv * s, 2 * this.Rv * s, 2 * this.Rv * s);

    // 槽内线圈截面（双层：每槽两条线圈边）+ 电流方向
    const cur = { a: snap.ia, b: snap.ib, c: snap.ic }, PC = FOC.ui.PHASE_COLOR();
    const Iref = Math.max(4, sim.ctrl.cfg.Imax * 0.7), w2 = g.toothW / 2;
    const x0 = g.Rbody0 + 0.03, x1 = g.Rbody1 - 0.03, tn = Math.tan(g.pitch / 2);
    des.winding.coils.forEach(c => {
      const v = cur[c.phase] * c.sign, a = Math.min(1, Math.abs(v) / Iref);
      const ca = Math.cos(c.angle), sa = Math.sin(c.angle);
      const G = (xl, yl) => X(xl * ca - yl * sa, xl * sa + yl * ca);
      [1, -1].forEach(side => {
        const poly = [G(x0, side * (w2 + 0.025)), G(x1, side * (w2 + 0.025)), G(x1, side * (x1 * tn - 0.03)), G(x0, side * (x0 * tn - 0.03))];
        ctx.beginPath(); poly.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
        ctx.globalAlpha = 0.18 + 0.6 * a; ctx.fillStyle = PC[c.phase]; ctx.fill();
        ctx.globalAlpha = 0.9; ctx.strokeStyle = PC[c.phase]; ctx.lineWidth = 1 * dpr; ctx.stroke();
        // 导体符号：v>0 时 +y 侧（逆时针侧）⊙ 流出纸面
        const xm = (x0 + x1) / 2, ym = side * (w2 + 0.025 + (xm * tn - 0.03 - w2 - 0.025) / 2);
        const [sx, sy] = G(xm, ym), rr = Math.min(9 * dpr, s * 0.13);
        ctx.globalAlpha = 0.35 + 0.65 * a;
        ctx.fillStyle = 'rgba(8,11,16,.8)'; ctx.beginPath(); ctx.arc(sx, sy, rr * 1.15, 0, 7); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4 * dpr; ctx.beginPath(); ctx.arc(sx, sy, rr, 0, 7); ctx.stroke();
        const out = (v >= 0) === (side > 0);
        if (out) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx, sy, rr * 0.32, 0, 7); ctx.fill(); }
        else { const q = rr * 0.62; ctx.beginPath(); ctx.moveTo(sx - q, sy - q); ctx.lineTo(sx + q, sy + q); ctx.moveTo(sx + q, sy - q); ctx.lineTo(sx - q, sy + q); ctx.stroke(); }
        ctx.globalAlpha = 1;
      });
      // 齿外的相别字母
      const [lx, ly] = X(Math.cos(c.angle) * (g.Rout + 0.3), Math.sin(c.angle) * (g.Rout + 0.3));
      ctx.fillStyle = PC[c.phase]; ctx.font = `700 ${12 * dpr}px "Segoe UI",sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(c.phase.toUpperCase() + (c.sign < 0 ? '′' : ''), lx, ly);
    });

    // 磁力线
    const step = view === 'arm' ? (() => { let mx = 0; for (let k = 0; k < field.N; k++) mx = Math.max(mx, Math.abs(field.Phi[k])); return mx > 1e-6 ? mx / 5 : 0; })() : this.stepPM;
    ctx.strokeStyle = 'rgba(240,244,250,.78)'; ctx.lineWidth = 1.1 * dpr;
    this._contours(step);

    // 轮廓线
    ctx.strokeStyle = 'rgba(170,184,204,.55)'; ctx.lineWidth = 1 * dpr;
    ctx.beginPath(); this.contour.forEach(([x, y], i) => { const [a, b] = X(x, y); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }); ctx.closePath(); ctx.stroke();
    [g.Rout, g.Rcore, g.Rshaft].forEach(R => { ctx.beginPath(); ctx.arc(cx, cy, R * s, 0, TAU); ctx.stroke(); });
    const span = PI / p, arc = span * g.magArc;
    for (let k = 0; k < 2 * p; k++) {
      const c = rot + k * span;
      ctx.beginPath(); ctx.arc(cx, cy, g.Rmag * s, -(c + arc / 2), -(c - arc / 2)); ctx.arc(cx, cy, g.Rcore * s, -(c - arc / 2), -(c + arc / 2), true); ctx.closePath(); ctx.stroke();
      const [mx, my] = X(Math.cos(c) * (g.Rcore + g.Rmag) / 2, Math.sin(c) * (g.Rcore + g.Rmag) / 2);
      ctx.fillStyle = '#fff'; ctx.font = `700 ${(p > 4 ? 9 : 11) * dpr}px sans-serif`;
      ctx.fillText(k % 2 ? 'S' : 'N', mx, my);
    }

    // 相轴（第一对极）
    ctx.setLineDash([5 * dpr, 5 * dpr]); ctx.lineWidth = 1.2 * dpr; ctx.font = `600 ${11 * dpr}px "Segoe UI",sans-serif`;
    ['a', 'b', 'c'].forEach(ph => {
      const ang = des.winding.axis[ph] / p;
      const [ex, ey] = X(Math.cos(ang) * (g.Rout + 0.62), Math.sin(ang) * (g.Rout + 0.62));
      ctx.strokeStyle = PC[ph]; ctx.globalAlpha = 0.65;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillStyle = PC[ph]; ctx.fillText(ph.toUpperCase() + ' 轴', ex + Math.cos(ang) * 14 * dpr, ey - Math.sin(ang) * 10 * dpr);
    });
    ctx.setLineDash([]);

    // d / q 轴与定子电流矢量
    const dq = (ang, L, col, txt, lw) => {
      const [ex, ey] = X(Math.cos(ang) * L, Math.sin(ang) * L);
      FOC.ui.arrow(ctx, cx, cy, ex, ey, col, lw * dpr, 10 * dpr);
      ctx.fillStyle = col; ctx.font = `700 ${13 * dpr}px "Segoe UI",sans-serif`;
      ctx.fillText(txt, ex + Math.cos(ang) * 11 * dpr, ey - Math.sin(ang) * 11 * dpr);
    };
    dq(rot, g.Rcore * 0.95, C.d, 'd', 2.2);
    dq(rot + PI / 2 / p, g.Rcore * 0.8, C.q, 'q', 1.8);
    const imag = Math.hypot(snap.ialpha, snap.ibeta);
    if (imag > 0.05) {
      let sAng = (Math.atan2(snap.ibeta, snap.ialpha) + phiA) / p;
      sAng += Math.round((rot + PI / 2 / p - sAng) / (TAU / p)) * (TAU / p);
      dq(sAng, Math.min(g.Rbore * 0.98, 0.3 + imag * 0.13), C.stator, 'iₛ', 3);
    }

    // 色标
    const bw = 12 * dpr, bh = Math.min(H * 0.42, 190 * dpr), bx = W - bw - 34 * dpr, by = H - bh - 22 * dpr;
    for (let i = 0; i < bh; i++) {
      const li = Math.min(255, ((1 - i / bh) * 255) | 0) * 3;
      ctx.fillStyle = `rgb(${LUT[li]},${LUT[li + 1]},${LUT[li + 2]})`; ctx.fillRect(bx, by + i, bw, 1.5);
    }
    ctx.strokeStyle = '#3a4656'; ctx.lineWidth = 1; ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = C.muted; ctx.font = `${10 * dpr}px sans-serif`; ctx.textAlign = 'left';
    [0, 0.5, 1, 1.5, 2].forEach(v => ctx.fillText(v.toFixed(1), bx + bw + 4 * dpr, by + bh * (1 - v / BMAX)));
    ctx.textAlign = 'center'; ctx.fillText('|B| / T', bx + bw / 2 + 6 * dpr, by - 10 * dpr);
    ctx.textAlign = 'left'; ctx.fillStyle = C.dim;
    ctx.fillText('白线 = 磁力线（相邻两线间磁通相等，越密越强） · 解析模型示意，非有限元', 12 * dpr, H - 10 * dpr);

    // 悬停读数
    if (this.mouse && this.hoverEl) {
      const x = (this.mouse[0] * dpr - cx) / s, y = -(this.mouse[1] * dpr - cy) / s;
      const r = Math.hypot(x, y), th = (Math.atan2(y, x) + TAU) % TAU;
      let reg = r > g.Rout ? REG.OUT : M.statorRegion(g, r, th);
      if (reg < 0) reg = M.rotorRegion(g, r, th, rot);
      const B = reg === REG.OUT || reg === REG.SHAFT || reg === REG.SLOT ? 0 : this._sampleB((r - g.Rshaft) / this.dr, th / this.dt);
      this.hoverEl.textContent = `${REG_NAME[reg]} · |B| ≈ ${B.toFixed(2)} T`;
    }
  }
}

FOC.FluxMap = FluxMap;
})(window.FOC);
