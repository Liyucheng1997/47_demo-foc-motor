/* =========================================================================
   app.js —— 应用装配：界面绑定、主循环、HUD
   ========================================================================= */
(function (FOC) {
'use strict';
const { PI, RPM } = FOC.math;
const $ = id => document.getElementById(id);
const U = FOC.ui;

const MODE_DESC = {
  speed: '串级控制：速度 PI 输出 i<sub>q</sub><sup>*</sup>，内层电流环让实际 i<sub>d</sub>、i<sub>q</sub> 跟踪指令。改目标转速或「突加负载」，在示波器里看动态过程。',
  torque: '只保留电流环：直接给定 i<sub>q</sub><sup>*</sup>，电磁转矩 T<sub>e</sub> = K<sub>t</sub>·i<sub>q</sub>。负载小于电磁转矩时电机会一直加速——配合「风机负载」可得到平衡转速。',
  dyno: '测功机把转子拖在固定转速（0 = 堵转），由你直接设定电流矢量超前 d 轴的电角 β。β = 90° 转矩最大；β = 0° 只有磁场没有转矩；β &gt; 90° 出现负 i<sub>d</sub>（弱磁）。',
  dcalign: '不用编码器：在静止坐标里给一个固定方向的电流，定子就成了一块固定的电磁铁，转子 N 极会被吸过去与之对齐（变频器上电“对零位”就是这样做的）。',
  openloop: '不用编码器：让电流矢量按指令频率旋转，转子被“拖着”同步转。负载越大转子落后越多，负载超过 K<sub>t</sub>·|i<sub>s</sub>| 就会<b>失步</b>。FOC 的区别是：它知道转子在哪，永远把电流放在 q 轴上。',
};
const MODE_NAME = { speed: '速度闭环 FOC', torque: '转矩闭环 FOC', dyno: '转矩–角度实验', dcalign: '直流定位', openloop: 'I/f 开环拖动' };
const SCOPE_NOTE = {
  abc: '开关级仿真：电流上的细小锯齿就是 PWM 纹波。降低 f<sub>PWM</sub> 或减小电感，纹波变大；时间窗选 1 ms 看得最清楚。',
  dq: '虚线为指令。在转子坐标下电流是直流量，PI 能做到无静差。转矩模式下拖动 i<sub>q</sub><sup>*</sup> 可看阶跃响应（上升时间 ≈ 0.35 / 电流环带宽）。',
  speed: '转速阶跃时 i<sub>q</sub> 先打到限幅全力加速，再回落；突加负载时转速先掉、随后被积分作用拉回原值。',
  volt: '电压需求超过 100%（V<sub>dc</sub>/√3）即电压饱和，电流跟不上指令——高速时必须弱磁，或提高母线电压。',
};
const ACC_STEPS = [1000, 3000, 10000, 20000, 50000, 200000, 1e9];

class App {
  constructor() {
    this.sim = new FOC.Simulator('6s2p');
    this.st = { timeScale: 0.05, paused: false, view: '3d', fieldView: 'total', tab: 'ctrl', carrierDemoT: 6, demoPhase: 0, loadBase: 0.15, kick: 0, overload: false };
    this.field = null;
    this.scene = new FOC.MotorScene($('view3d'));
    this.flux = new FOC.FluxMap($('cFlux'), $('fluxHover'));
    this.scope = new FOC.charts.Scope($('cScope'));
    this.vec = new FOC.charts.VectorChart($('cVec'));
    this.gap = new FOC.charts.GapChart($('cGap'));
    this.dqp = new FOC.charts.DqPlane($('cDq'));
    this.hex = new FOC.pwmCharts.HexChart($('cHex'));
    this.duty = new FOC.pwmCharts.DutyChart($('cDuty'));
    this.pwm = new FOC.pwmCharts.PwmChart($('cPwm'));
    this.bridge = new FOC.pwmCharts.BridgeChart($('cBridge'));
    this.diagram = new FOC.BlockDiagram($('blockSvg'), t => this.goto(t));
    this._bindUI();
    this.setDesign('6s2p');
    this.setMode('speed');
    this.tour = new FOC.Tour(this);
    this.last = performance.now(); this.hudT = 0; this.pAvg = { in: 0, mech: 0, t: 0 }; this.idqAvg = [0, 0, 0];
    requestAnimationFrame(t => this._frame(t));
  }

  /* ---------------- 界面绑定 ---------------- */
  _bindUI() {
    const sim = this.sim, ctrl = sim.ctrl;
    this.sliders = {};
    const S = (id, out, fmt, apply) => {
      const el = $(id), upd = () => { const v = parseFloat(el.value); apply(v); $(out).innerHTML = fmt(v); };
      el.addEventListener('input', upd); this.sliders[id] = upd; upd();
    };
    const retune = () => { sim.retune(); this._paramInfo(); };
    S('sSpeed', 'vSpeed', v => `${v} rpm`, v => { ctrl.cmd.speedRpm = v; });
    S('sIq', 'vIq', v => `${v.toFixed(1)} A`, v => { ctrl.cmd.iqManual = v; });
    S('sId', 'vId', v => `${v.toFixed(1)} A`, v => { ctrl.cmd.idManual = v; });
    S('sIamp', 'vIamp', v => `${v.toFixed(1)} A`, v => { ctrl.cmd.iAmp = v; });
    S('sBeta', 'vBeta', v => `${v}°`, v => { ctrl.cmd.beta = v * PI / 180; });
    S('sPhi', 'vPhi', v => `${v}°`, v => { ctrl.cmd.phi = v * PI / 180; });
    S('sDyno', 'vDyno', v => v === 0 ? '0（堵转）' : `${v} rpm`, v => { sim.motor.dyno.rpm = v; });
    S('sLoad', 'vLoad', v => `${v.toFixed(2)} N·m`, v => { this.st.loadBase = v; sim.motor.load.torque = v + this.st.kick; });
    S('sWin', 'vWin', () => this.scope.windowLabel(sim), v => { this.scope.win = v; });
    S('sCarT', 'vCarT', v => `${v} s`, v => { this.st.carrierDemoT = v; });
    S('sVdc', 'vVdc', v => `${v} V`, v => { sim.Vdc = v; this._paramInfo(); });
    S('sFpwm', 'vFpwm', v => `${v} kHz（T<sub>s</sub> = ${(1000 / v).toFixed(0)} µs）`, v => { sim.fpwm = v * 1000; sim.tIn = 0; this._paramInfo(); });
    S('sImax', 'vImax', v => `${v} A`, v => { ctrl.cfg.Imax = v; this._paramInfo(); });
    S('sCbw', 'vCbw', v => `${v} Hz`, v => { ctrl.cfg.currentBwHz = v; retune(); });
    S('sSbw', 'vSbw', v => `${v} Hz`, v => { ctrl.cfg.speedBwHz = v; retune(); });
    S('sAcc', 'vAcc', v => ACC_STEPS[v] > 1e8 ? '不限（阶跃）' : `${ACC_STEPS[v]} rpm/s`, v => { ctrl.cfg.accelRpm = ACC_STEPS[v]; });
    S('sEnc', 'vEnc', v => `${v}°`, v => { ctrl.cfg.encoderOffset = v * PI / 180; });
    S('sR', 'vR', v => `${v.toFixed(2)} Ω`, v => { sim.motor.R = v; retune(); });
    S('sLk', 'vLk', v => `× ${v.toFixed(2)}`, v => { sim.motor.Ld = sim.motor.Lq = sim.design.elec.Ld * v; retune(); });
    S('sJ', 'vJ', v => `${v} × 10⁻⁴ kg·m²`, v => { sim.motor.J = v * 1e-4; retune(); });

    const segBind = (segId, attr, fn) => {
      $(segId).addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b || !b.dataset[attr]) return;
        fn(b.dataset[attr]);
      });
    };
    const segSet = (segId, attr, val) => $(segId).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset[attr] === val));
    this.segSet = segSet;
    segBind('modeSeg', 'mode', m => this.setMode(m));
    segBind('viewSeg', 'view', v => this.setView(v));
    segBind('camSeg', 'cam', c => this.scene.setCamera(c));
    segBind('fieldSeg', 'f', f => this.setFieldView(f));
    segBind('scopeSeg', 'sc', s => this.setScope(s));
    segBind('loadSeg', 'load', l => { sim.motor.load.type = l; segSet('loadSeg', 'load', l); });
    segBind('designSeg', 'd', d => this.setDesign(d));
    $('sideTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) this.setTab(b.dataset.tab); });
    $('chips3d').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      this.setFlag(b.dataset.t, !this.scene.flags[b.dataset.t]);
    });

    // 方案选择
    const sel = $('selDesign');
    FOC.machine.PRESETS.forEach(p => {
      sel.insertAdjacentHTML('beforeend', `<option value="${p.id}">${p.name}</option>`);
      $('designSeg').insertAdjacentHTML('beforeend', `<button data-d="${p.id}">${p.Ns}s${2 * p.p}p</button>`);
    });
    sel.addEventListener('change', () => this.setDesign(sel.value));

    $('selTimeScale').addEventListener('change', e => { this.st.timeScale = parseFloat(e.target.value); });
    $('bPlay').addEventListener('click', () => this.setPaused(!this.st.paused));
    $('bReset').addEventListener('click', () => this.reset());
    $('bKick').addEventListener('click', () => {
      this.st.kick = this.st.kick ? 0 : 0.5;
      $('bKick').classList.toggle('on', !!this.st.kick);
      $('bKick').textContent = this.st.kick ? '撤除负载 −0.5' : '突加负载 +0.5';
      sim.motor.load.torque = this.st.loadBase + this.st.kick;
    });
    const tog = (id, get, set, label) => {
      const b = $(id), upd = () => { b.classList.toggle('on', get()); b.textContent = `${label} ${get() ? 'ON' : 'OFF'}`; };
      b.addEventListener('click', () => { set(!get()); upd(); }); upd();
      return upd;
    };
    this.togFW = tog('bFW', () => ctrl.cfg.fieldWeakening, v => { ctrl.cfg.fieldWeakening = v; }, '自动弱磁');
    this.togDec = tog('bDecouple', () => ctrl.cfg.decouple, v => { ctrl.cfg.decouple = v; }, '解耦前馈');
    this.togDel = tog('bDelay', () => ctrl.cfg.delayComp, v => { ctrl.cfg.delayComp = v; }, '延时补偿');
    $('bLegend').addEventListener('click', () => {
      const L = $('legend3d'); L.classList.toggle('collapsed'); $('bLegend').textContent = L.classList.contains('collapsed') ? '展开' : '收起';
    });
    $('bTour').addEventListener('click', () => this.tour.open(0));

    // 滚轮：转矩–角度实验调 β，直流定位调 φ
    const wheel = e => {
      const m = ctrl.mode, id = m === 'dyno' ? 'sBeta' : m === 'dcalign' ? 'sPhi' : null;
      if (!id) return;
      e.preventDefault();
      const el = $(id); let v = (parseFloat(el.value) + Math.sign(e.deltaY) * 5 + 360) % 360;
      this.setSlider(id, v);
    };
    $('view3d').addEventListener('wheel', wheel, { passive: false, capture: true });
    $('view2d').addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); this.setPaused(!this.st.paused); }
      if (this.tour.active && e.key === 'ArrowRight') this.tour.go(1);
      if (this.tour.active && e.key === 'ArrowLeft') this.tour.go(-1);
      if (e.key === 'Escape') this.tour.close();
    });
    window.addEventListener('resize', () => { this.scene.resize(); });
  }

  /* ---------------- 对外操作（讲解模式也用这些） ---------------- */
  setSlider(id, v) { $(id).value = v; this.sliders[id](); }
  setPaused(p) { this.st.paused = p; $('bPlay').textContent = p ? '▶' : '❚❚'; $('bPlay').classList.toggle('on', p); }
  setTimeScale(v) { this.st.timeScale = v; $('selTimeScale').value = String(v); }
  setFlag(k, v) { this.scene.setFlag(k, v); $('chips3d').querySelector(`[data-t=${k}]`).classList.toggle('on', v); }
  setView(v) {
    this.st.view = v; this.segSet('viewSeg', 'view', v);
    $('views').className = 'v-' + v;
    requestAnimationFrame(() => this.scene.resize());
  }
  setFieldView(f) { this.st.fieldView = f; this.segSet('fieldSeg', 'f', f); }
  setScope(s) { this.scope.tab = s; this.segSet('scopeSeg', 'sc', s); $('scopeNote').innerHTML = SCOPE_NOTE[s]; }
  setTab(t) {
    this.st.tab = t;
    document.querySelectorAll('#sideTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.dataset.pane === t));
  }
  focusCard(id) {
    const el = $(id); if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }
  goto([tab, card, scope, view]) {
    this.setTab(tab); if (scope) this.setScope(scope); if (view) this.setView(view === '2d' && this.st.view === '3d' ? 'split' : this.st.view);
    requestAnimationFrame(() => this.focusCard(card));
  }
  setMode(m) {
    const sim = this.sim;
    sim.ctrl.setMode(m, sim.motor.thetaE);
    sim.motor.dyno.on = m === 'dyno';
    this.segSet('modeSeg', 'mode', m);
    $('modeDesc').innerHTML = MODE_DESC[m];
    $('modeTag').textContent = MODE_NAME[m];
    document.querySelectorAll('[data-modes]').forEach(el => el.classList.toggle('hide', !el.dataset.modes.split(' ').includes(m)));
    this.scene.controls.enableZoom = !(m === 'dyno' || m === 'dcalign');
  }
  setDesign(id) {
    const sim = this.sim;
    sim.setDesign(id);
    sim.motor.load.torque = this.st.loadBase + this.st.kick;
    ['sR', 'sLk', 'sJ'].forEach(k => this.sliders[k]());
    this.scene.build(sim.design);
    this.flux.setDesign(sim.design);
    this.field = new FOC.machine.AirgapField(sim.design);
    $('selDesign').value = id; this.segSet('designSeg', 'd', id);
    this._designInfo(); this._paramInfo();
  }
  reset() {
    const s = this.sim, m = s.motor;
    m.id = m.iq = m.omega = m.thetaM = 0; s.t = 0; s.tIn = 0; s.nextFast = s.nextSlow = 0;
    s.fast.clear(); s.slow.clear();
    s.ctrl.reset(); s.ctrl.out.thetaCtrl = 0;
    this.vec.trail = []; this.dqp.trail = []; this.hex.tips = []; this.pAvg = { in: 0, mech: 0, t: 0 }; this.idqAvg = [0, 0, 0];
  }

  _designInfo() {
    const d = this.sim.design, g = FOC.machine.gcd;
    const qn = d.Ns, qd = 6 * d.p, k = g(qn, qd);
    const rows = [['槽数 N<sub>s</sub> / 极数 2p', `${d.Ns} / ${2 * d.p}`], ['每极每相槽数 q', qd / k === 1 ? `${qn / k}` : `${qn / k}/${qd / k}`],
      ['绕组系数 k<sub>w</sub> = k<sub>d</sub>·k<sub>p</sub>', `${d.winding.kw.toFixed(3)} = ${d.winding.kd.toFixed(3)} × ${d.winding.kp.toFixed(3)}`],
      ['电角度 / 机械角度', `${d.p} 倍`], ['单元电机数 gcd(N<sub>s</sub>, p)', g(d.Ns, d.p)], ['齿槽转矩周期 / 转', d.cogPeriods],
      ['A 相轴位置（电角）', `${(Math.abs(d.winding.axis.a) < 1e-9 ? 0 : d.winding.axis.a * 180 / PI).toFixed(1)}°`]];
    $('designInfo').innerHTML = rows.map(([a, b]) => `<div class="k">${a}</div><div class="v">${b}</div>`).join('');
    const PC = U.PHASE_COLOR();
    $('windSeq').innerHTML = '<span style="border:0;color:var(--muted);padding-left:0">绕组排布：</span>' + d.winding.coils.map(c =>
      `<span style="color:${PC[c.phase]};border-color:${PC[c.phase]}55;background:${PC[c.phase]}${c.sign > 0 ? '22' : '08'}">${c.phase.toUpperCase()}${c.sign < 0 ? '′' : ''}</span>`).join('');
    $('designNote').textContent = d.note;
  }
  _paramInfo() {
    const s = this.sim, m = s.motor, c = s.ctrl, gn = c.gains, Vmax = s.Vdc / Math.sqrt(3);
    const warn = c.cfg.currentBwHz > s.fpwm / 8;
    $('gainInfo').innerHTML = [
      ['电流环 K<sub>p</sub> = L·ω<sub>c</sub>', `${gn.kpi.toFixed(2)} V/A`], ['电流环 K<sub>i</sub> = R·ω<sub>c</sub>', `${gn.kii.toFixed(0)} V/(A·s)`],
      ['速度环 K<sub>p</sub> = J·ω<sub>s</sub>/K<sub>t</sub>', `${gn.kpw.toFixed(3)} A·s/rad`], ['速度环 K<sub>i</sub>', `${gn.kiw.toFixed(2)} A/rad`],
      ['电流环带宽 / f<sub>PWM</sub>', `<span style="color:${warn ? 'var(--warn)' : 'inherit'}">${(c.cfg.currentBwHz / s.fpwm * 100).toFixed(1)}%${warn ? '（偏高，建议 ≤ 10%）' : ''}</span>`],
    ].map(([a, b]) => `<div class="k">${a}</div><div class="v">${b}</div>`).join('');
    const nBase = Vmax / (m.p * m.psi) / RPM;
    $('motorInfo').innerHTML = [
      ['极对数 p', m.p], ['永磁磁链 ψ<sub>f</sub>', `${(m.psi * 1000).toFixed(1)} mWb`], ['电感 L<sub>d</sub> = L<sub>q</sub>', `${(m.Ld * 1000).toFixed(2)} mH`],
      ['电气时间常数 τ = L/R', `${(m.Ld / m.R * 1000).toFixed(1)} ms`], ['转矩常数 K<sub>t</sub> = 1.5pψ<sub>f</sub>', `${m.Kt.toFixed(3)} N·m/A`],
      ['最大转矩 K<sub>t</sub>·I<sub>max</sub>', `${(m.Kt * c.cfg.Imax).toFixed(2)} N·m`], ['空载转折速度 ≈ V<sub>max</sub>/(pψ<sub>f</sub>)', `${nBase.toFixed(0)} rpm`],
    ].map(([a, b]) => `<div class="k">${a}</div><div class="v">${b}</div>`).join('');
  }

  _hud(snap) {
    const s = this.sim, o = s.ctrl.out, m = s.motor, mode = s.ctrl.mode;
    const vr = Math.min(1.5, o.vRatio), pct = (vr * 100).toFixed(0);
    const chips = [];
    if (o.saturated) chips.push('<span class="pill bad">电压饱和</span>');
    if (o.idFW < -0.1) chips.push(`<span class="pill info">弱磁 i<sub>d</sub>=${o.idFW.toFixed(1)} A</span>`);
    if (mode === 'speed' && Math.abs(o.iqRef) >= o.iqLimit - 0.01 && o.iqLimit > 0) chips.push('<span class="pill warn">电流限幅</span>');
    if (mode === 'openloop' && o.slip) chips.push('<span class="pill bad">失步!</span>');
    if (this.st.overload) chips.push('<span class="pill warn">计算过载，已降速</span>');
    if (this.st.paused) chips.push('<span class="pill warn">已暂停</span>');
    const pa = this.pAvg, eff = pa.in > 0.5 && pa.mech > 0.05 ? Math.min(1, pa.mech / pa.in) : null;
    const ref = mode === 'speed' ? `（指令 ${s.ctrl.cmd.speedRpm}）` : mode === 'dyno' ? '（测功机）' : '';
    $('hud').innerHTML = `
      <div class="r"><span>转速 n</span><b>${snap.rpm.toFixed(0)} rpm<small style="color:var(--muted);font-weight:400">${ref}</small></b></div>
      <div class="r"><span>电磁转矩 / 负载</span><b>${snap.Te.toFixed(2)} / ${snap.TL.toFixed(2)} N·m</b></div>
      <div class="r"><span>真实 i<sub>d</sub> / i<sub>q</sub></span><b>${this.idqAvg[0].toFixed(2)} / ${this.idqAvg[1].toFixed(2)} A</b></div>
      <div class="r"><span>电频率 f<sub>e</sub></span><b>${Math.abs(m.omega * m.p / (2 * PI)).toFixed(1)} Hz</b></div>
      <div class="r"><span>机械功率 / 效率</span><b>${this.pAvg.mech.toFixed(1)} W / ${eff !== null ? (eff * 100).toFixed(0) + '%' : '—'}</b></div>
      <div class="r"><span>电压利用 |u|/V<sub>max</sub></span><b>${pct}%</b></div>
      <div class="bar"><i style="width:${Math.min(100, vr * 100)}%;background:${o.saturated ? 'var(--bad)' : vr > 0.9 ? 'var(--warn)' : 'var(--good)'}"></i></div>
      <div class="chips2">${chips.join('')}</div>`;
    $('simTime').textContent = `t = ${s.t.toFixed(3)} s`;
    $('vWin').innerHTML = this.scope.windowLabel(s);
    const kv = (id, v) => { $(id).textContent = v; };
    kv('kA', snap.ia.toFixed(2)); kv('kB', snap.ib.toFixed(2)); kv('kC', snap.ic.toFixed(2));
    kv('kAl', snap.ialpha.toFixed(2)); kv('kBe', snap.ibeta.toFixed(2)); kv('kTh', (snap.thetaE * 180 / PI).toFixed(0) + '°');
    kv('kD', o.id.toFixed(2)); kv('kQ', o.iq.toFixed(2)); kv('kT', snap.Te.toFixed(3) + ' N·m');
    const sv = s.svApplied;
    kv('kSec', sv.sector + 1); kv('kM', sv.m.toFixed(3)); kv('kT1', (sv.T1 * 100).toFixed(1) + '%');
    kv('kT2', (sv.T2 * 100).toFixed(1) + '%'); kv('kT0', (sv.T0 * 100).toFixed(1) + '%'); kv('kFpwm', (s.fpwm / 1000) + ' kHz');
  }

  /* ---------------- 主循环 ---------------- */
  _frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    const s = this.sim, st = this.st;
    if (!st.paused) {
      const t0 = performance.now();
      const ok = s.advance(dt * st.timeScale, 2500);
      st.overload = !ok || performance.now() - t0 > 30;
    }
    const snap = s.snapshot();
    // 功率取约 50 ms（仿真时间）的滑动平均，避免瞬时值受纹波与暂态影响
    const tPrev = this.pAvg.t, a = 1 - Math.exp(-Math.max(0, s.t - tPrev) / 0.05);
    this.pAvg.in += (snap.Pin - this.pAvg.in) * a; this.pAvg.mech += (snap.Pmech - this.pAvg.mech) * a; this.pAvg.t = s.t;
    // 真实转子坐标下的电流（含编码器误差时与控制器“以为”的不同），同样做平滑
    const ai = 1 - Math.exp(-Math.max(0, s.t - this.idqAvg[2]) / 0.005);
    this.idqAvg[0] += (snap.id - this.idqAvg[0]) * ai; this.idqAvg[1] += (snap.iq - this.idqAvg[1]) * ai; this.idqAvg[2] = s.t;
    const rot = snap.thetaM + s.design.winding.axis.a / s.design.p;
    this.field.compute(rot, snap.ia, snap.ib, snap.ic, st.fieldView);

    // 载波显示：慢到每个开关周期 ≥ 0.5 s 时与仿真真实同步，否则示意慢放
    const real = st.paused || s.Ts / st.timeScale >= 0.5;
    st.demoPhase = (st.demoPhase + dt / st.carrierDemoT) % 1;
    const phase = real ? s.carrierFrac : st.demoPhase;
    const carrier = { phase, real, sw: real ? s.sw : s.switchStateAt(phase) };

    if (st.view !== '2d') this.scene.update(s, snap, this.field, dt);
    if (st.view !== '3d') this.flux.render(s, snap, this.field, st.fieldView);
    switch (st.tab) {
      case 'ctrl': this.scope.render(s); break;
      case 'xform': this.vec.render(s, snap); break;
      case 'field': this.gap.render(s, snap, this.field, s.design); this.dqp.render(s); break;
      case 'pwm': {
        this.hex.render(s, carrier);
        const we = Math.abs(s.motor.omega * s.motor.p);
        this.duty.render(s, Math.max(0.002, Math.min(we > 1 ? 2 * 2 * PI / we : 0.2, 0.4)));
        this.pwm.render(s, carrier); this.bridge.render(s, snap, carrier);
        $('carrierMode').textContent = real ? '载波与仿真实时同步' : '示意慢放（与仿真不同步）';
        break;
      }
    }
    this.hudT += dt;
    if (this.hudT > 0.06) { this.hudT = 0; this._hud(snap); this.diagram.update(s, snap); }
    requestAnimationFrame(t => this._frame(t));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  if (typeof THREE === 'undefined') {
    document.body.insertAdjacentHTML('afterbegin', '<div style="padding:10px;background:#5a1d1d;color:#fff">Three.js 加载失败：请检查网络（需要访问 cdnjs / jsdelivr）。</div>');
    return;
  }
  window.app = new App();
});
})(window.FOC);
