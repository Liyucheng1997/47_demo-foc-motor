/* =========================================================================
   util.js —— 视图层公共工具：高 DPI 画布、配色、箭头、刻度
   ========================================================================= */
(function (FOC) {
'use strict';

const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const COLORS = {};
function refreshColors() {
  ['--pa', '--pb', '--pc', '--alpha', '--beta', '--d', '--q', '--stator', '--text', '--muted', '--dim',
   '--line', '--accent', '--warn', '--bad', '--good'].forEach(k => { COLORS[k.slice(2)] = css(k); });
}
refreshColors();
const PHASE_COLOR = () => ({ a: COLORS.pa, b: COLORS.pb, c: COLORS.pc });

/* 让画布像素尺寸跟随 CSS 尺寸 × DPR；高度取 data-h（CSS 像素）或父容器 */
function fitCanvas(cv, fill = false) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = cv.getBoundingClientRect();
  const w = Math.max(10, r.width);
  const h = fill ? Math.max(10, r.height) : parseFloat(cv.dataset.h || 150);
  if (!fill) cv.style.height = h + 'px';
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  return { W, H, dpr, w, h };
}

function arrow(ctx, x0, y0, x1, y1, color, lw, head = 8) {
  const a = Math.atan2(y1 - y0, x1 - x0), L = Math.hypot(x1 - x0, y1 - y0);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = lw;
  const hl = Math.min(head, L * 0.6);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 - Math.cos(a) * hl * 0.6, y1 - Math.sin(a) * hl * 0.6); ctx.stroke();
  if (L < 1) return;
  ctx.beginPath(); ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - hl * Math.cos(a - 0.42), y1 - hl * Math.sin(a - 0.42));
  ctx.lineTo(x1 - hl * Math.cos(a + 0.42), y1 - hl * Math.sin(a + 0.42));
  ctx.closePath(); ctx.fill();
}

/* 1-2-5 刻度 */
function niceStep(range, n = 5) {
  const raw = range / n, e = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / e;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * e;
}
function niceMax(v) { if (v <= 0) return 1; const s = niceStep(v, 2); return Math.ceil(v / s) * s; }

function fmtTime(s) {
  const a = Math.abs(s);
  if (a >= 1) return s.toFixed(a >= 10 ? 0 : 1) + ' s';
  if (a >= 1e-3) return (s * 1e3).toFixed(a >= 0.01 ? 0 : 1) + ' ms';
  return (s * 1e6).toFixed(0) + ' µs';
}

/* 平滑的显示用自动量程（只增不骤减） */
class AutoRange {
  constructor(min = 1) { this.v = min; this.min = min; }
  update(x) { const t = Math.max(this.min, niceMax(x * 1.12)); this.v = t > this.v ? t : this.v + (t - this.v) * 0.03; return this.v; }
}

const deg = r => r * 180 / Math.PI;
FOC.ui = { css, COLORS, refreshColors, PHASE_COLOR, fitCanvas, arrow, niceStep, niceMax, fmtTime, AutoRange, deg };
})(window.FOC);
