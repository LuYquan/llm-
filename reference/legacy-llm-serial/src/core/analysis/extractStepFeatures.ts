/**
 * 独立阶跃特征提取纯函数分析服务 (extract_step_features)
 * 严格基于控制理论与确定性数值算法，不依赖任何 UI 与 LLM 逻辑
 */

import type { StepAnalysisOptions, StepResponseMetrics } from './types';
import type { ChannelStore } from '../channel/ChannelStore';

export interface StepInputQuality {
  valid: boolean;
  reason?: string;
  stepIndex?: number;
}

/** Reject missing or ambiguous experiment inputs before calculating metrics. */
export function inspectStepInput(
  times: ArrayLike<number>,
  actual: ArrayLike<number>,
  target: ArrayLike<number> | number | undefined,
  options: StepAnalysisOptions = {}
): StepInputQuality {
  if (times.length !== actual.length) {
    return { valid: false, reason: '时间戳与实际响应样本数量不一致' };
  }
  const n = times.length;
  if (n < 10) return { valid: false, reason: '有效样本不足 10 个' };
  if (options.bandPercent !== undefined && (!Number.isFinite(options.bandPercent) || options.bandPercent <= 0 || options.bandPercent >= 0.5)) {
    return { valid: false, reason: '误差带比例必须大于 0 且小于 50%' };
  }
  if (options.minSustainSeconds !== undefined && (!Number.isFinite(options.minSustainSeconds) || options.minSustainSeconds < 0)) {
    return { valid: false, reason: '稳定维持时间必须是非负有限数值' };
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(times[i])) return { valid: false, reason: `时间戳 ${i + 1} 不是有限数值` };
    if (!Number.isFinite(actual[i])) return { valid: false, reason: `实际响应样本 ${i + 1} 缺失或无效` };
    if (i > 0 && times[i] <= times[i - 1]) return { valid: false, reason: '时间戳必须严格递增，不能重复或逆序' };
  }
  if (target === undefined) return { valid: false, reason: '未提供设定值或目标响应' };

  const targetSeries = typeof target === 'object' && target !== null && 'length' in target
    ? target as ArrayLike<number>
    : null;
  if (targetSeries && targetSeries.length !== n) {
    return { valid: false, reason: '目标值与实际响应样本数量不一致；请按时间对齐' };
  }
  if (typeof target === 'number' && !Number.isFinite(target)) {
    return { valid: false, reason: '目标值不是有限数值' };
  }
  if (targetSeries) {
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(targetSeries[i])) return { valid: false, reason: `目标值样本 ${i + 1} 缺失或无效` };
    }
  }

  if (options.stepTime !== undefined && options.stepIdx !== undefined) {
    return { valid: false, reason: '阶跃时刻与阶跃索引只能指定一种' };
  }
  if (options.stepIdx !== undefined) {
    if (!Number.isInteger(options.stepIdx) || options.stepIdx < 0 || options.stepIdx >= n) {
      return { valid: false, reason: '阶跃索引超出有效样本范围' };
    }
    return { valid: true, stepIndex: options.stepIdx };
  }
  if (options.stepTime !== undefined) {
    if (!Number.isFinite(options.stepTime) || options.stepTime < times[0] || options.stepTime > times[n - 1]) {
      return { valid: false, reason: '设定的阶跃时刻不在当前数据区间内' };
    }
    for (let i = 0; i < n; i++) {
      if (times[i] >= options.stepTime) return { valid: true, stepIndex: i };
    }
    return { valid: false, reason: '设定的阶跃时刻没有对应样本' };
  }
  if (!targetSeries) {
    return { valid: false, reason: '标量目标值需要同时指定阶跃时刻或索引' };
  }

  const threshold = Number.isFinite(options.stepTimeThreshold) && (options.stepTimeThreshold ?? 0) > 0
    ? options.stepTimeThreshold!
    : 1e-4;
  const baseline = targetSeries[0];
  for (let i = 1; i < n; i++) {
    if (Math.abs(targetSeries[i] - baseline) > threshold) return { valid: true, stepIndex: i };
  }
  return { valid: false, reason: '目标通道在当前区间没有可识别的阶跃；请指定阶跃时刻或索引' };
}

