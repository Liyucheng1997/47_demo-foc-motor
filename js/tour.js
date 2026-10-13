/* =========================================================================
   tour.js —— 分步讲解：每一步自动配置仿真场景 + 高亮相关框图/图表
   ========================================================================= */
(function (FOC) {
'use strict';

/* 每步开始前先恢复的默认值，保证步骤之间互不影响 */
function baseline(app) {
  const c = app.sim.ctrl.cfg;
  app.setSlider('sEnc', 0); app.setSlider('sFpwm', 10); app.setSlider('sVdc', 48);
  app.setSlider('sId', 0); app.setSlider('sCbw', 800); app.setSlider('sSbw', 12); app.setSlider('sAcc', 3);
  if (!c.fieldWeakening) document.getElementById('bFW').click();
  if (!c.decouple) document.getElementById('bDecouple').click();
  if (app.st.kick) document.getElementById('bKick').click();
  app.sim.motor.load.type = 'const'; app.segSet('loadSeg', 'load', 'const');
  ['housing', 'explode', 'labels'].forEach(k => app.setFlag(k, false));
  ['bus', 'field', 'current', 'delta'].forEach(k => app.setFlag(k, true));
  app.setFieldView('total'); app.setTimeScale(0.05); app.setPaused(false);
}

const STEPS = [
  {
    title: '认识电机：定子、绕组、永磁转子',
    html: `<p>这是一台<b>表贴式永磁同步电机（PMSM）</b>。外圈是硅钢片叠成的<b>定子铁芯</b>，每个齿上绕着一个<b>集中绕组</b>线圈（红/绿/蓝 = A/B/C 三相）；中间的<b>转子</b>表面贴着永磁体，红为 N 极、蓝为 S 极；后端的<b>编码器</b>实时测量转子角度。</p>
      <p>FOC 要做的事：根据编码器测到的转子位置，算出三相绕组此刻应该通多大的电流，让定子磁场始终“拉着”转子走。</p>
      <p class="try">试一试：拖动鼠标旋转视角；关闭「爆炸图」看装配状态；在右侧「参数」页切换不同槽极方案。</p>`,
    apply(app) {
      app.setDesign('6s2p'); app.setMode('speed'); app.setSlider('sSpeed', 300); app.setSlider('sLoad', 0.1);
      app.setFlag('explode', true); app.setFlag('labels', true); app.setFlag('housing', true); app.setFlag('field', false); app.setFlag('delta', false);
      app.setView('3d'); app.scene.setCamera('iso'); app.setTab('param');
    },
    hl: ['enc'], card: 'cardDesign',
  },
  {
    title: '一个线圈通电 = 一块电磁铁',
    html: `<p>现在只给定子一个<b>固定方向</b>的电流（φ = 0° 即 A 相轴方向：i<sub>a</sub> = I，i<sub>b</sub> = i<sub>c</sub> = −I/2）。看右边剖面图：导体里 ⊙ 表示电流流出屏幕、⊗ 表示流入，按<b>右手螺旋定则</b>，A 齿的磁通向外穿出、A′ 齿的磁通向内——定子变成了一块磁铁。</p>
      <p>转子 N 极被吸向定子磁场方向，像挂在弹簧上一样来回摆几下，最后停在对齐位置：此时<b>只有吸力、没有转矩</b>。</p>
      <p class="try">试一试：拖动 φ 滑块（或在图上滚动滚轮），转子会跟着转过去；切换「仅定子电流 / 仅永磁体 / 合成磁场」对比磁力线。</p>`,
    apply(app) {
      app.setDesign('6s2p'); app.setMode('dcalign'); app.setSlider('sIamp', 6); app.setSlider('sPhi', 0); app.setSlider('sLoad', 0.05);
      app.setView('split'); app.setFieldView('arm'); app.scene.setCamera('front'); app.setTab('ctrl');
    },
    hl: [], card: 'cardCtrl',
  },
  {
    title: '三相电流合成旋转磁场',
    html: `<p>三相绕组在空间上互差 120°，通入时间上互差 120° 的正弦电流，三个脉振磁场叠加成一个<b>幅值不变、匀速旋转</b>的磁场。这里让电流矢量按 120 rpm 旋转（I/f 开环），转子被“拖着”同步转动。</p>
      <p>注意转子 N 极（d 轴）<b>落后</b>于定子磁场一个角度 δ——负载越大，落后越多；δ 超过 90° 电角后电磁转矩反而减小，转子就会<b>失步</b>。</p>
      <p class="try">试一试：把负载慢慢加到 0.6 N·m 以上（超过 K<sub>t</sub>·|I| = 0.54 N·m），观察 HUD 里的「失步!」。</p>`,
    apply(app) {
      app.setDesign('6s2p'); app.setMode('openloop'); app.setSlider('sAcc', 0); app.setSlider('sIamp', 6); app.setSlider('sSpeed', 120); app.setSlider('sLoad', 0.15);
      app.setView('split'); app.setFieldView('total'); app.scene.setCamera('front'); app.setTab('ctrl'); app.setScope('abc');
    },
    hl: [], card: 'cardCtrl',
  },
  {
    title: '转矩从哪里来：夹角 β',
    html: `<p>测功机把转子堵住不动，我们直接设定电流矢量相对 d 轴的电角 β。电磁转矩</p>
      <p style="text-align:center;font-size:14px">T<sub>e</sub> = 1.5·p·ψ<sub>f</sub>·|i<sub>s</sub>|·sin β = K<sub>t</sub>·i<sub>q</sub></p>
      <p>β = 90° 时定子磁场与永磁磁场<b>正交</b>，同样电流转矩最大——磁力线被明显“扭”向一侧，就像被拉紧的橡皮筋。β = 0° 时两磁场同向，只增强磁场不产生转矩。</p>
      <p class="try">试一试：在剖面图上滚动滚轮改变 β，观察 HUD 转矩与磁力线扭曲；看「磁场」页的气隙磁密：两条波形相差 90° 电角。</p>`,
    apply(app) {
      app.setDesign('6s2p'); app.setMode('dyno'); app.setSlider('sDyno', 0); app.setSlider('sIamp', 8); app.setSlider('sBeta', 90);
      app.setView('2d'); app.setFieldView('total'); app.setTab('field');
    },
    hl: ['motor'], card: 'cardGap',
  },
  {
    title: 'Clarke 变换：三相 → 两相',
    html: `<p>三个相电流满足 i<sub>a</sub> + i<sub>b</sub> + i<sub>c</sub> = 0，只有两个自由度。Clarke 变换把它们沿各自相轴（互差 120°）的矢量<b>首尾相接</b>，合成一个平面矢量 (i<sub>α</sub>, i<sub>β</sub>)。</p>
      <p>左图里三根彩色小箭头首尾相连得到品红色的 i<sub>s</sub>——它在静止坐标系里不停旋转，i<sub>α</sub>、i<sub>β</sub> 仍是正弦交流量。</p>`,
    apply(app) {
      app.setDesign('6s2p'); app.setMode('speed'); app.setSlider('sSpeed', 300); app.setSlider('sLoad', 0.3);
      app.setView('3d'); app.scene.setCamera('front'); app.setTab('xform');
    },
    hl: ['clarke'], card: 'cardVec',
  },
  {
    title: 'Park 变换：站到转子上看',
    html: `<p>Park 变换把坐标系转 −θ<sub>e</sub>，让 d 轴始终对准转子 N 极。右图里同一个 i<sub>s</sub> <b>几乎静止</b>：i<sub>d</sub>、i<sub>q</sub> 变成了<b>直流量</b>。</p>
      <p>交流控制问题由此变成直流控制问题：想要多大转矩就给多大 i<sub>q</sub>，i<sub>d</sub> 保持 0。逆 Park 再用同一个 θ<sub>e</sub> 把 dq 电压转回静止坐标去驱动逆变器——所以编码器是 FOC 的“眼睛”。</p>
      <p class="try">试一试：改目标转速，左图矢量转速随之变化，右图位置基本不变。</p>`,
    apply(app) {
      app.setDesign('6s2p'); app.setMode('speed'); app.setSlider('sSpeed', 300); app.setSlider('sLoad', 0.3);
      app.setView('3d'); app.setTab('xform');
    },
    hl: ['park', 'ipark', 'enc'], card: 'cardVec',
  },
  {
    title: '电流环：PI + 解耦前馈',
    html: `<p>dq 坐标下 u<sub>q</sub> = R·i<sub>q</sub> + L·di<sub>q</sub>/dt + ω<sub>e</sub>(L·i<sub>d</sub> + ψ<sub>f</sub>)。PI 参数取 K<sub>p</sub> = L·ω<sub>c</sub>、K<sub>i</sub> = R·ω<sub>c</sub>，正好抵消电机的电气极点，闭环成为带宽 ω<sub>c</sub> 的一阶系统；旋转带来的耦合项与反电势用<b>前馈</b>直接补上。</p>
      <p>这里是转矩模式 + 风机负载：转速会稳定在转矩平衡点。</p>
      <p class="try">试一试：拖动 i<sub>q</sub><sup>*</sup>，在 dq 示波器（时间窗 5 ms）看阶跃响应；到「参数」页关闭解耦前馈或调电流环带宽对比。</p>`,
    apply(app) {
      app.setDesign('12s10p'); app.setMode('torque'); app.setSlider('sIq', 4); app.setSlider('sLoad', 0.6);
      app.sim.motor.load.type = 'fan'; app.segSet('loadSeg', 'load', 'fan');
      app.setView('3d'); app.scene.setCamera('iso'); app.setTab('ctrl'); app.setScope('dq'); app.setSlider('sWin', 2);
    },
    hl: ['cur', 'sum2', 'park'], card: 'cardScope',
  },
  {
    title: '速度环：串级控制',
    html: `<p>外环速度 PI 比较 ω<sup>*</sup> 与编码器测速，输出 i<sub>q</sub><sup>*</sup> 交给内环。内环带宽（~800 Hz）远高于外环（~12 Hz），外环看内环就像一个理想的“转矩源”。</p>
      <p>转速阶跃时 i<sub>q</sub><sup>*</sup> 先打满电流限幅全力加速；接近目标后回落到刚好平衡负载的值。</p>
      <p class="try">试一试：点「突加负载 +0.5」——转速先掉一点，随后被积分作用拉回；把目标转速从 600 改到 −600 看反转过程。</p>`,
    apply(app) {
      app.setDesign('12s10p'); app.setMode('speed'); app.setSlider('sSpeed', 600); app.setSlider('sLoad', 0.15);
      app.setView('3d'); app.setTab('ctrl'); app.setScope('speed'); app.setSlider('sWin', 0);
    },
    hl: ['spd', 'sum1', 'enc'], card: 'cardScope',
  },
  {
    title: 'SVPWM：用 8 种开关状态拼出任意电压',
    html: `<p>逆变器每个桥臂只能接正母线或负母线，三相共 2³ = 8 种组合：6 个非零矢量构成六边形顶点，另有 2 个零矢量。</p>
      <p>想要的电压 U<sub>ref</sub> 落在某个扇区里，就在一个开关周期内按 T<sub>1</sub> : T<sub>2</sub> 依次输出两个相邻顶点矢量，余下时间补零矢量——<b>时间加权平均恰好等于 U<sub>ref</sub></b>。</p>
      <p class="try">试一试：把「参数」页的母线电压调低到 20 V，看 U<sub>ref</sub> 顶到虚线圆（m = 1）出现电压饱和。</p>`,
    apply(app) {
      app.setDesign('6s2p'); app.setMode('speed'); app.setSlider('sSpeed', 600); app.setSlider('sLoad', 0.3);
      app.setView('3d'); app.setTab('pwm');
    },
    hl: ['svpwm', 'ipark'], card: 'cardHex',
  },
  {
    title: '慢放 20000 倍：看见每一次开关',
    html: `<p>真实的开关频率是 10 kHz（周期 100 µs）。现在仿真时间放慢到 1/20000，一个开关周期要演示 2 秒：载波光标、六边形上的黄点、逆变桥 6 个开关都与仿真<b>真实同步</b>。</p>
      <p>开关序列是对称的七段式 000→100→110→111→110→100→000，每管每周期只开关一次。在零矢量 000 的中点采样电流，此时 PWM 纹波正好经过平均值。</p>
      <p class="try">试一试：回到「控制」页示波器选三相电流、时间窗 1 ms，能看到电流在每个开关段的折线式纹波；把 f<sub>PWM</sub> 降到 3 kHz 纹波更明显。</p>`,
    apply(app) {
      app.setDesign('6s2p'); app.setMode('speed'); app.setSlider('sSpeed', 600); app.setSlider('sLoad', 0.3);
      app.setTimeScale(0.00005); app.setView('3d'); app.setTab('pwm'); app.setScope('abc'); app.setSlider('sWin', 1);
    },
    hl: ['svpwm', 'inv'], card: 'cardPwm',
  },
  {
    title: '电压极限与弱磁',
    html: `<p>反电势 E = ω<sub>e</sub>ψ<sub>f</sub> 随转速线性增长，而逆变器最多只能输出 V<sub>dc</sub>/√3。在 dq 平面上，这表现为一个随转速<b>不断缩小的电压极限圆</b>（橙色），工作点必须留在圆内。</p>
      <p>目标 5000 rpm 已超过空载转折速度，控制器检测到电压饱和后自动注入<b>负 i<sub>d</sub></b>，削弱合成磁场、压低反电势，于是能继续升速——代价是额外的铜耗。</p>
      <p class="try">试一试：关闭「自动弱磁」，转速会卡在约 3900 rpm；再打开看工作点沿电压圆向左移动。</p>`,
    apply(app) {
      app.setDesign('12s8p'); app.setMode('speed'); app.setSlider('sSpeed', 5000); app.setSlider('sLoad', 0.1);
      app.setTimeScale(0.05); app.setView('3d'); app.setTab('field');
    },
    hl: ['cur', 'sum2'], card: 'cardDq',
  },
  {
    title: '编码器零位误差的代价',
    html: `<p>FOC 的一切都建立在“知道转子在哪”之上。这里人为给编码器加了 40° 电角的零位误差：控制器以为电流放在 q 轴上，实际上电流矢量偏离了 q 轴。</p>
      <p>结果：为了产生同样的转矩，需要更大的电流（cos 40° ≈ 0.77，电流增加约 30%），同时出现了不需要的 i<sub>d</sub>，效率下降——HUD 里的「真实 i<sub>d</sub>/i<sub>q</sub>」按转子真实位置计算，控制器自己却以为 i<sub>d</sub> = 0。误差超过 90° 时转矩方向都会反，电机失控。</p>
      <p class="try">试一试：在 0° 和 40° 之间切换「编码器零位误差」，对比 HUD 中的效率与 Clarke/Park 图里真实的电流位置。</p>`,
    apply(app) {
      app.setDesign('6s2p'); app.setMode('speed'); app.setSlider('sSpeed', 800); app.setSlider('sLoad', 0.5);
      app.setSlider('sEnc', 40); app.setView('split'); app.setTab('param');
    },
    hl: ['enc'], card: 'cardCtrlParam',
  },
  {
    title: '自由探索',
    html: `<p>你已经走完了 FOC 的完整链路：<b>编码器测 θ → Clarke/Park → 电流 PI → 逆 Park → SVPWM → 逆变桥 → 电机磁场 → 转矩</b>。底部框图的每个方块都可以点击跳转到对应图表。</p>
      <p>更多玩法：切换 12 槽 14 极等多极方案观察电角度与机械角度的关系；调大转动惯量看速度环变慢；把电流环带宽调到 f<sub>PWM</sub> 的 20% 以上观察振荡。</p>`,
    apply(app) {
      app.setDesign('12s10p'); app.setMode('speed'); app.setSlider('sSpeed', 800); app.setSlider('sLoad', 0.2);
      app.setView('split'); app.setTab('ctrl'); app.setScope('abc');
    },
    hl: [], card: null,
  },
];

class Tour {
  constructor(app) {
    this.app = app; this.i = 0; this.active = false;
    this.el = document.getElementById('tour');
    const dots = document.getElementById('tourDots');
    dots.innerHTML = STEPS.map((_, i) => `<i data-i="${i}" title="${STEPS[i].title}"></i>`).join('');
    dots.addEventListener('click', e => { if (e.target.dataset.i) this.show(+e.target.dataset.i); });
    document.getElementById('tourPrev').addEventListener('click', () => this.go(-1));
    document.getElementById('tourNext').addEventListener('click', () => this.go(1));
    document.getElementById('tourClose').addEventListener('click', () => this.close());
  }
  open(i = 0) { this.active = true; this.el.hidden = false; this.show(i); }
  close() { this.active = false; this.el.hidden = true; this.app.diagram.highlight([]); }
  go(d) { const n = this.i + d; if (n >= STEPS.length) return this.close(); if (n >= 0) this.show(n); }
  show(i) {
    this.i = i;
    const s = STEPS[i], app = this.app;
    baseline(app);
    s.apply(app);
    document.getElementById('tourStep').textContent = `${i + 1}/${STEPS.length}`;
    document.getElementById('tourTitle').textContent = s.title;
    document.getElementById('tourBody').innerHTML = s.html;
    document.getElementById('tourPrev').disabled = i === 0;
    document.getElementById('tourNext').textContent = i === STEPS.length - 1 ? '完成' : '下一步';
    document.querySelectorAll('#tourDots i').forEach((d, k) => d.classList.toggle('on', k === i));
    app.diagram.highlight(s.hl);
    if (s.card) requestAnimationFrame(() => app.focusCard(s.card));
  }
}

FOC.Tour = Tour;
FOC.TOUR_STEPS = STEPS;
})(window.FOC);
