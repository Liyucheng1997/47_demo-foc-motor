/* =========================================================================
   blockdiagram.js —— 实时 FOC 控制框图（SVG）
   导线上实时显示信号数值；点击方框跳到对应的图表卡片；模式不同时灰显未用环节
   ========================================================================= */
(function (FOC) {
'use strict';
const { RPM } = FOC.math;

const Y1 = 50, Y2 = 130;          // 前向通道 / 电流反馈通道的导线高度
const BLOCKS = [
  // id, 左, 中心 y, 宽, 标题, 副标题, 跳转 [侧栏页, 卡片, 示波器页, 视图]
  ['spd', 92, Y1, 84, '速度 PI', 'ω 误差 → i_q*', ['ctrl', 'cardScope', 'speed']],
  ['cur', 262, Y1, 96, '电流 PI', '+ 解耦前馈', ['ctrl', 'cardScope', 'dq']],
  ['ipark', 428, Y1, 78, '逆 Park', 'dq → αβ', ['xform', 'cardVec']],
  ['svpwm', 578, Y1, 80, 'SVPWM', 'αβ → 占空比', ['pwm', 'cardHex']],
  ['inv', 730, Y1, 80, '逆变桥', '6 个功率管', ['pwm', 'cardBridge']],
  ['enc', 978, Y1, 96, '编码器', '测 θₑ 与 ω', ['param', 'cardCtrlParam']],
  ['clarke', 730, Y2, 80, 'Clarke', 'abc → αβ', ['xform', 'cardVec']],
  ['park', 428, Y2, 78, 'Park', 'αβ → dq', ['xform', 'cardVec']],
];
const BH = 40;

class BlockDiagram {
  constructor(svg, onClick) {
    this.svg = svg; this.onClick = onClick;
    svg.setAttribute('viewBox', '0 0 1100 180');
    const R = {};
    BLOCKS.forEach(([id, x, cy, w]) => { R[id] = { l: x, r: x + w, t: cy - BH / 2, b: cy + BH / 2, cx: x + w / 2, cy }; });
    const S1 = { x: 62, y: Y1 }, S2 = { x: 232, y: Y1 }, Mo = { x: 880, y: Y1, r: 27 };
    const w = (d, cls = 'w', id = '') => `<path ${id ? `id="${id}"` : ''} class="${cls}" d="${d}" marker-end="url(#ah)"/>`;
    const v = (id, x, y, anchor = 'middle') => `<text id="v_${id}" class="val" x="${x}" y="${y}" text-anchor="${anchor}"></text>`;
    const lab = (t, x, y, anchor = 'middle') => `<text class="lab" x="${x}" y="${y}" text-anchor="${anchor}">${t}</text>`;
    const mid = (a, b) => (a + b) / 2;
    // 一段带两行数值的导线（上：v1，下：v2）
    const seg = (x0, x1, y, id1, id2) => w(`M${x0},${y} H${x1}`) + v(id1, mid(x0, x1), y - 6) + (id2 ? v(id2, mid(x0, x1), y + 14) : '');

    let s = `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#6b7d97"/></marker></defs>`;
    const forward = `M${S1.x + 10},${Y1} H${R.spd.l} M${R.spd.r},${Y1} H${S2.x - 10} M${S2.x + 10},${Y1} H${R.cur.l} M${R.cur.r},${Y1} H${R.ipark.l} M${R.ipark.r},${Y1} H${R.svpwm.l} M${R.svpwm.r},${Y1} H${R.inv.l} M${R.inv.r},${Y1} H${Mo.x - Mo.r}`;
    s += `<path class="flow" id="flow" d="${forward}" stroke="#58a6ff"/>`;
    // 前向通道
    s += lab('ω*', 6, Y1 - 6, 'start') + v('wref', 6, Y1 + 14, 'start');
    s += w(`M34,${Y1} H${S1.x - 10}`);
    s += w(`M${S1.x + 10},${Y1} H${R.spd.l}`);
    s += seg(R.spd.r, S2.x - 10, Y1, 'iqref');
    s += w(`M${S2.x},14 V${S2.y - 10}`) + v('idref', S2.x + 8, 18, 'start');
    s += w(`M${S2.x + 10},${Y1} H${R.cur.l}`);
    s += seg(R.cur.r, R.ipark.l, Y1, 'vd', 'vq');
    s += seg(R.ipark.r, R.svpwm.l, Y1, 'va', 'vb');
    s += seg(R.svpwm.r, R.inv.l, Y1, 'duty', 'sec');
    s += seg(R.inv.r, Mo.x - Mo.r, Y1, 'vdc', 'sw');
    // 电机、负载、轴
    s += `<g class="blk" data-id="motor"><circle cx="${Mo.x}" cy="${Mo.y}" r="${Mo.r}" fill="#18212d" stroke="#3a4a62" stroke-width="1.4"/><text class="bt" x="${Mo.x}" y="${Mo.y + 1}">PMSM</text><text class="bs" x="${Mo.x}" y="${Mo.y + 14}">电机</text></g>`;
    s += `<path d="M${Mo.x + Mo.r},${Y1} H${R.enc.l}" stroke="#8b97a7" stroke-width="3.5" fill="none"/>` + lab('转轴', mid(Mo.x + Mo.r, R.enc.l), Y1 - 7);
    s += lab('负载 T_L', Mo.x + 40, Y1 + 34, 'start') + v('tl', Mo.x + 40, Y1 + 48, 'start');
    // 电流反馈：电机 → Clarke → Park → Σ2
    s += w(`M${Mo.x},${Mo.y + Mo.r} V${Y2} H${R.clarke.r}`, 'w fb') + v('iabc', mid(Mo.x, R.clarke.r), Y2 - 6) + lab('i_a i_b i_c', mid(Mo.x, R.clarke.r), Y2 + 14);
    s += w(`M${R.clarke.l},${Y2} H${R.park.r}`, 'w fb') + v('ial', mid(R.clarke.l, R.park.r), Y2 - 6) + v('ibe', mid(R.clarke.l, R.park.r), Y2 + 14);
    s += w(`M${R.park.l},${Y2} H${S2.x} V${S2.y + 10}`, 'w fb') + v('id', mid(R.park.l, S2.x), Y2 - 6) + v('iq', mid(R.park.l, S2.x), Y2 + 14);
    // θ（编码器 → Park / 逆 Park）与 ω（编码器 → Σ1）
    s += w(`M${R.enc.cx - 14},${R.enc.b} V162 H${R.park.cx} V${R.park.b}`, 'w fb', 'thLine1');
    s += w(`M${R.enc.cx - 14},${R.enc.t} V12 H${R.ipark.cx} V${R.ipark.t}`, 'w fb', 'thLine2');
    s += v('theta', R.enc.cx - 20, 158, 'end') + lab('θₑ', R.ipark.cx + 8, 24, 'start');
    s += w(`M${R.enc.cx + 18},${R.enc.b} V174 H${S1.x} V${S1.y + 10}`, 'w fb', 'wLine') + v('w', mid(S1.x, R.park.cx), 170);
    // 求和点
    [S1, S2].forEach((p, i) => { s += `<g class="blk" data-id="sum${i + 1}"><circle class="sum" cx="${p.x}" cy="${p.y}" r="10"/><text class="bs" x="${p.x}" y="${p.y + 4}" style="font-size:12px;fill:#c8d1dc">Σ</text></g>`; });
    s += lab('+', S1.x - 15, Y1 - 6) + lab('−', S1.x + 7, Y1 + 22) + lab('+', S2.x - 15, Y1 - 6) + lab('−', S2.x + 7, Y1 + 22);
    // 方框
    BLOCKS.forEach(([id, x, cy, bw, t, sub]) => {
      s += `<g class="blk" data-id="${id}"><rect x="${x}" y="${cy - BH / 2}" width="${bw}" height="${BH}"/><text class="bt" x="${x + bw / 2}" y="${cy - 3}">${t}</text><text class="bs" x="${x + bw / 2}" y="${cy + 12}">${sub}</text></g>`;
    });
    svg.innerHTML = s;
    this.v = {};
    svg.querySelectorAll('text[id^=v_]').forEach(t => { this.v[t.id.slice(2)] = t; });
    this.blk = {};
    svg.querySelectorAll('.blk').forEach(g => {
      this.blk[g.dataset.id] = g;
      g.addEventListener('click', () => {
        const b = BLOCKS.find(x => x[0] === g.dataset.id);
        if (b) onClick(b[6]);
        else if (g.dataset.id === 'motor') onClick(['field', 'cardGap', null, '2d']);
        else onClick(['ctrl', 'cardScope', g.dataset.id === 'sum1' ? 'speed' : 'dq']);
      });
    });
    this.flow = svg.querySelector('#flow');
  }

  highlight(ids) {
    const set = new Set(ids || []);
    Object.entries(this.blk).forEach(([id, g]) => g.classList.toggle('hl', set.has(id)));
  }

  update(sim, snap) {
    const o = sim.ctrl.out, mode = sim.ctrl.mode, V = this.v, f = (x, n = 2) => (Math.abs(x) < 0.005 ? 0 : x).toFixed(n);
    const speedLoop = mode === 'speed', useEnc = !(mode === 'dcalign' || mode === 'openloop');
    V.wref.textContent = speedLoop ? `${sim.ctrl.cmd.speedRpm} rpm` : '—';
    V.iqref.textContent = `i_q*=${f(o.iqRef)}`;
    V.idref.textContent = `i_d* = ${f(o.idRef)} A${o.idFW < -0.05 ? '（含弱磁）' : ''}`;
    V.vd.textContent = `u_d ${f(o.vd, 1)}`; V.vq.textContent = `u_q ${f(o.vq, 1)}`;
    V.va.textContent = `u_α ${f(o.valpha, 1)}`; V.vb.textContent = `u_β ${f(o.vbeta, 1)}`;
    V.duty.textContent = sim.duty.map(d => (d * 100).toFixed(0)).join('/') + '%';
    V.sec.textContent = `扇区 ${sim.svApplied.sector + 1}`;
    V.vdc.textContent = `V_dc ${sim.Vdc} V`; V.sw.textContent = `开关 ${sim.sw.join('')}`;
    V.tl.textContent = `${f(snap.TL)} N·m`;
    V.iabc.textContent = `${f(snap.ia, 1)}, ${f(snap.ib, 1)}, ${f(snap.ic, 1)}`;
    V.ial.textContent = `i_α ${f(o.ialpha)}`; V.ibe.textContent = `i_β ${f(o.ibeta)}`;
    V.id.textContent = `i_d ${f(o.id)}`; V.iq.textContent = `i_q ${f(o.iq)}`;
    V.theta.textContent = useEnc ? `θₑ = ${(snap.thetaE * 180 / Math.PI).toFixed(0)}°` : `θ = 指令角 ${(o.thetaCtrl * 180 / Math.PI).toFixed(0)}°（不用编码器）`;
    V.w.textContent = speedLoop ? `ω = ${(o.omegaMeas / RPM).toFixed(0)} rpm` : '';
    const setOff = (id, off) => this.blk[id].classList.toggle('off', off);
    setOff('spd', !speedLoop); setOff('sum1', !speedLoop); setOff('enc', !useEnc);
    this.svg.querySelector('#wLine').style.opacity = speedLoop ? 1 : 0.2;
    ['#thLine1', '#thLine2'].forEach(s => { this.svg.querySelector(s).style.opacity = useEnc ? 1 : 0.25; });
    this.flow.style.animationDuration = `${Math.max(0.25, 1.6 - Math.abs(snap.rpm) / 3000)}s`;
  }
}

FOC.BlockDiagram = BlockDiagram;
})(window.FOC);