/**
 * 线性插值寻找穿越指定阈值的精准时间点
 */
function findCrossingTime(
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  threshold: number,
  ascending: boolean
): number | null {
  const len = Math.min(times.length, values.length);
  for (let i = 0; i < len - 1; i++) {
    const v1 = values[i];
    const v2 = values[i + 1];
    const t1 = times[i];
    const t2 = times[i + 1];

    if (ascending) {
      if (v1 <= threshold && v2 >= threshold) {
        if (Math.abs(v2 - v1) < 1e-9) return t1;
        const frac = (threshold - v1) / (v2 - v1);
        return t1 + frac * (t2 - t1);
      }
    } else {
      if (v1 >= threshold && v2 <= threshold) {
        if (Math.abs(v2 - v1) < 1e-9) return t1;
        const frac = (v1 - threshold) / (v1 - v2);
        return t1 + frac * (t2 - t1);
      }
    }
  }
  return null;
}

/**
 * 估算欠阻尼震荡曲线的振荡频率 (通过基于稳态基准线的滞环穿越周期检测)
 * 兼容正阶跃与负阶跃，同时强力抑制高频传感器噪声
 */
function estimateOscillationFreq(
  times: ArrayLike<number>,
  values: ArrayLike<number>,
  stepIdx: number,
  yTarget: number,
  ySs: number,
  stepAmplitude: number
): number | null {
  const n = values.length;
  if (n - stepIdx < 10) return null;

  // 滞环阈值设为阶跃幅值的 2% (至少 1e-4)
  const hysteresis = Math.max(1e-4, 0.02 * stepAmplitude);

  // 状态机: +1 处于上门限上方, -1 处于下门限下方, 0 初始
  let state = 0;
  const cycleTimes: number[] = [];

  for (let i = stepIdx; i < n; i++) {
    const diff = values[i] - ySs;
    if (state <= 0 && diff > hysteresis) {
      state = 1;
      cycleTimes.push(times[i]);
    } else if (state >= 0 && diff < -hysteresis) {
      state = -1;
    }
  }

  if (cycleTimes.length >= 2) {
    let totalT = 0;
    for (let i = 1; i < cycleTimes.length; i++) {
      totalT += cycleTimes[i] - cycleTimes[i - 1];
    }
    const avgT = totalT / (cycleTimes.length - 1);
    if (avgT > 1e-6) {
      return Number((1 / avgT).toFixed(3));
    }
  }

  // 备用策略：检测显著局部极值点
  const peaks: number[] = [];
  const isPositive = yTarget >= ySs;

  for (let i = stepIdx + 1; i < n - 1; i++) {
    const prev = values[i - 1];
    const curr = values[i];
    const next = values[i + 1];

    if (isPositive) {
      if (curr > prev && curr > next && curr > ySs + hysteresis) {
        peaks.push(times[i]);
      }
    } else {
      if (curr < prev && curr < next && curr < ySs - hysteresis) {
        peaks.push(times[i]);
      }
    }
  }

  if (peaks.length >= 2) {
    let totalT = 0;
    for (let i = 1; i < peaks.length; i++) {
      totalT += peaks[i] - peaks[i - 1];
    }
    const avgPeriod = totalT / (peaks.length - 1);
    if (avgPeriod > 1e-6) {
      return Number((1 / avgPeriod).toFixed(3));
    }
  }

  return null;
}

/**
 * 核心纯函数：对时序切片提取四大控制指标及物理特征
 *
 * @param times 相对或绝对时间戳数组 (秒)
 * @param actual 被控量/反馈实际响应值序列
 * @param target 设定值/目标值 (可为数组或标量数字；必须能确定真实阶跃)
 * @param options 误差带与持续时间等分析配置
 */
