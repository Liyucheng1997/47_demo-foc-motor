/* 核心算法单元测试：node --test tests/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/core/foc-core.js');
require('../js/core/machine.js');
const FOC = require('../js/core/simulator.js');
const { clarke, invClarke, park, invPark, TAU, RPM, wrapPi } = FOC.math;

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} 期望 ${b}，实际 ${a}`);

test('Clarke/Park 往返变换无损', () => {
  for (let k = 0; k < 50; k++) {
    const th = Math.random() * TAU, d = Math.random() * 10 - 5, q = Math.random() * 10 - 5;
    const [a, b] = invPark(d, q, th);
    const [ia, ib, ic] = invClarke(a, b);
    near(ia + ib + ic, 0, 1e-12, '三相和为零');
    const [a2, b2] = clarke(ia, ib, ic);
    const [d2, q2] = park(a2, b2, th);
    near(d2, d, 1e-12); near(q2, q, 1e-12);
  }
});

test('平衡三相正弦 → 同步坐标系下为直流量', () => {
  const I = 4, gamma = 0.3;
  for (let k = 0; k < 20; k++) {
    const th = k * 0.37;
    const ia = I * Math.cos(th + gamma), ib = I * Math.cos(th + gamma - TAU / 3), ic = I * Math.cos(th + gamma + TAU / 3);
    const [d, q] = park(...clarke(ia, ib, ic), th);
    near(d, I * Math.cos(gamma), 1e-9); near(q, I * Math.sin(gamma), 1e-9);
  }
});

test('SVPWM：线性区内占空比的伏秒平均等于参考电压', () => {
  const Vdc = 48;
  for (let k = 0; k < 200; k++) {
    const ang = Math.random() * TAU, mag = Math.random() * Vdc / Math.sqrt(3) * 0.999;
    const va = mag * Math.cos(ang), vb = mag * Math.sin(ang);
    const sv = FOC.svpwm(va, vb, Vdc);
    for (const d of [sv.da, sv.db, sv.dc]) assert.ok(d >= 0 && d <= 1);
    const mean = (sv.da + sv.db + sv.dc) / 3;
    const [a, b] = clarke((sv.da - mean) * Vdc, (sv.db - mean) * Vdc, (sv.dc - mean) * Vdc);
    near(a, va, 1e-9); near(b, vb, 1e-9);
    near(sv.T1 + sv.T2 + sv.T0, 1, 1e-9);
    // T1/T2 合成同样等于参考：T1·U_k + T2·U_k+1，基本矢量幅值 2Vdc/3
    const a0 = sv.sector * Math.PI / 3, a1 = a0 + Math.PI / 3, U = 2 * Vdc / 3;
    near(U * (sv.T1 * Math.cos(a0) + sv.T2 * Math.cos(a1)), va, 1e-9);
    near(U * (sv.T1 * Math.sin(a0) + sv.T2 * Math.sin(a1)), vb, 1e-9);
  }
});

test('基本开关状态对应六边形顶点', () => {
  FOC.SVBITS.forEach((bits, k) => {
    const [a, b] = FOC.switchVoltageAB(+bits[0], +bits[1], +bits[2], 30);
    near(Math.hypot(a, b), 20, 1e-9, '幅值 2Vdc/3');
    near(wrapPi(Math.atan2(b, a) - k * Math.PI / 3), 0, 1e-9, `U${k + 1} 方向`);
  });
});

test('各槽极方案的绕组三相平衡、正相序，绕组系数符合理论值', () => {
  const expect = { '6s2p': 0.5, '6s4p': 0.866, '9s6p': 0.866, '12s8p': 0.866, '9s8p': 0.945, '12s10p': 0.933, '12s14p': 0.933 };
  for (const pr of FOC.machine.PRESETS) {
    const w = FOC.machine.layoutWinding(pr.Ns, pr.p);
    assert.ok(w.balanced, `${pr.id} 不平衡`);
    near(w.kw, expect[pr.id], 0.001, `${pr.id} kw`);
  }
  assert.equal(FOC.machine.layoutWinding(12, 5).seq, "A A′ B′ B C C′ A′ A B B′ C′ C");
});

test('气隙磁场：A 相电流产生的基波指向 A 相轴；磁通函数周期闭合', () => {
  for (const pr of FOC.machine.PRESETS) {
    const des = FOC.machine.makeDesign(pr.id);
    const f = new FOC.machine.AirgapField(des);
    f.compute(0, 10, -5, -5, 'arm');
    const fu = f.fundamental(f.Barm);
    near(wrapPi(fu.elec - des.winding.axis.a), 0, 0.02, `${pr.id} 电枢基波方向`);
    f.compute(0.4, 0, 0, 0, 'pm');
    const fp = f.fundamental(f.Bpm);
    near(wrapPi(fp.elec - pr.p * 0.4), 0, 0.02, `${pr.id} 永磁基波对准 N 极`);
    let s = 0; for (let k = 0; k < f.N; k++) s += f.B[k];
    near(s / f.N, 0, 1e-9, '净磁通为零');
  }
});

function run(sim, seconds) { const dt = 1e-3; for (let t = 0; t < seconds; t += dt) sim.advance(dt); }
/* 慢速记录通道最近 window 秒的平均值（消除 PWM 纹波与机械振荡的瞬时影响） */
function avg(sim, ch, window) {
  const r = sim.slow, i0 = r.lowerBound(sim.t - window);
  let s = 0; for (let i = i0; i < r.count; i++) s += r.ch[ch][r.idx(i)];
  return s / (r.count - i0);
}

