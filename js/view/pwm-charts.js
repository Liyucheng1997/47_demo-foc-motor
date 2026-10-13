/* =========================================================================
   pwm-charts.js —— SVPWM 六边形、马鞍波、载波比较、三相逆变桥
   carrier = { phase: 0..1 载波相位, real: 是否与仿真同步, sw: [Sa,Sb,Sc] }
   ========================================================================= */
(function (FOC) {
'use strict';
const { PI, TAU } = FOC.math;
const U = FOC.ui;

class HexChart {
  constructor(cv) { this.cv = cv; this.ctx = cv.getContext('2d'); this.tips = []; }
  render(sim, carrier) {
    const { W, H, dpr } = U.fitCanvas(this.cv), ctx = this.ctx, C = U.COLORS, sv = sim.svApplied;
    ctx.clearRect(0, 0, W, H);
    const cx = W * 0.5, cy = H * 0.5, R = Math.min(W * 0.33, H * 0.38);
    const P = (a, r) => [cx + Math.cos(a) * r, cy - Math.sin(a) * r];
    // 扇区高亮
    ctx.fillStyle = 'rgba(88,166,255,.10)';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(...P(sv.sector * PI / 3, R)); ctx.lineTo(...P((sv.sector + 1) * PI / 3, R)); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#2b3543'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); for (let k = 0; k <= 6; k++) { const [x, y] = P(k * PI / 3, R); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke();
    ctx.setLineDash([3 * dpr, 4 * dpr]); ctx.beginPath(); ctx.arc(cx, cy, R * Math.sqrt(3) / 2, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = `${10 * dpr}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let k = 0; k < 6; k++) {
      const act = k === sv.sector || k === (sv.sector + 1) % 6;
      ctx.strokeStyle = act ? C.accent : '#3a4656'; ctx.lineWidth = (act ? 1.6 : 1) * dpr;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(...P(k * PI / 3, R)); ctx.stroke();
      const [lx, ly] = P(k * PI / 3, R + 18 * dpr);
      ctx.fillStyle = act ? C.text : C.muted;
      ctx.fillText(`U${k + 1}`, lx, ly - 6 * dpr); ctx.fillText(`(${FOC.SVBITS[k]})`, lx, ly + 6 * dpr);
    }
    // Uref 轨迹
    const scale = R / (2 / 3 * sim.Vdc);
    const Vm = sv.m * sim.Vdc / Math.sqrt(3), Va = sv.angle;
    const ex = cx + Math.cos(Va) * Vm * scale, ey = cy - Math.sin(Va) * Vm * scale;
    this.tips.push([ex, ey]); if (this.tips.length > 140) this.tips.shift();
    ctx.fillStyle = C.stator;
    this.tips.forEach(([x, y], i) => { ctx.globalAlpha = i / this.tips.length * 0.35; ctx.beginPath(); ctx.arc(x, y, 1.6 * dpr, 0, TAU); ctx.fill(); });
    ctx.globalAlpha = 1;
    // T1 / T2 分解（头尾相接）
    const a0 = sv.sector * PI / 3, a1 = a0 + PI / 3;
    const p1x = cx + Math.cos(a0) * sv.T1 * R, p1y = cy - Math.sin(a0) * sv.T1 * R;
    const tx = p1x + Math.cos(a1) * sv.T2 * R, ty = p1y - Math.sin(a1) * sv.T2 * R;
    ctx.lineWidth = 2.6 * dpr;
    ctx.strokeStyle = C.alpha; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p1x, p1y); ctx.stroke();
    ctx.strokeStyle = C.beta; ctx.beginPath(); ctx.moveTo(p1x, p1y); ctx.lineTo(tx, ty); ctx.stroke();
    U.arrow(ctx, cx, cy, ex, ey, C.stator, 3 * dpr, 10 * dpr);
    ctx.fillStyle = C.stator; ctx.fillText('U_ref', ex + 16 * dpr * Math.cos(Va), ey - 14 * dpr * Math.sin(Va));
    // 当前开关状态
    const bits = carrier.sw.join(''), k = FOC.SVBITS.indexOf(bits);
    const [mx, my] = k >= 0 ? P(k * PI / 3, R) : [cx, cy];
    ctx.fillStyle = '#ffd34d'; ctx.beginPath(); ctx.arc(mx, my, 5.5 * dpr, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,211,77,.45)'; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.arc(mx, my, 9 * dpr, 0, TAU); ctx.stroke();
    ctx.textAlign = 'left'; ctx.font = `${11 * dpr}px sans-serif`;
    ctx.fillStyle = '#ffd34d'; ctx.fillText(`此刻输出 ${bits} ${k >= 0 ? '(U' + (k + 1) + ')' : '(零矢量)'}`, 8 * dpr, 14 * dpr);
    ctx.fillStyle = sv.m > 0.995 ? C.bad : C.muted;
    ctx.fillText(`m = ${sv.m.toFixed(2)}${sv.m > 0.995 ? '  电压饱和' : ''}`, 8 * dpr, 30 * dpr);
    // 时间分配条
    const bx = 10 * dpr, bw = W - 20 * dpr, by = H - 13 * dpr, bh = 7 * dpr;
    ctx.fillStyle = '#1c2430'; ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = C.alpha; ctx.fillRect(bx, by, bw * sv.T1, bh);
    ctx.fillStyle = C.beta; ctx.fillRect(bx + bw * sv.T1, by, bw * sv.T2, bh);
    ctx.fillStyle = C.dim; ctx.font = `${9 * dpr}px sans-serif`;
    ctx.fillText('一个开关周期的时间分配  T1 | T2 | T0', bx, by - 5 * dpr);
  }
}

/* 马鞍波：取示波器快速通道中的占空比 */
class DutyChart {
  constructor(cv) { this.cv = cv; this.ctx = cv.getContext('2d'); }
  render(sim, win) {
    const { W, H, dpr } = U.fitCanvas(this.cv), ctx = this.ctx, C = U.COLORS, rec = sim.fast;
    ctx.clearRect(0, 0, W, H);
    const y = d => H * (0.92 - 0.84 * d);
    ctx.strokeStyle = '#1c2430'; ctx.lineWidth = 1;
    [0, 0.5, 1].forEach(v => { ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(W, y(v)); ctx.stroke(); });
    ctx.fillStyle = C.dim; ctx.font = `${9 * dpr}px sans-serif`; ctx.textAlign = 'left';
    ctx.fillText('100%', 3 * dpr, y(1) + 10 * dpr); ctx.fillText('50%', 3 * dpr, y(0.5) - 3 * dpr); ctx.fillText('0', 3 * dpr, y(0) - 3 * dpr);
    if (rec.count < 2) return;
    const tEnd = rec.t[rec.idx(rec.count - 1)], t0 = tEnd - win;
    const i0 = rec.lowerBound(t0), n = rec.count - i0, stepI = Math.max(1, Math.floor(n / (W / dpr)));
    [['da', C.pa], ['db', C.pb], ['dc', C.pc]].forEach(([ch, col]) => {
      ctx.strokeStyle = col; ctx.lineWidth = 1.6 * dpr; ctx.beginPath();
      for (let i = i0, f = true; i < rec.count; i += stepI) {
        const ix = rec.idx(i), x = (rec.t[ix] - t0) / win * W, yy = y(rec.ch[ch][ix]);
        f ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy); f = false;
      }
      ctx.stroke();
    });
    ctx.textAlign = 'right'; ctx.fillStyle = C.dim; ctx.fillText(`最近 ${U.fmtTime(win)}`, W - 4 * dpr, 10 * dpr);
  }
}

class PwmChart {
  constructor(cv) { this.cv = cv; this.ctx = cv.getContext('2d'); }
  render(sim, carrier) {
    const { W, H, dpr } = U.fitCanvas(this.cv), ctx = this.ctx, C = U.COLORS;
    ctx.clearRect(0, 0, W, H);
    const padL = 30 * dpr, padR = 18 * dpr, pw = W - padL - padR;
    const X = t => padL + t * pw, top = 12 * dpr, bot = H * 0.42, Y = v => bot - (bot - top) * v;
    const d = sim.duty, cols = [C.pa, C.pb, C.pc], names = ['A', 'B', 'C'];
    const bs = [...new Set([0, 1, ...d.flatMap(x => [(1 - x) / 2, (1 + x) / 2])])].sort((a, b) => a - b);
    ctx.strokeStyle = 'rgba(139,151,167,.15)'; ctx.lineWidth = 1;
    bs.forEach(b => { ctx.beginPath(); ctx.moveTo(X(b), top); ctx.lineTo(X(b), H * 0.97); ctx.stroke(); });
    ctx.strokeStyle = C.muted; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(X(0), Y(1)); ctx.lineTo(X(0.5), Y(0)); ctx.lineTo(X(1), Y(1)); ctx.stroke();
    ctx.fillStyle = C.dim; ctx.font = `${9 * dpr}px sans-serif`; ctx.textAlign = 'right';
    ctx.fillText('1', padL - 4 * dpr, Y(1) + 3 * dpr); ctx.fillText('0', padL - 4 * dpr, Y(0) + 3 * dpr);
    ctx.textAlign = 'left'; ctx.fillText('三角载波', X(0.3), Y(0.92));
    d.forEach((x, i) => {
      ctx.strokeStyle = cols[i]; ctx.lineWidth = 1 * dpr; ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.moveTo(X(0), Y(x)); ctx.lineTo(X(1), Y(x)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = cols[i]; ctx.fillText('d' + names[i].toLowerCase(), X(1) + 3 * dpr, Y(x) + 3 * dpr);
    });
    // 每段开关状态
    ctx.font = `${8.5 * dpr}px ${getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace'}`; ctx.textAlign = 'center';
    for (let i = 0; i < bs.length - 1; i++) {
      if ((bs[i + 1] - bs[i]) * pw < 20 * dpr) continue;
      const mid = (bs[i] + bs[i + 1]) / 2, tri = Math.abs(1 - 2 * mid), bits = d.map(x => x > tri ? 1 : 0).join('');
      ctx.fillStyle = bits === '000' || bits === '111' ? C.dim : C.text;
      ctx.fillText(bits, X(mid), H * 0.475);
    }
    // 门极波形
    const rowTop = H * 0.51, rowH = (H * 0.97 - rowTop) / 3;
    ctx.font = `${9 * dpr}px sans-serif`;
    d.forEach((x, i) => {
      const yLo = rowTop + i * rowH + rowH * 0.78, yHi = rowTop + i * rowH + rowH * 0.18, t0 = (1 - x) / 2, t1 = (1 + x) / 2;
      ctx.strokeStyle = cols[i]; ctx.lineWidth = 1.8 * dpr; ctx.beginPath();
      ctx.moveTo(X(0), yLo); ctx.lineTo(X(t0), yLo); ctx.lineTo(X(t0), yHi); ctx.lineTo(X(t1), yHi); ctx.lineTo(X(t1), yLo); ctx.lineTo(X(1), yLo); ctx.stroke();
      ctx.fillStyle = cols[i]; ctx.textAlign = 'right'; ctx.fillText('S' + names[i], padL - 4 * dpr, (yLo + yHi) / 2 + 3 * dpr);
    });
    const xc = X(carrier.phase);
    ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = 1.5 * dpr; ctx.beginPath(); ctx.moveTo(xc, top); ctx.lineTo(xc, H * 0.97); ctx.stroke();
    ctx.fillStyle = '#ffd34d'; ctx.beginPath(); ctx.arc(xc, Y(Math.abs(1 - 2 * carrier.phase)), 3.5 * dpr, 0, TAU); ctx.fill();
    ctx.textAlign = 'right'; ctx.fillStyle = C.dim; ctx.fillText(`Ts = ${U.fmtTime(sim.Ts)}`, W - 4 * dpr, top);
  }
}

class BridgeChart {
  constructor(cv) { this.cv = cv; this.ctx = cv.getContext('2d'); }
  render(sim, snap, carrier) {
    const { W, H, dpr } = U.fitCanvas(this.cv), ctx = this.ctx, C = U.COLORS;
    ctx.clearRect(0, 0, W, H);
    const topY = H * 0.12, botY = H * 0.88, midY = (topY + botY) / 2;
    const legX = [W * 0.3, W * 0.45, W * 0.6], busX = W * 0.1, mx = W * 0.86, my = midY, mr = Math.min(H * 0.16, W * 0.07);
    const cols = [C.pa, C.pb, C.pc], sw = carrier.sw, cur = [snap.ia, snap.ib, snap.ic];
    const wireY = [midY - 16 * dpr, midY, midY + 16 * dpr];
    ctx.strokeStyle = '#4a5563'; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.moveTo(busX, topY); ctx.lineTo(legX[2], topY); ctx.moveTo(busX, botY); ctx.lineTo(legX[2], botY);
    ctx.moveTo(busX, topY); ctx.lineTo(busX, midY - 6 * dpr); ctx.moveTo(busX, midY + 6 * dpr); ctx.lineTo(busX, botY); ctx.stroke();
    ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.moveTo(busX - 10 * dpr, midY - 6 * dpr); ctx.lineTo(busX + 10 * dpr, midY - 6 * dpr); ctx.stroke();
    ctx.lineWidth = 4 * dpr; ctx.beginPath(); ctx.moveTo(busX - 5 * dpr, midY + 6 * dpr); ctx.lineTo(busX + 5 * dpr, midY + 6 * dpr); ctx.stroke();
    ctx.fillStyle = C.text; ctx.font = `${10 * dpr}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('+', busX + 12 * dpr, topY + 10 * dpr); ctx.fillText('−', busX + 12 * dpr, botY - 10 * dpr);
    ctx.fillStyle = C.muted; ctx.fillText(`V_dc = ${sim.Vdc} V`, busX + 10 * dpr, midY - 24 * dpr);
    // 直流母线电流（开关状态决定哪些相电流流过母线）
    const idc = sw[0] * cur[0] + sw[1] * cur[1] + sw[2] * cur[2];
    ctx.fillText(`i_dc = ${idc.toFixed(1)} A`, busX + 10 * dpr, midY + 26 * dpr);
    for (let i = 0; i < 3; i++) {
      const dy = wireY[i] - my, xEnd = mx - Math.sqrt(Math.max(0, mr * mr - dy * dy));
      ctx.strokeStyle = cols[i]; ctx.lineWidth = 1.6 * dpr;
      ctx.beginPath(); ctx.moveTo(legX[i], midY); ctx.lineTo(legX[i] + 10 * dpr, midY); ctx.lineTo(legX[i] + 10 * dpr, wireY[i]); ctx.lineTo(xEnd, wireY[i]); ctx.stroke();
      ctx.fillStyle = cols[i]; ctx.font = `${9 * dpr}px sans-serif`; ctx.textAlign = 'left';
      ctx.fillText(['U', 'V', 'W'][i], legX[2] + 18 * dpr, wireY[i] - 7 * dpr);
      const I = cur[i];
      if (Math.abs(I) > 0.05) {
        const ax = W * 0.74, ay = wireY[i], s = 5 * dpr;
        ctx.globalAlpha = 0.3 + Math.min(0.7, Math.abs(I) * 0.12); ctx.beginPath();
        if (I > 0) { ctx.moveTo(ax + s, ay); ctx.lineTo(ax - s, ay - s * 0.8); ctx.lineTo(ax - s, ay + s * 0.8); }
        else { ctx.moveTo(ax - s, ay); ctx.lineTo(ax + s, ay - s * 0.8); ctx.lineTo(ax + s, ay + s * 0.8); }
        ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
      }
    }
    const upC = (topY + midY) / 2, loC = (midY + botY) / 2;
    const swBox = (x, yc, on, col, label) => {
      const w = 22 * dpr, h = 24 * dpr;
      ctx.fillStyle = on ? col : '#1a2028'; ctx.fillRect(x - w / 2, yc - h / 2, w, h);
      ctx.strokeStyle = on ? col : '#3a4656'; ctx.lineWidth = 1.2 * dpr; ctx.strokeRect(x - w / 2, yc - h / 2, w, h);
      ctx.fillStyle = on ? '#0d1117' : C.muted; ctx.font = `bold ${9 * dpr}px sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(label, x, yc + 0.5 * dpr);
    };
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = '#0a0e14'; ctx.lineWidth = 6 * dpr; ctx.beginPath(); ctx.moveTo(legX[i], topY + 5 * dpr); ctx.lineTo(legX[i], botY - 5 * dpr); ctx.stroke();
      ctx.strokeStyle = '#4a5563'; ctx.lineWidth = 1.5 * dpr; ctx.beginPath(); ctx.moveTo(legX[i], topY); ctx.lineTo(legX[i], botY); ctx.stroke();
      swBox(legX[i], upC, sw[i], cols[i], 'ABC'[i] + '+');
      swBox(legX[i], loC, !sw[i], cols[i], 'ABC'[i] + '−');
      ctx.fillStyle = cols[i]; ctx.beginPath(); ctx.arc(legX[i], midY, 3 * dpr, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = '#141a22'; ctx.strokeStyle = C.muted; ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath(); ctx.arc(mx, my, mr, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = C.text; ctx.font = `bold ${13 * dpr}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText('M', mx, my - 4 * dpr);
    ctx.fillStyle = C.muted; ctx.font = `${8 * dpr}px sans-serif`; ctx.fillText('3~', mx, my + 9 * dpr);
  }
}

FOC.pwmCharts = { HexChart, DutyChart, PwmChart, BridgeChart };
})(window.FOC);