export function extract_step_features(
  times: ArrayLike<number>,
  actual: ArrayLike<number>,
  target?: ArrayLike<number> | number,
  options: StepAnalysisOptions = {}
): StepResponseMetrics | null {
  const quality = inspectStepInput(times, actual, target, options);
  if (!quality.valid || quality.stepIndex === undefined) return null;
  const n = times.length;

  const bandPct = options.bandPercent ?? 0.02; // 默认 ±2% 误差带
  const minSustainS = options.minSustainSeconds ?? 0.2; // 默认维持 200ms

  // 1. 定位阶跃时刻 step_idx
  const stepIdx = quality.stepIndex;

  // 2. 基线 y0
  let y0 = 0;
  if (stepIdx > 0) {
    let sum = 0;
    for (let i = 0; i < stepIdx; i++) {
      sum += actual[i];
    }
    y0 = sum / stepIdx;
  } else {
    y0 = actual[0];
  }

  // 3. 稳态终值 y_ss：取阶跃后最后 10% 点的均值 (至少 2 点)
  const postLen = n - stepIdx;
  if (postLen < 5) {
    return null;
  }

  const tailCount = Math.max(2, Math.min(postLen, Math.ceil(postLen * 0.1)));
  let tailSum = 0;
  for (let i = n - tailCount; i < n; i++) {
    tailSum += actual[i];
  }
  const y_ss = tailSum / tailCount;

  // 4. 目标值 y_target
  let y_target: number;
  if (typeof target === 'number') {
    y_target = target;
  } else if (typeof target === 'object' && target !== null && 'length' in target) {
    y_target = target[n - 1];
  } else {
    return null;
  }

  const deltaTarget = y_target - y0;
  const stepAmplitude = Math.abs(deltaTarget);

  if (stepAmplitude < 1e-6) {
    // 无有效阶跃变化量
    return null;
  }

  // 5. 稳态误差 e_ss
  const steady_state_error = Math.abs(y_target - y_ss);

  // 6. 极值 y_max 与超调量 Mp (%)
  const isPositiveStep = deltaTarget > 0;
  let y_max = actual[stepIdx];

  for (let i = stepIdx; i < n; i++) {
    const v = actual[i];
    if (isPositiveStep) {
      if (v > y_max) y_max = v;
    } else {
      if (v < y_max) y_max = v;
    }
  }

  let overshoot_pct = 0;
  // Overshoot is measured beyond the declared target, not beyond the tail mean.
  // Using the tail mean here makes an unsettled monotonic response look as if it
  // overshot simply because its final samples are still below the command.
  const denom = stepAmplitude;

  if (denom > 1e-6) {
    if (isPositiveStep && y_max > y_target) {
      const rawPct = ((y_max - y_target) / denom) * 100;
      overshoot_pct = rawPct < 0.2 ? 0.0 : rawPct;
    } else if (!isPositiveStep && y_max < y_target) {
      const rawPct = ((y_target - y_max) / denom) * 100;
      overshoot_pct = rawPct < 0.2 ? 0.0 : rawPct;
    }
  }

  // 7. 阻尼比估计 ζ (超调量 >= 100% 对应临界发散边界 ζ = 0.0)
  let damping_ratio: number | null = null;
  if (overshoot_pct >= 100) {
    damping_ratio = 0.0;
  } else if (overshoot_pct > 0.01) {
    const lnMp = Math.log(overshoot_pct / 100);
    damping_ratio = Number((-lnMp / Math.sqrt(Math.PI * Math.PI + lnMp * lnMp)).toFixed(3));
  } else {
    damping_ratio = 1.0; // 临界阻尼或过阻尼
  }

  // 8. 上升时间 tr: 10% -> 90%
  const y_10 = y0 + 0.1 * deltaTarget;
  const y_90 = y0 + 0.9 * deltaTarget;

  const t_start = times[stepIdx];
  const postTimes: number[] = [];
  const postValues: number[] = [];
  for (let i = stepIdx; i < n; i++) {
    postTimes.push(times[i]);
    postValues.push(actual[i]);
  }

  const t_10 = findCrossingTime(postTimes, postValues, y_10, isPositiveStep);
  const t_90 = findCrossingTime(postTimes, postValues, y_90, isPositiveStep);

  let rise_time_s: number | null = null;
  if (t_10 !== null && t_90 !== null && t_90 >= t_10) {
    rise_time_s = Number((t_90 - t_10).toFixed(4));
  }

  // 9. 调节时间 ts: 进入目标 ±band 误差带并持续稳定
  const band = bandPct * stepAmplitude;
  let settling_time_s: number | null = null;
  let is_stable = false;

  for (let i = 0; i < postTimes.length; i++) {
    const tCand = postTimes[i];
    const val = postValues[i];

    if (Math.abs(val - y_target) <= band) {
      // 检查后续持续时间内是否越界
      const endLimit = tCand + minSustainS;
      let sustained = true;
      let reachedEnd = false;

      for (let j = i; j < postTimes.length; j++) {
        if (Math.abs(postValues[j] - y_target) > band) {
          sustained = false;
          break;
        }
        if (postTimes[j] >= endLimit) {
          reachedEnd = true;
        }
      }

      // 严密防御：必须真正维持到达 endLimit，或剩余观察时长达到 minSustainS 并维持到末尾
      const durationToEnd = postTimes[postTimes.length - 1] - tCand;
      if (sustained && (reachedEnd || durationToEnd >= minSustainS)) {
        settling_time_s = Number((tCand - t_start).toFixed(4));
        is_stable = true;
        break;
      }
    }
  }

  // 10. 震荡频率估算
  const oscillation_freq_hz = estimateOscillationFreq(times, actual, stepIdx, y_target, y_ss, stepAmplitude);

  return {
    rise_time_s,
    settling_time_s,
    overshoot_pct: Number(overshoot_pct.toFixed(2)),
    steady_state_error: Number(steady_state_error.toFixed(4)),
    oscillation_freq_hz,
    damping_ratio,
    y0: Number(y0.toFixed(4)),
    y_target: Number(y_target.toFixed(4)),
    y_ss: Number(y_ss.toFixed(4)),
    y_max: Number(y_max.toFixed(4)),
    step_amplitude: Number(stepAmplitude.toFixed(4)),
    is_stable,
  };
}