test('速度闭环：阶跃后稳定跟踪目标转速，且 id≈0、iq 平衡负载', () => {
  const sim = new FOC.Simulator('12s10p');
  sim.motor.load.torque = 0.3;
  sim.ctrl.cmd.speedRpm = 1500;
  run(sim, 0.6);
  const s = sim.snapshot();
  near(s.rpm, 1500, 8, '转速');
  near(sim.ctrl.out.id, 0, 0.3, 'id');
  const iqNeed = (0.3 * Math.tanh(s.omega / 3) + sim.motor.B * s.omega) / sim.motor.Kt;
  near(sim.ctrl.out.iq, iqNeed, 0.3, 'iq');
});

test('转矩模式：Te = Kt·iq，电流环带宽内快速跟踪', () => {
  const sim = new FOC.Simulator('6s2p');
  sim.ctrl.setMode('torque');
  sim.motor.dyno = { on: true, rpm: 500 };
  sim.ctrl.cmd.iqManual = 5;
  run(sim, 0.02);
  near(avg(sim, 'iq', 0.005), 5, 0.05, 'iq');
  near(avg(sim, 'Te', 0.005), sim.motor.Kt * 5, 0.01, 'Te');
});

test('高速时电压饱和，开启弱磁后 id < 0 且能达到更高转速', () => {
  const mk = fw => {
    const sim = new FOC.Simulator('12s8p');
    sim.motor.load.torque = 0.1;
    sim.ctrl.cfg.fieldWeakening = fw;
    sim.ctrl.cmd.speedRpm = 5000;
    run(sim, 1.0);
    return sim;
  };
  const a = mk(false), b = mk(true);
  assert.ok(b.snapshot().rpm > a.snapshot().rpm + 300, `弱磁 ${b.snapshot().rpm.toFixed(0)} vs 无弱磁 ${a.snapshot().rpm.toFixed(0)}`);
  assert.ok(b.ctrl.out.idRef < -1, '弱磁电流为负');
});

test('直流定位：转子 d 轴被吸到定子电流方向', () => {
  const sim = new FOC.Simulator('6s4p');
  sim.ctrl.setMode('dcalign');
  sim.motor.load.torque = 0.0;
  sim.ctrl.cmd.iAmp = 6; sim.ctrl.cmd.phi = 1.2;
  sim.motor.B = 0.004;     // 加大阻尼让振荡尽快衰减
  run(sim, 1.5);
  near(wrapPi(sim.motor.thetaE - 1.2), 0, 0.05, '对齐角');
});

test('I/f 开环：轻载同步运行，过载失步', () => {
  const mk = load => {
    const sim = new FOC.Simulator('6s2p');
    sim.ctrl.setMode('openloop');
    sim.motor.load.torque = load;
    sim.ctrl.cmd.iAmp = 6; sim.ctrl.cmd.speedRpm = 300; sim.ctrl.cfg.accelRpm = 2000;
    run(sim, 1.2);
    return sim;
  };
  near(avg(mk(0.2), 'w', 0.4), 300, 5, '同步转速（平均）');
  assert.ok(Math.abs(avg(mk(0.8), 'w', 0.4) - 300) > 50, '过载（> Kt·I = 0.54 N·m）应失步');
});

test('开关级模型：电流纹波随 PWM 频率降低而增大', () => {
  const ripple = f => {
    const sim = new FOC.Simulator('6s2p');
    sim.fpwm = f; sim.ctrl.setMode('torque');
    sim.motor.dyno = { on: true, rpm: 600 };
    sim.ctrl.cmd.iqManual = 4;
    run(sim, 0.05);
    let lo = 1e9, hi = -1e9;
    const n = sim.fast.count, span = Math.round(8 * 3);   // 约 3 个开关周期内 iq 的峰峰值
    for (let i = n - span; i < n; i++) { const v = sim.fast.ch.iq[sim.fast.idx(i)]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return hi - lo;
  };
  const r20 = ripple(20000), r4 = ripple(4000);
  assert.ok(r4 > 2.5 * r20, `4kHz 纹波 ${r4.toFixed(3)} 应明显大于 20kHz 的 ${r20.toFixed(3)}`);
});
