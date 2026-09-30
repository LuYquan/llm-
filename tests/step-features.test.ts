/**
 * 独立阶跃特征提取纯函数分析服务单元测试 (extract_step_features)
 */

import assert from 'node:assert/strict';
import { extract_step_features, extract_step_features_from_store } from '../src/core/analysis';
import { ChannelStore } from '../src/core/channel';

export async function runStepFeaturesTests() {
  console.log('--- [StepAnalyzer] 开始测试阶跃特征提取纯函数算法 ---');

  // 1. 标准典型二阶欠阻尼系统阶跃响应 (理论真值对照)
  // 传递函数 G(s) = wn^2 / (s^2 + 2*zeta*wn*s + wn^2)
  // 当 zeta = 0.5, wn = 10 rad/s 时:
  // 理论超调量 Mp = e^(-pi*zeta / sqrt(1-zeta^2)) * 100% = e^(-0.5*pi / 0.8660) * 100% = 16.30%
  // 理论阻尼比 zeta = 0.5
  {
    console.log('  1. 测试典型二阶欠阻尼系统 (zeta=0.5, wn=10, 理论 Mp=16.3%)');
    const dt = 0.005; // 200Hz 采样
    const tTotal = 2.0;
    const n = Math.floor(tTotal / dt);

    const times = new Float64Array(n);
    const actual = new Float64Array(n);
    const target = new Float64Array(n);

    const zeta = 0.5;
    const wn = 10;
    const wd = wn * Math.sqrt(1 - zeta * zeta);

    for (let i = 0; i < n; i++) {
      const t = i * dt;
      times[i] = t;
      target[i] = 100.0; // 阶跃目标值 100

      // 解析时域解: y(t) = y_target * (1 - e^(-zeta*wn*t) * (cos(wd*t) + (zeta/sqrt(1-zeta^2))*sin(wd*t)))
      const expTerm = Math.exp(-zeta * wn * t);
      const trigTerm = Math.cos(wd * t) + (zeta / Math.sqrt(1 - zeta * zeta)) * Math.sin(wd * t);
      actual[i] = 100.0 * (1 - expTerm * trigTerm);
    }

    const metrics = extract_step_features(times, actual, target, { stepTime: 0.0 });
    assert.ok(metrics !== null, '阶跃分析指标不应为空');

    console.log(`     实测指标: Mp = ${metrics.overshoot_pct}%, tr = ${metrics.rise_time_s}s, ts = ${metrics.settling_time_s}s, zeta = ${metrics.damping_ratio}`);

    // 超调量误差在理论值 16.30% 的 ±1% 范围内
    assert.ok(
      Math.abs(metrics.overshoot_pct - 16.3) < 1.0,
      `超调量误差过大: ${metrics.overshoot_pct}% (预期约 16.3%)`
    );

    // 阻尼比估计值在 0.50 的 ±0.03 范围内
    assert.ok(
      metrics.damping_ratio !== null && Math.abs(metrics.damping_ratio - 0.5) < 0.03,
      `阻尼比估计误差过大: ${metrics.damping_ratio} (预期约 0.50)`
    );

    // 稳态误差接近 0
    assert.ok(metrics.steady_state_error < 0.1);
    assert.equal(metrics.is_stable, true);
    assert.equal(metrics.step_amplitude, 100);
  }

  // 2. 一阶惯性过阻尼系统 (无超调单调上升, Mp = 0%)
  {
    console.log('  2. 测试一阶过阻尼系统 (单调上升, 理论 Mp=0%, zeta=1.0)');
    const dt = 0.01;
    const times = new Float64Array(200);
    const actual = new Float64Array(200);

    for (let i = 0; i < 200; i++) {
      const t = i * dt;
      times[i] = t;
      actual[i] = 50.0 * (1 - Math.exp(-t / 0.3)); // T = 0.3s
    }

    const metrics = extract_step_features(times, actual, 50.0, { stepTime: 0.0 });
    assert.ok(metrics !== null);
    assert.equal(metrics.overshoot_pct, 0);
    assert.equal(metrics.damping_ratio, 1.0);
    assert.ok(metrics.rise_time_s !== null && metrics.rise_time_s > 0);
    assert.equal(metrics.is_stable, true);
  }

  // 3. 负向阶跃响应 (从 50 阶跃至 -20)
  {
    console.log('  3. 测试负向阶跃响应 (阶跃方向反转)');
    const dt = 0.01;
    const times = new Float64Array(100);
    const actual = new Float64Array(100);

    for (let i = 0; i < 100; i++) {
      const t = i * dt;
      times[i] = t;
      // 目标值 -20，初值 50，delta = -70
      actual[i] = 50 - 70 * (1 - Math.exp(-t / 0.2));
    }

    const metrics = extract_step_features(times, actual, -20, { stepTime: 0.0 });
    assert.ok(metrics !== null);
    assert.equal(metrics.y0, 50);
    assert.equal(metrics.y_target, -20);
    assert.equal(metrics.step_amplitude, 70);
    assert.equal(metrics.overshoot_pct, 0);
    assert.ok(metrics.rise_time_s !== null && metrics.rise_time_s > 0);
  }

  // 4. 边界异常条件测试 (空数据、点数不足、幅值为0)
  {
    console.log('  4. 测试边界与容错条件 (<10点、零幅值返回 null)');
    assert.equal(extract_step_features([], []), null);
    assert.equal(extract_step_features([1, 2, 3], [1, 2, 3]), null);

    // 零幅值平直信号
    const flatT = Array.from({ length: 20 }, (_, i) => i * 0.1);
    const flatV = Array.from({ length: 20 }, () => 10.0);
    assert.equal(extract_step_features(flatT, flatV, 10.0, { stepTime: 0.0 }), null);
  }

  // 4b. 无阶跃标记、重复时间和非法值不得生成控制指标
  {
    const times = Array.from({ length: 30 }, (_, i) => i * 0.01);
    const values = Array.from({ length: 30 }, (_, i) => 1 - Math.exp(-i * 0.01));
    assert.equal(extract_step_features(times, values, 1), null, '标量目标必须带显式阶跃时刻或索引');
    assert.equal(extract_step_features(times, values), null, '缺少目标值时不得默认使用稳态值');
    assert.equal(extract_step_features(times, values, Array(30).fill(1)), null, '恒定目标序列没有阶跃边沿时不得推测');
    const duplicate = [...times];
    duplicate[10] = duplicate[9];
    assert.equal(extract_step_features(duplicate, values, 1, { stepTime: 0 }), null);
    const missing = [...values];
    missing[15] = NaN;
    assert.equal(extract_step_features(times, missing, 1, { stepTime: 0 }), null);
    assert.equal(extract_step_features(times, values, 1, { stepTime: 99 }), null);
  }

  // 5. 极端超调与阻尼比物理边界防护测试 (Mp >= 100% 对应 zeta = 0.0，杜绝负阻尼比)
  {
    console.log('  5. 测试极端超调与阻尼比物理自洽性 (Mp >= 100% 阻尼比限制为 0.0)');
    const dt = 0.01;
    const times = new Float64Array(100);
    const actual = new Float64Array(100);
    // 目标 10，初值 0，峰值冲到 21+ (超调 > 100%)
    for (let i = 0; i < 100; i++) {
      const t = i * dt;
      times[i] = t;
      actual[i] = 10 * (1 - Math.exp(-t / 0.1)) + 15 * (t / 0.1) * Math.exp(1 - t / 0.1);
    }
    const metrics = extract_step_features(times, actual, 10, { stepTime: 0.0 });
    assert.ok(metrics !== null);
    assert.ok(metrics.overshoot_pct > 100, `超调应 > 100%, 实测: ${metrics.overshoot_pct}%`);
    assert.equal(metrics.damping_ratio, 0.0, '超调 >= 100% 时阻尼比必须为 0.0 而非负数');
  }

  // 6. 严防假性收敛测试：末尾单点瞬间穿过误差带不能被判定为 stable
  {
    console.log('  6. 测试严防假性收敛 (末尾单点穿过误差带不得被判定为 is_stable=true)');
    const dt = 0.01;
    const n = 100;
    const times = new Float64Array(n);
    const actual = new Float64Array(n);
    // 从 0 阶跃至 100，持续等幅震荡 (未阻尼)，末尾点恰好穿过 100
    for (let i = 0; i < n; i++) {
      times[i] = i * dt;
      actual[i] = 100 - 100 * Math.cos(2 * Math.PI * 2 * times[i]);
    }
    actual[n - 1] = 100.0; // 仅末尾一个点落在目标上
    const metrics = extract_step_features(times, actual, 100.0, { stepTime: 0.0, minSustainSeconds: 0.2 });
    assert.ok(metrics !== null);
    assert.equal(metrics.is_stable, false, '未达到最小维持时间的大幅震荡绝不可被判定为稳定');
    assert.equal(metrics.settling_time_s, null);
  }

  // 7. 负向阶跃震荡周期检测测试
  {
    console.log('  7. 测试负向阶跃震荡周期与频率检测');
    const dt = 0.005;
    const n = 400; // 2s
    const times = new Float64Array(n);
    const actual = new Float64Array(n);
    // 从 0 阶跃至 -50，伴随 2Hz 阻尼震荡
    const freq = 2.0;
    for (let i = 0; i < n; i++) {
      const t = i * dt;
      times[i] = t;
      actual[i] = -50 * (1 - Math.exp(-2 * t) * Math.cos(2 * Math.PI * freq * t));
    }
    const metrics = extract_step_features(times, actual, -50.0, { stepTime: 0.0 });
    assert.ok(metrics !== null);
    assert.ok(metrics.oscillation_freq_hz !== null);
    assert.ok(
      Math.abs(metrics.oscillation_freq_hz - freq) < 0.2,
      `负阶跃振荡频率偏差过大: ${metrics.oscillation_freq_hz} vs ${freq}`
    );
  }

  // 8. 与 ChannelStore 联动测试 (extract_step_features_from_store)
  {
    console.log('  8. 测试 extract_step_features_from_store 联动提取与 stepTime 配置');
    const store = new ChannelStore();
    for (let i = 0; i < 100; i++) {
      const t = i * 0.01;
      if (i % 10 === 0) store.push('setpoint', t, t < 0.2 ? 0 : 100);
      store.push('actual', t, t < 0.2 ? 0 : 100 * (1 - Math.exp(-(t - 0.2) / 0.2)));
    }

    const metrics = extract_step_features_from_store(store, 'actual', 'setpoint');
    assert.ok(metrics !== null);
    assert.equal(metrics.y_target, 100);
    assert.equal(metrics.overshoot_pct, 0);

    const noStepStore = new ChannelStore();
    for (let i = 0; i < 20; i++) {
      noStepStore.push('actual', i * 0.01, i);
      noStepStore.push('setpoint', i * 0.02, 100);
    }
    assert.equal(extract_step_features_from_store(noStepStore, 'actual', 'setpoint'), null,
      '不同采样率下没有目标阶跃的通道不能因数组长度差异形成伪结果');
  }

  console.log('  ✓ [StepAnalyzer] 阶跃特征提取算法单测全部通过！\n');
}