/**
 * 从 ChannelStore 中按通道与时间窗口直接提取阶跃特征
 */
export function extract_step_features_from_store(
  store: ChannelStore,
  actualChannel: string,
  targetChannel: string | number,
  fromT?: number,
  toT?: number,
  options?: StepAnalysisOptions
): StepResponseMetrics | null {
  const actualSnap = store.snapshot(actualChannel, fromT, toT);
  if (actualSnap.count < 10) return null;

  if (typeof targetChannel === 'number') {
    return extract_step_features(
      actualSnap.timestamps,
      actualSnap.values,
      targetChannel,
      options
    );
  }

  const targetSnap = store.snapshot(targetChannel, fromT, toT);
  if (targetSnap.count < 1) return null;

  const effectiveOptions = { ...options };
  if (effectiveOptions.stepTime === undefined && effectiveOptions.stepIdx === undefined) {
    if (targetSnap.count !== targetSnap.timestamps.length || targetSnap.count !== targetSnap.values.length) return null;
    const baseline = targetSnap.values[0];
    let targetStepIndex = -1;
    const threshold = Number.isFinite(effectiveOptions.stepTimeThreshold) && (effectiveOptions.stepTimeThreshold ?? 0) > 0
      ? effectiveOptions.stepTimeThreshold!
      : 1e-4;
    for (let index = 1; index < targetSnap.count; index++) {
      if (!Number.isFinite(targetSnap.timestamps[index])
        || targetSnap.timestamps[index] <= targetSnap.timestamps[index - 1]
        || !Number.isFinite(targetSnap.values[index])) return null;
      if (targetStepIndex < 0 && Math.abs(targetSnap.values[index] - baseline) > threshold) {
        targetStepIndex = index;
      }
    }
    if (targetStepIndex < 0) return null;
    effectiveOptions.stepTime = targetSnap.timestamps[targetStepIndex];
  }

  // A target trace can use a different reporting cadence from the response.
  // Detect its change in its own time base, then align the analysis by event time
  // and use the final target value instead of pairing samples by array index.
  return extract_step_features(
    actualSnap.timestamps,
    actualSnap.values,
    targetSnap.values[targetSnap.count - 1],
    effectiveOptions
  );
}
