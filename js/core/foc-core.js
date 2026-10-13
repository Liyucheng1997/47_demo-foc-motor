/* =========================================================================
   foc-core.js —— FOC 算法核心（与界面无关，可在 Node 中单测）
   - 坐标变换：Clarke / Park 及其逆变换（幅值不变形式）
   - SVPWM：扇区、T1/T2/T0、min-max 零序注入占空比
   - PI 调节器（条件积分抗饱和）
   - FocController：速度环 + 电流环 + 解耦前馈 + 弱磁 + 延时补偿 + 5 种运行模式
   ========================================================================= */
(function (root, factory) {
  const FOC = root.FOC = root.FOC || {};
  factory(FOC);
  if (typeof module === 'object' && module.exports) module.exports = FOC;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (FOC) {
'use strict';

const PI = Math.PI, TAU = 2 * Math.PI, SQ3 = Math.sqrt(3);
const RPM = PI / 30;                       // rpm → rad/s

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const wrapPi = x => { x = (x + PI) % TAU; if (x < 0) x += TAU; return x - PI; };
const wrap2Pi = x => { x %= TAU; return x < 0 ? x + TAU : x; };

/* ---------- 坐标变换（幅值不变：|iαβ| = 相电流峰值） ---------- */
function clarke(a, b, c) { return [(2 / 3) * (a - 0.5 * b - 0.5 * c), (b - c) / SQ3]; }
function invClarke(al, be) { return [al, -0.5 * al + (SQ3 / 2) * be, -0.5 * al - (SQ3 / 2) * be]; }
function park(al, be, th) {
  const c = Math.cos(th), s = Math.sin(th);
  return [al * c + be * s, -al * s + be * c];
}
function invPark(d, q, th) {
  const c = Math.cos(th), s = Math.sin(th);
  return [d * c - q * s, d * s + q * c];
}

/* ---------- SVPWM ----------
   输入 αβ 参考电压与母线电压，输出：
   m       调制比，m = |U|·√3/Vdc，m=1 为线性调制极限（六边形内切圆）
   sector  扇区 0..5（U1=100 在 0°，逆时针每 60° 一个基本矢量）
   T1,T2   相邻两个基本矢量作用时间（归一化到一个开关周期），T0 为零矢量
   da..dc  三相占空比：min-max 零序注入，与七段式 SVPWM 等价（马鞍波） */
const SVBITS = ['100', '110', '010', '011', '001', '101'];
function svpwm(va, vb, Vdc) {
  const mag = Math.hypot(va, vb);
  const m = mag * SQ3 / Vdc;
  const ang = wrap2Pi(Math.atan2(vb, va));
  const sector = Math.min(5, Math.floor(ang / (PI / 3)));
  const th = ang - sector * PI / 3;
  let T1 = m * Math.sin(PI / 3 - th), T2 = m * Math.sin(th);
  if (T1 + T2 > 1) { const k = 1 / (T1 + T2); T1 *= k; T2 *= k; }   // 超出六边形：按比例压缩
  const T0 = Math.max(0, 1 - T1 - T2);
  const [a, b, c] = invClarke(va, vb);
  const vcom = -(Math.max(a, b, c) + Math.min(a, b, c)) / 2;        // 零序注入
  return {
    m, sector, angle: ang, T1, T2, T0,
    da: clamp(0.5 + (a + vcom) / Vdc, 0, 1),
    db: clamp(0.5 + (b + vcom) / Vdc, 0, 1),
    dc: clamp(0.5 + (c + vcom) / Vdc, 0, 1),
  };
}
/* 开关状态 → 电机相电压（星形连接，相对中性点）→ αβ */
function switchVoltageAB(Sa, Sb, Sc, Vdc) {
  const m = (Sa + Sb + Sc) / 3;
  return clarke((Sa - m) * Vdc, (Sb - m) * Vdc, (Sc - m) * Vdc);
}

/* ---------- PI 调节器（条件积分抗饱和） ---------- */
class PI_ {
  constructor(kp = 0, ki = 0) { this.kp = kp; this.ki = ki; this.x = 0; }
  reset(x = 0) { this.x = x; }
  step(e, dt, lo, hi) {
    const u0 = this.kp * e + this.x;
    const sat = (u0 > hi && e > 0) || (u0 < lo && e < 0);
    if (!sat) this.x += this.ki * e * dt;
    this.x = clamp(this.x, lo, hi);
    return clamp(this.kp * e + this.x, lo, hi);
  }
}

/* ---------- FOC 控制器 ----------
   模式：
   speed    速度闭环：速度 PI → iq*，电流环跟踪
   torque   转矩（电流）闭环：直接给定 id*、iq*
   dyno     转矩–电流角实验：测功机拖动转子，给定 |I| 与 β（电流矢量超前 d 轴的电角）
   dcalign  直流定位：在静止坐标系给定一个固定方向的电流矢量，转子被吸到对齐位置
   openloop I/f 开环：电流矢量按给定频率旋转，转子被“拖着”同步，过载会失步 */
class FocController {
  constructor() {
    this.mode = 'speed';
    this.cmd = {
      speedRpm: 600,      // ω*
      idManual: 0,        // id*（手动，叠加在弱磁输出上）
      iqManual: 3,        // 转矩模式 iq*
      iAmp: 6,            // dyno / dcalign / openloop 电流幅值
      beta: PI / 2,       // dyno 电流角（电角）
      phi: 0,             // dcalign 定子电流矢量方向（电角，静止坐标系）
    };
    this.cfg = {
      currentBwHz: 800,   // 电流环带宽
      speedBwHz: 12,      // 速度环带宽
      decouple: true,     // dq 解耦 + 反电势前馈
      delayComp: true,    // 1.5 Ts 数字延时的角度补偿
      fieldWeakening: true,
      encoderOffset: 0,   // 编码器零位误差（电角 rad）
      Imax: 12,           // 电流限幅（峰值 A）
      accelRpm: 20000,    // 速度指令斜坡（rpm/s）
      speedLoopHz: 2000,
    };
    this.iPI = { d: new PI_(), q: new PI_() };
    this.wPI = new PI_();
    this.reset();
  }

  reset() {
    this.iPI.d.reset(); this.iPI.q.reset(); this.wPI.reset();
    this.idFW = 0; this.wRefRamp = 0; this.counter = 0;
    this.thetaOL = 0; this.omegaOL = 0;
    this.out = {
      ialpha: 0, ibeta: 0, id: 0, iq: 0, idRef: 0, iqRef: 0,
      vd: 0, vq: 0, valpha: 0, vbeta: 0, vRatio: 0, saturated: false,
      thetaCtrl: 0, omegaMeas: 0, wRef: 0, iqLimit: 0, idFW: 0, slip: false,
    };
  }

  setMode(mode, thetaNow) {
    if (mode === this.mode) return;
    // 切换模式时让 I/f 角度从当前控制角连续出发，避免电流矢量跳变
    this.thetaOL = this.out.thetaCtrl ?? thetaNow ?? 0;
    this.omegaOL = mode === 'openloop' ? 0 : this.omegaOL;
    this.mode = mode;
    this.wPI.reset(this.out.iqRef || 0);
    this.wRefRamp = this.out.omegaMeas || 0;
  }

  /* 按电机参数整定增益：电流环零极点对消 Kp=L·ωc, Ki=R·ωc；速度环 Kp=J·ωs/Kt */
  tune(motor) {
    const wc = TAU * this.cfg.currentBwHz, ws = TAU * this.cfg.speedBwHz;
    this.iPI.d.kp = motor.Ld * wc; this.iPI.d.ki = motor.R * wc;
    this.iPI.q.kp = motor.Lq * wc; this.iPI.q.ki = motor.R * wc;
    const Kt = 1.5 * motor.p * motor.psi;
    this.wPI.kp = motor.J * ws / Kt;
    this.wPI.ki = this.wPI.kp * ws / 4;
    this.gains = { kpi: this.iPI.q.kp, kii: this.iPI.q.ki, kpw: this.wPI.kp, kiw: this.wPI.ki };
  }

  /* 每个 PWM 周期调用一次（在载波顶点、零矢量 000 中心采样）
     meas = {ia, ib, ic, thetaE, omegaM}；返回下一周期要输出的 αβ 电压 */
  update(meas, Ts, motor, Vdc) {
    const o = this.out, c = this.cfg, cmd = this.cmd, p = motor.p;
    const Vmax = Vdc / SQ3;

    // 测量：编码器角（含零位误差）+ 速度滤波（模拟差分测速）
    const thMeas = wrap2Pi(meas.thetaE + c.encoderOffset);
    o.omegaMeas += (meas.omegaM - o.omegaMeas) * Math.min(1, Ts / 0.0008);
    const weMeas = p * o.omegaMeas;

    // 1) 决定控制坐标系的角度与 dq 电流指令
    let theta, we, useFF = c.decouple;
    switch (this.mode) {
      case 'dcalign':
        theta = cmd.phi; we = 0; useFF = false;
        o.idRef = cmd.iAmp; o.iqRef = 0;
        break;
      case 'openloop': {
        const wTarget = cmd.speedRpm * RPM * p;
        const dw = c.accelRpm * RPM * p * Ts;
        this.omegaOL += clamp(wTarget - this.omegaOL, -dw, dw);
        this.thetaOL = wrap2Pi(this.thetaOL + this.omegaOL * Ts);
        theta = this.thetaOL; we = this.omegaOL; useFF = false;
        o.idRef = cmd.iAmp; o.iqRef = 0;
        o.slip = Math.abs(wrapPi(theta - meas.thetaE)) > PI / 2;
        break;
      }
      case 'dyno':
        theta = thMeas; we = weMeas;
        o.idRef = cmd.iAmp * Math.cos(cmd.beta); o.iqRef = cmd.iAmp * Math.sin(cmd.beta);
        break;
      default: {   // speed / torque
        theta = thMeas; we = weMeas;
        const idRef = clamp(cmd.idManual + (c.fieldWeakening ? this.idFW : 0), -c.Imax * 0.95, c.Imax * 0.5);
        o.iqLimit = Math.sqrt(Math.max(0, c.Imax * c.Imax - idRef * idRef));
        if (this.mode === 'speed') {
          const N = Math.max(1, Math.round(1 / (Ts * c.speedLoopHz)));
          if (++this.counter >= N) {
            this.counter = 0;
            const Tsw = N * Ts, wRef = cmd.speedRpm * RPM, dw = c.accelRpm * RPM * Tsw;
            this.wRefRamp += clamp(wRef - this.wRefRamp, -dw, dw);
            o.iqRef = this.wPI.step(this.wRefRamp - o.omegaMeas, Tsw, -o.iqLimit, o.iqLimit);
          }
          o.wRef = this.wRefRamp;
        } else {
          o.iqRef = clamp(cmd.iqManual, -o.iqLimit, o.iqLimit);
        }
        o.idRef = idRef;
      }
    }

    // 2) Clarke + Park（用控制角）
    [o.ialpha, o.ibeta] = clarke(meas.ia, meas.ib, meas.ic);
    [o.id, o.iq] = park(o.ialpha, o.ibeta, theta);

    // 3) 电流环 PI + 解耦前馈，矢量限幅到线性调制圆
    const ffd = useFF ? -we * motor.Lq * o.iq : 0;
    const ffq = useFF ? we * (motor.Ld * o.id + motor.psi) : 0;
    const ed = o.idRef - o.id, eq = o.iqRef - o.iq;
    const PIdq = this.iPI;
    let vd = PIdq.d.kp * ed + PIdq.d.x + ffd;
    let vq = PIdq.q.kp * eq + PIdq.q.x + ffq;
    const vUn = Math.hypot(vd, vq);
    o.vRatio = vUn / Vmax;
    o.saturated = vUn > Vmax;
    if (o.saturated) {                       // 等比缩放到电压圆；饱和期间冻结积分（条件积分抗饱和）
      const k = Vmax / vUn;
      vd *= k; vq *= k;
      // 仅允许“把电压往回拉”的积分方向，避免积分器越积越深
      if (ed * vd < 0) PIdq.d.x = clamp(PIdq.d.x + PIdq.d.ki * ed * Ts, -Vmax, Vmax);
      if (eq * vq < 0) PIdq.q.x = clamp(PIdq.q.x + PIdq.q.ki * eq * Ts, -Vmax, Vmax);
    } else {
      PIdq.d.x = clamp(PIdq.d.x + PIdq.d.ki * ed * Ts, -Vmax, Vmax);
      PIdq.q.x = clamp(PIdq.q.x + PIdq.q.ki * eq * Ts, -Vmax, Vmax);
    }
    o.vd = vd; o.vq = vq;

    // 4) 电压反馈弱磁：电压用到 95% 以上就把 id 往负方向推
    if (c.fieldWeakening && (this.mode === 'speed' || this.mode === 'torque')) {
      this.idFW = clamp(this.idFW + 600 * (0.95 * Vmax - Math.min(vUn, 1.2 * Vmax)) * Ts, -c.Imax * 0.9, 0);
    } else this.idFW = 0;
    o.idFW = this.idFW;

    // 5) 逆 Park（补偿 1.5 Ts 延时带来的角度滞后）
    const thOut = theta + (c.delayComp ? 1.5 * we * Ts : 0);
    [o.valpha, o.vbeta] = invPark(vd, vq, thOut);
    o.thetaCtrl = theta;
    return [o.valpha, o.vbeta];
  }
}

FOC.math = { PI, TAU, SQ3, RPM, clamp, wrapPi, wrap2Pi, clarke, invClarke, park, invPark };
FOC.SVBITS = SVBITS;
FOC.svpwm = svpwm;
FOC.switchVoltageAB = switchVoltageAB;
FOC.PI = PI_;
FOC.FocController = FocController;
});
