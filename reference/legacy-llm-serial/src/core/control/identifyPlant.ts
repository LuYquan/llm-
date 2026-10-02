/**
 * 系统辨识引擎 (identify_plant / identifyPlant)
 * 纯数学与确定性优化算法，无外部依赖
 * 支持 FOPDT、SOPDT、积分+惯性三族模型拟合
 * 严格提供 R^2 拟合优度与置信度门禁
 */

import type {
  IdentifiablePlantModel,
  FopdtModel,
  SopdtModel,
  IntegralLagModel,
  IdentifyPlantOptions,
  IdentifyPlantResult,
  ControllerParams,
} from './types';

// ==========================================
// 1. 模型时域阶跃响应解析与数值生成
// ==========================================

/**
 * 计算 FOPDT 模型在各时间点的开环阶跃响应值
 */
export function evalFopdtStep(
  times: ArrayLike<number>,
  k: number,
  tConst: number,
  tau: number,
  t0: number,
  y0: number,
  deltaU: number
): number[] {
  const n = times.length;
  const res = new Array<number>(n);
  const safeT = Math.max(1e-5, tConst);
  const safeTau = Math.max(0, tau);

  for (let i = 0; i < n; i++) {
    const t = times[i];
    const dt = t - t0 - safeTau;
    if (dt <= 0) {
      res[i] = y0;
    } else {
      res[i] = y0 + k * deltaU * (1 - Math.exp(-dt / safeT));
    }
  }
  return res;
}

/**
 * 计算 SOPDT 模型在各时间点的开环阶跃响应值
 */
export function evalSopdtStep(
  times: ArrayLike<number>,
  k: number,
  wn: number,
  zeta: number,
  tau: number,
  t0: number,
  y0: number,
  deltaU: number
): number[] {
  const n = times.length;
  const res = new Array<number>(n);
  const safeWn = Math.max(1e-5, wn);
  const safeTau = Math.max(0, tau);
  const safeZeta = Math.max(1e-4, zeta);

  for (let i = 0; i < n; i++) {
    const t = times[i];
    const dt = t - t0 - safeTau;
    if (dt <= 0) {
      res[i] = y0;
      continue;
    }

    if (safeZeta < 0.999) {
      // 欠阻尼 (Underdamped)
      const wd = safeWn * Math.sqrt(1 - safeZeta * safeZeta);
      const decay = Math.exp(-safeZeta * safeWn * dt);
      const angle = wd * dt;
      const term = Math.cos(angle) + (safeZeta / Math.sqrt(1 - safeZeta * safeZeta)) * Math.sin(angle);
      res[i] = y0 + k * deltaU * (1 - decay * term);
    } else if (safeZeta <= 1.001) {
      // 临界阻尼 (Critically damped)
      const decay = Math.exp(-safeWn * dt);
      res[i] = y0 + k * deltaU * (1 - decay * (1 + safeWn * dt));
    } else {
      // 过阻尼 (Overdamped)
      const sq = Math.sqrt(safeZeta * safeZeta - 1);
      const s1 = -safeWn * (safeZeta - sq);
      const s2 = -safeWn * (safeZeta + sq);
      const t1 = -1 / s1;
      const t2 = -1 / s2;
      const diff = t1 - t2;
      if (Math.abs(diff) < 1e-9) {
        res[i] = y0 + k * deltaU * (1 - Math.exp(-dt / t1));
      } else {
        const term = (t1 * Math.exp(-dt / t1) - t2 * Math.exp(-dt / t2)) / diff;
        res[i] = y0 + k * deltaU * (1 - term);
      }
    }
  }
  return res;
}

/**
 * 计算 积分+惯性 模型在各时间点的开环阶跃响应值
 */
export function evalIntegralLagStep(
  times: ArrayLike<number>,
  k: number,
  tConst: number,
  tau: number,
  t0: number,
  y0: number,
  deltaU: number
): number[] {
  const n = times.length;
  const res = new Array<number>(n);
  const safeT = Math.max(1e-5, tConst);
  const safeTau = Math.max(0, tau);

  for (let i = 0; i < n; i++) {
    const t = times[i];
    const dt = t - t0 - safeTau;
    if (dt <= 0) {
      res[i] = y0;
    } else {
      res[i] = y0 + k * deltaU * (dt - safeT * (1 - Math.exp(-dt / safeT)));
    }
  }
  return res;
}

// ==========================================
// 2. 闭环仿真反演生成器 (用于闭环模式)
// ==========================================

function evalClosedLoopStep(
  times: ArrayLike<number>,
  plant: IdentifiablePlantModel,
  ctrl: ControllerParams,
  t0: number,
  y0: number,
  stepValue: number
): number[] {
  const n = times.length;
  const res = new Array<number>(n);
  if (n === 0) return res;

  const dt = n > 1 ? (times[n - 1] - times[0]) / (n - 1) : 0.01;
  const ts = ctrl.sampleTime || dt;
  const kp = ctrl.kp;
  const ki = ctrl.ki || 0;
  const kd = ctrl.kd || 0;

  // 状态变量初始化
  let x1 = y0;
  let x2 = 0;
  let integral = 0;
  let prevErr = 0;
  let uCurrent = 0;

  // 延迟环形队列
  const delaySteps = Math.max(0, Math.round(plant.tau / dt));
  const delayBuffer: number[] = new Array(delaySteps + 1).fill(0);
  let delayIdx = 0;

  let lastCtrlTime = times[0];

  for (let i = 0; i < n; i++) {
    const t = times[i];
    const r = t >= t0 ? stepValue : y0;

    // 控制器以 Ts 为周期更新 (离散采样)
    if (i === 0 || t - lastCtrlTime >= ts - 1e-6) {
      const err = r - x1;
      integral += ki * ts * err;
      const deriv = (err - prevErr) / ts;
      uCurrent = kp * err + integral + kd * deriv;
      prevErr = err;
      lastCtrlTime = t;
    }

    // 存入延时队列并取出延时后的控制量
    delayBuffer[delayIdx] = uCurrent;
    const uDelayed = delayBuffer[(delayIdx + 1) % delayBuffer.length];
    delayIdx = (delayIdx + 1) % delayBuffer.length;

    // 物理对象状态积分 (欧拉/亚步积分)
    const subSteps = 4;
    const h = dt / subSteps;
    for (let sub = 0; sub < subSteps; sub++) {
      if (plant.family === 'fopdt') {
        const safeT = Math.max(1e-4, plant.t);
        const dx = (- (x1 - y0) + plant.k * uDelayed) / safeT;
        x1 += dx * h;
      } else if (plant.family === 'sopdt') {
        const safeWn = Math.max(1e-4, plant.wn);
        const dx1 = x2;
        const dx2 = -2 * plant.zeta * safeWn * x2 - safeWn * safeWn * (x1 - y0) + plant.k * safeWn * safeWn * uDelayed;
        x1 += dx1 * h;
        x2 += dx2 * h;
      } else if (plant.family === 'integral_lag') {
        const safeT = Math.max(1e-4, plant.t);
        const dx1 = x2;
        const dx2 = (-x2 + plant.k * uDelayed) / safeT;
        x1 += dx1 * h;
        x2 += dx2 * h;
      }
    }

    res[i] = x1;
  }

  return res;
}

// ==========================================
// 3. 通用非线性优化器: Nelder-Mead Simplex
// ==========================================

function nelderMead(
  costFunc: (p: number[]) => number,
  initParams: number[],
  maxIter = 120,
  tol = 1e-5,
  shouldCancel?: () => boolean,
): number[] {
  const dim = initParams.length;
  const numVertices = dim + 1;
  const simplex: number[][] = [];
  const costs: number[] = [];

  // 1. 初始化单纯形
  const evaluate = (params: number[]) => {
    if (shouldCancel?.()) throw new Error('ANALYSIS_CANCELLED');
    return costFunc(params);
  };

  simplex.push([...initParams]);
  costs.push(evaluate(initParams));

  for (let i = 0; i < dim; i++) {
    const vertex = [...initParams];
    const step = Math.abs(vertex[i]) > 1e-4 ? vertex[i] * 0.15 : 0.05;
    vertex[i] += step;
    simplex.push(vertex);
    costs.push(evaluate(vertex));
  }

  // 2. 迭代搜索
  const alpha = 1.0;
  const gamma = 2.0;
  const rho = 0.5;
  const sigma = 0.5;

  for (let iter = 0; iter < maxIter; iter++) {
    if (shouldCancel?.()) throw new Error('ANALYSIS_CANCELLED');
    // 排序顶点
    const indices = Array.from({ length: numVertices }, (_, i) => i);
    indices.sort((a, b) => costs[a] - costs[b]);

    const bestIdx = indices[0];
    const worstIdx = indices[numVertices - 1];
    const secondWorstIdx = indices[numVertices - 2];

    const bestCost = costs[bestIdx];
    const worstCost = costs[worstIdx];

    if (Math.abs(worstCost - bestCost) < tol) {
      break;
    }

    // 计算除最差点之外的形心
    const centroid = new Array(dim).fill(0);
    for (let i = 0; i < numVertices - 1; i++) {
      const idx = indices[i];
      for (let d = 0; d < dim; d++) {
        centroid[d] += simplex[idx][d];
      }
    }
    for (let d = 0; d < dim; d++) {
      centroid[d] /= numVertices - 1;
    }

    // 反射 (Reflection)
    const reflected = new Array(dim);
    for (let d = 0; d < dim; d++) {
      reflected[d] = centroid[d] + alpha * (centroid[d] - simplex[worstIdx][d]);
    }
    const reflectedCost = evaluate(reflected);

    if (reflectedCost < costs[secondWorstIdx] && reflectedCost >= bestCost) {
      simplex[worstIdx] = reflected;
      costs[worstIdx] = reflectedCost;
      continue;
    }

    // 扩张 (Expansion)
    if (reflectedCost < bestCost) {
      const expanded = new Array(dim);
      for (let d = 0; d < dim; d++) {
        expanded[d] = centroid[d] + gamma * (reflected[d] - centroid[d]);
      }
      const expandedCost = evaluate(expanded);
      if (expandedCost < reflectedCost) {
        simplex[worstIdx] = expanded;
        costs[worstIdx] = expandedCost;
      } else {
        simplex[worstIdx] = reflected;
        costs[worstIdx] = reflectedCost;
      }
      continue;
    }

    // 收缩 (Contraction)
    const contractFrom = reflectedCost < worstCost ? reflected : simplex[worstIdx];
    const contracted = new Array(dim);
    for (let d = 0; d < dim; d++) {
      contracted[d] = centroid[d] + rho * (contractFrom[d] - centroid[d]);
    }
    const contractedCost = evaluate(contracted);

    if (contractedCost < Math.min(reflectedCost, worstCost)) {
      simplex[worstIdx] = contracted;
      costs[worstIdx] = contractedCost;
      continue;
    }

    // 全局压缩 (Shrink)
    for (let i = 1; i < numVertices; i++) {
      const idx = indices[i];
      for (let d = 0; d < dim; d++) {
        simplex[idx][d] = simplex[bestIdx][d] + sigma * (simplex[idx][d] - simplex[bestIdx][d]);
      }
      costs[idx] = evaluate(simplex[idx]);
    }
  }

  // 返回最优顶点
  let bestI = 0;
  let minC = costs[0];
  for (let i = 1; i < numVertices; i++) {
    if (costs[i] < minC) {
      minC = costs[i];
      bestI = i;
    }
  }
  return simplex[bestI];
}

// ==========================================
// 4. 辅助统计计算
// ==========================================

function computeR2(yMeasured: ArrayLike<number>, yFitted: ArrayLike<number>): number {
  const n = yMeasured.length;
  if (n <= 1) return 0;

  let sumY = 0;
  for (let i = 0; i < n; i++) sumY += yMeasured[i];
  const meanY = sumY / n;

  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const diff = yMeasured[i] - meanY;
    ssTot += diff * diff;
    const res = yMeasured[i] - yFitted[i];
    ssRes += res * res;
  }

  if (ssTot < 1e-9) return 0;
  const r2 = 1 - ssRes / ssTot;
  return Number.isFinite(r2) ? Math.max(0, Math.min(1, r2)) : 0;
}

// ==========================================
// 5. 核心开环拟合实现
// ==========================================

function fitFopdtOpenLoop(
  times: number[],
  values: number[],
  t0: number,
  y0: number,
  deltaU: number,
  shouldCancel?: () => boolean,
): { model: FopdtModel; fitted: number[]; r2: number } {
  const n = values.length;
  const yEnd = values[n - 1];
  const deltaY = yEnd - y0;
  const k0 = Math.abs(deltaU) > 1e-6 ? deltaY / deltaU : 1.0;

  // 找 28.3% 和 63.2% 点 (采用线性插值并取阶跃后首次穿越点)
  const target28 = y0 + 0.283 * deltaY;
  const target63 = y0 + 0.632 * deltaY;

  let t28 = t0;
  let t63 = times[n - 1];
  let found28 = false;
  let found63 = false;

  for (let i = 0; i < n - 1; i++) {
    if (times[i] < t0) continue;
    if (!found28 && ((values[i] <= target28 && values[i + 1] >= target28) ||
                    (values[i] >= target28 && values[i + 1] <= target28))) {
      const frac = Math.abs(values[i + 1] - values[i]) > 1e-9
        ? (target28 - values[i]) / (values[i + 1] - values[i])
        : 0;
      t28 = times[i] + frac * (times[i + 1] - times[i]);
      found28 = true;
    }
    if (!found63 && ((values[i] <= target63 && values[i + 1] >= target63) ||
                    (values[i] >= target63 && values[i + 1] <= target63))) {
      const frac = Math.abs(values[i + 1] - values[i]) > 1e-9
        ? (target63 - values[i]) / (values[i + 1] - values[i])
        : 0;
      t63 = times[i] + frac * (times[i + 1] - times[i]);
      found63 = true;
    }
  }

  let tEst = Math.max(1e-3, 1.5 * Math.max(1e-4, t63 - t28));
  let tauEst = Math.max(0, t63 - tEst - t0);

  const cost = (p: number[]) => {
    const [k, t, tau] = p;
    if (t <= 1e-4 || tau < 0) return 1e9;
    const yFit = evalFopdtStep(times, k, t, tau, t0, y0, deltaU);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const e = values[i] - yFit[i];
      s += e * e;
    }
    return s;
  };

  const optimized = nelderMead(cost, [k0, tEst, tauEst], 120, 1e-5, shouldCancel);
  const [bestK, bestT, bestTau] = optimized;
  const fitted = evalFopdtStep(times, bestK, Math.max(1e-4, bestT), Math.max(0, bestTau), t0, y0, deltaU);
  const r2 = computeR2(values, fitted);

  return {
    model: {
      family: 'fopdt',
      k: Number(bestK.toFixed(5)),
      t: Number(Math.max(1e-4, bestT).toFixed(5)),
      tau: Number(Math.max(0, bestTau).toFixed(5)),
    },
    fitted,
    r2,
  };
}

function fitSopdtOpenLoop(
  times: number[],
  values: number[],
  t0: number,
  y0: number,
  deltaU: number,
  shouldCancel?: () => boolean,
): { model: SopdtModel; fitted: number[]; r2: number } {
  const n = values.length;
  const yEnd = values[n - 1];
  const deltaY = yEnd - y0;
  const k0 = Math.abs(deltaU) > 1e-6 ? deltaY / deltaU : 1.0;

  // 寻找极值峰值
  let maxV = y0;
  let peakTime = t0;
  let isPeakFound = false;

  for (let i = 1; i < n - 1; i++) {
    if (times[i] < t0) continue;
    if (deltaY > 0 && values[i] > maxV) {
      maxV = values[i];
      peakTime = times[i];
      if (values[i] > values[i - 1] && values[i] > values[i + 1]) {
        isPeakFound = true;
      }
    } else if (deltaY < 0 && values[i] < maxV) {
      maxV = values[i];
      peakTime = times[i];
      if (values[i] < values[i - 1] && values[i] < values[i + 1]) {
        isPeakFound = true;
      }
    }
  }

  let zeta0 = 1.0;
  let wn0 = 5.0;
  const tau0 = 0;

  if (isPeakFound && Math.abs(deltaY) > 1e-5) {
    const overshoot = Math.abs(maxV - yEnd) / Math.abs(deltaY);
    if (overshoot > 0.02 && overshoot < 1.0) {
      const lnMp = Math.log(overshoot);
      zeta0 = Math.max(0.05, Math.min(0.95, -lnMp / Math.sqrt(Math.PI * Math.PI + lnMp * lnMp)));
      const periodHalf = Math.max(1e-3, peakTime - t0);
      const wd = Math.PI / periodHalf;
      wn0 = Math.max(0.1, wd / Math.sqrt(1 - zeta0 * zeta0));
    }
  } else {
    // 单调过阻尼/临界阻尼估算
    const span = Math.max(1e-3, times[n - 1] - t0);
    wn0 = Math.max(0.1, 4.0 / span);
    zeta0 = 1.2;
  }

  const cost = (p: number[]) => {
    const [k, wn, zeta, tau] = p;
    if (wn <= 1e-4 || zeta <= 1e-4 || tau < 0) return 1e9;
    const yFit = evalSopdtStep(times, k, wn, zeta, tau, t0, y0, deltaU);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const e = values[i] - yFit[i];
      s += e * e;
    }
    return s;
  };

  const optimized = nelderMead(cost, [k0, wn0, zeta0, tau0], 120, 1e-5, shouldCancel);
  const [bestK, bestWn, bestZeta, bestTau] = optimized;
  const fitted = evalSopdtStep(times, bestK, Math.max(1e-4, bestWn), Math.max(1e-4, bestZeta), Math.max(0, bestTau), t0, y0, deltaU);
  const r2 = computeR2(values, fitted);

  return {
    model: {
      family: 'sopdt',
      k: Number(bestK.toFixed(5)),
      wn: Number(Math.max(1e-4, bestWn).toFixed(5)),
      zeta: Number(Math.max(1e-4, bestZeta).toFixed(5)),
      tau: Number(Math.max(0, bestTau).toFixed(5)),
    },
    fitted,
    r2,
  };
}

function fitIntegralLagOpenLoop(
  times: number[],
  values: number[],
  t0: number,
  y0: number,
  deltaU: number,
  shouldCancel?: () => boolean,
): { model: IntegralLagModel; fitted: number[]; r2: number } {
  const n = values.length;
  // 估算末尾斜率
  const p1 = Math.floor(n * 0.75);
  const p2 = n - 1;
  const dt = Math.max(1e-4, times[p2] - times[p1]);
  const dy = values[p2] - values[p1];
  const slope = dy / dt;
  const k0 = Math.abs(deltaU) > 1e-6 ? slope / deltaU : slope;

  // 估算惯性滞后
  const tEst = Math.max(1e-3, (times[p2] - t0) * 0.2);
  const tau0 = 0;

  const cost = (p: number[]) => {
    const [k, t, tau] = p;
    if (t <= 1e-4 || tau < 0) return 1e9;
    const yFit = evalIntegralLagStep(times, k, t, tau, t0, y0, deltaU);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const e = values[i] - yFit[i];
      s += e * e;
    }
    return s;
  };

  const optimized = nelderMead(cost, [k0, tEst, tau0], 120, 1e-5, shouldCancel);
  const [bestK, bestT, bestTau] = optimized;
  const fitted = evalIntegralLagStep(times, bestK, Math.max(1e-4, bestT), Math.max(0, bestTau), t0, y0, deltaU);
  const r2 = computeR2(values, fitted);

  return {
    model: {
      family: 'integral_lag',
      k: Number(bestK.toFixed(5)),
      t: Number(Math.max(1e-4, bestT).toFixed(5)),
      tau: Number(Math.max(0, bestTau).toFixed(5)),
    },
    fitted,
    r2,
  };
}

// ==========================================
// 6. 核心闭环反推辨识实现
// ==========================================

function fitClosedLoop(
  times: number[],
  values: number[],
  t0: number,
  y0: number,
  deltaU: number,
  ctrl: ControllerParams,
  family: 'fopdt' | 'sopdt' | 'integral_lag',
  shouldCancel?: () => boolean,
): { model: IdentifiablePlantModel; fitted: number[]; r2: number } {
  const n = values.length;
  const yEnd = values[n - 1];
  const deltaY = yEnd - y0;
  // 严格依据设定值阶跃幅值 deltaU 计算闭环激励阶跃值，杜绝忽略纯 P 稳态误差
  const stepVal = y0 + (Math.abs(deltaU) > 1e-6 ? deltaU : (Math.abs(deltaY) > 1e-6 ? deltaY : 1.0));

  // 基于控制器参数与响应特征推导初值
  let kInit = 1.0;
  if ((ctrl.ki || 0) === 0 && ctrl.kp > 0 && Math.abs(deltaU) > 1e-5) {
    const clGain = Math.max(0.01, Math.min(0.95, deltaY / deltaU));
    kInit = Math.max(0.1, clGain / (ctrl.kp * (1 - clGain)));
  } else if (Math.abs(deltaU) > 1e-5) {
    kInit = Math.max(0.1, Math.abs(deltaY / deltaU));
  }
  const tSpan = Math.max(0.01, times[n - 1] - t0);
  const tInit = Math.max(0.01, tSpan * 0.25);
  const tauInit = Math.max(0, times[1] ? times[1] - times[0] : 0.01);

  if (family === 'sopdt') {
    // 闭环反推二阶
    const cost = (p: number[]) => {
      const [k, wn, zeta, tau] = p;
      if (k <= 0 || wn <= 1e-4 || zeta <= 1e-4 || tau < 0) return 1e9;
      const plant: SopdtModel = { family: 'sopdt', k, wn, zeta, tau };
      const sim = evalClosedLoopStep(times, plant, ctrl, t0, y0, stepVal);
      let s = 0;
      for (let i = 0; i < n; i++) {
        const e = values[i] - sim[i];
        s += e * e;
      }
      return s;
    };

    const opt = nelderMead(cost, [kInit, Math.max(0.5, 4.0 / tSpan), 0.7, tauInit], 150, 1e-5, shouldCancel);
    const plant: SopdtModel = {
      family: 'sopdt',
      k: Number(opt[0].toFixed(5)),
      wn: Number(Math.max(1e-4, opt[1]).toFixed(5)),
      zeta: Number(Math.max(1e-4, opt[2]).toFixed(5)),
      tau: Number(Math.max(0, opt[3]).toFixed(5)),
    };
    const fitted = evalClosedLoopStep(times, plant, ctrl, t0, y0, stepVal);
    const r2 = computeR2(values, fitted);
    return { model: plant, fitted, r2 };
  } else if (family === 'integral_lag') {
    const cost = (p: number[]) => {
      const [k, t, tau] = p;
      if (k <= 0 || t <= 1e-4 || tau < 0) return 1e9;
      const plant: IntegralLagModel = { family: 'integral_lag', k, t, tau };
      const sim = evalClosedLoopStep(times, plant, ctrl, t0, y0, stepVal);
      let s = 0;
      for (let i = 0; i < n; i++) {
        const e = values[i] - sim[i];
        s += e * e;
      }
      return s;
    };

    const opt = nelderMead(cost, [kInit, tInit, tauInit], 150, 1e-5, shouldCancel);
    const plant: IntegralLagModel = {
      family: 'integral_lag',
      k: Number(opt[0].toFixed(5)),
      t: Number(Math.max(1e-4, opt[1]).toFixed(5)),
      tau: Number(Math.max(0, opt[2]).toFixed(5)),
    };
    const fitted = evalClosedLoopStep(times, plant, ctrl, t0, y0, stepVal);
    const r2 = computeR2(values, fitted);
    return { model: plant, fitted, r2 };
  } else {
    // 默认 FOPDT
    const cost = (p: number[]) => {
      const [k, t, tau] = p;
      if (k <= 0 || t <= 1e-4 || tau < 0) return 1e9;
      const plant: FopdtModel = { family: 'fopdt', k, t, tau };
      const sim = evalClosedLoopStep(times, plant, ctrl, t0, y0, stepVal);
      let s = 0;
      for (let i = 0; i < n; i++) {
        const e = values[i] - sim[i];
        s += e * e;
      }
      return s;
    };

    const opt = nelderMead(cost, [kInit, tInit, tauInit], 150, 1e-5, shouldCancel);
    const plant: FopdtModel = {
      family: 'fopdt',
      k: Number(opt[0].toFixed(5)),
      t: Number(Math.max(1e-4, opt[1]).toFixed(5)),
      tau: Number(Math.max(0, opt[2]).toFixed(5)),
    };
    const fitted = evalClosedLoopStep(times, plant, ctrl, t0, y0, stepVal);
    const r2 = computeR2(values, fitted);
    return { model: plant, fitted, r2 };
  }
}

// ==========================================
// 7. 门面调度入口函数: identify_plant / identifyPlant
// ==========================================

export function identifyPlant(
  times: number[],
  values: number[],
  options: IdentifyPlantOptions
): IdentifyPlantResult {
  const n = times.length;
  const reject = (message: string): IdentifyPlantResult => ({
    model: { family: 'fopdt', k: 0, t: 1, tau: 0 },
    r_squared: 0,
    confidence: 'low',
    usable: false,
    message,
  });

  if (times.length !== values.length) {
    return reject(`时间和值数量不一致 (${times.length} / ${values.length})，已拒绝辨识`);
  }
  if (n < 10) {
    return reject(`采样数据点数过少 (当前 ${n} 点 < 10 点)，无法进行统计辨识`);
  }

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(times[i]) || !Number.isFinite(values[i])) {
      return reject(`第 ${i + 1} 个采样点含非有限时间或数值，已拒绝辨识`);
    }
    if (i > 0 && times[i] <= times[i - 1]) {
      return reject(`采样时间在第 ${i + 1} 个点不严格递增，已拒绝辨识`);
    }
  }

  if (options.mode !== 'open_loop' && options.mode !== 'closed_loop') {
    return reject('必须明确选择开环或闭环实验方式，已拒绝辨识');
  }
  if (!Number.isFinite(options.stepTime) || options.stepTime < times[0] || options.stepTime > times[n - 1]) {
    return reject('必须提供位于采样区间内的有效阶跃时刻，已拒绝辨识');
  }
  if (!Number.isFinite(options.stepAmplitude) || Math.abs(options.stepAmplitude) < 1e-6) {
    return reject('必须提供非零且有限的实测阶跃输入幅值，已拒绝辨识');
  }
  if (options.mode === 'closed_loop') {
    const controller = options.controller;
    if (!controller) return reject('闭环辨识缺少本次实验使用的 PID 参数，已拒绝辨识');
    if (!Number.isFinite(controller.kp)
      || (controller.ki !== undefined && !Number.isFinite(controller.ki))
      || (controller.kd !== undefined && !Number.isFinite(controller.kd))
      || (controller.sampleTime !== undefined && (!Number.isFinite(controller.sampleTime) || controller.sampleTime <= 0))) {
      return reject('闭环辨识的 PID 参数或采样周期无效，已拒绝辨识');
    }
    if (!Number.isFinite(options.sampleTime ?? controller.sampleTime)
      || (options.sampleTime ?? controller.sampleTime ?? 0) <= 0) {
      return reject('闭环辨识必须提供本次实验使用的控制器采样周期，已拒绝辨识');
    }
    const intervals = times.slice(1).map((time, index) => time - times[index]);
    const sortedIntervals = [...intervals].sort((a, b) => a - b);
    const medianInterval = sortedIntervals[Math.floor(sortedIntervals.length / 2)];
    if (intervals.some((interval) => Math.abs(interval - medianInterval) > medianInterval * 0.05)) {
      return reject('闭环辨识时间间隔偏差超过 5%，当前拟合模型不适用于该采样时序');
    }
  }

  // 1. 确定阶跃发生基准点 t0 与 y0
  const t0 = options.stepTime;
  let y0 = values[0];

  // 仅在阶跃前有足够前置基线点时计算均值，若阶跃始于起点则直接取 values[0]
  let sumBase = 0;
  let countBase = 0;
  for (let i = 0; i < n; i++) {
    if (times[i] < t0) {
      sumBase += values[i];
      countBase++;
    } else {
      break;
    }
  }
  if (countBase >= 3) {
    y0 = sumBase / countBase;
  } else {
    y0 = values[0];
  }

  // 2. 检查有效激励幅度
  let yMin = values[0];
  let yMax = values[0];
  for (let i = 1; i < n; i++) {
    if (values[i] < yMin) yMin = values[i];
    if (values[i] > yMax) yMax = values[i];
  }
  const amp = yMax - yMin;
  const deltaU = options.stepAmplitude;

  if (amp < 1e-4 || Math.abs(deltaU) < 1e-6) {
    return reject('阶跃响应幅值过低或无有效激励信号 (Δy < 1e-4)，禁止输出定量参数，建议加大阶跃设定值重测');
  }

  const mode = options.mode;
  const familyChoice = options.family || 'auto';

  let bestResult: { model: IdentifiablePlantModel; fitted: number[]; r2: number };

  if (mode === 'closed_loop') {
    const controller = {
      ...options.controller!,
      sampleTime: options.controller!.sampleTime ?? options.sampleTime,
    };
    if (familyChoice === 'auto') {
      const resFopdt = fitClosedLoop(times, values, t0, y0, deltaU, controller, 'fopdt', options.shouldCancel);
      const resSopdt = fitClosedLoop(times, values, t0, y0, deltaU, controller, 'sopdt', options.shouldCancel);
      bestResult = resSopdt.r2 > resFopdt.r2 + 0.03 ? resSopdt : resFopdt;
    } else {
      bestResult = fitClosedLoop(times, values, t0, y0, deltaU, controller, familyChoice, options.shouldCancel);
    }
  } else {
    // 开环模式
    if (familyChoice === 'fopdt') {
      bestResult = fitFopdtOpenLoop(times, values, t0, y0, deltaU, options.shouldCancel);
    } else if (familyChoice === 'sopdt') {
      bestResult = fitSopdtOpenLoop(times, values, t0, y0, deltaU, options.shouldCancel);
    } else if (familyChoice === 'integral_lag') {
      bestResult = fitIntegralLagOpenLoop(times, values, t0, y0, deltaU, options.shouldCancel);
    } else {
      // 自动择优: 分别拟合 FOPDT、SOPDT 与 积分+惯性 三族模型
      const resFopdt = fitFopdtOpenLoop(times, values, t0, y0, deltaU, options.shouldCancel);
      const resSopdt = fitSopdtOpenLoop(times, values, t0, y0, deltaU, options.shouldCancel);
      const resInt = fitIntegralLagOpenLoop(times, values, t0, y0, deltaU, options.shouldCancel);

      // 特征判据: 计算末端斜率与全段平均斜率比值 (判断是否具备自衡能力)
      const pTail = Math.floor(n * 0.8);
      const dtTail = Math.max(1e-4, times[n - 1] - times[pTail]);
      const dyTail = Math.abs(values[n - 1] - values[pTail]);
      const tailSlope = dyTail / dtTail;
      const totalDt = Math.max(1e-4, times[n - 1] - t0);
      const avgSlope = Math.abs(values[n - 1] - y0) / totalDt;
      const isIntegratingTrend = avgSlope > 1e-4 && (tailSlope / avgSlope > 0.45);

      let best: { model: IdentifiablePlantModel; fitted: number[]; r2: number } = resFopdt;
      if (isIntegratingTrend && resInt.r2 >= 0.90) {
        best = resInt;
      } else {
        if (resSopdt.r2 > best.r2 + 0.02) {
          best = resSopdt;
        }
        if (resInt.r2 > best.r2 + 0.05) {
          best = resInt;
        }
      }
      bestResult = best;
    }
  }

  // 3. 严格置信度与可用性门禁: 若 R^2 < 0.90 禁止输出定量参数
  const r2 = bestResult.r2;
  const usable = r2 >= 0.90;
  const confidence: 'high' | 'medium' | 'low' = r2 >= 0.95 ? 'high' : r2 >= 0.90 ? 'medium' : 'low';

  let message = '';
  if (!usable) {
    message = `拟合优度 R² = ${r2.toFixed(3)} (< 0.90 门槛)，信噪比过低或系统非线性/饱和严重。已触发安全防线拦截：禁止输出定量参数，建议在平稳工况下加大阶跃幅值重新测量，或使用经验降级规则。`;
  } else {
    message = `辨识成功 (模型: ${bestResult.model.family.toUpperCase()}, R² = ${r2.toFixed(3)}, 置信度: ${confidence})。可直接用于频域波特图与闭式 PID 解析。`;
  }

  const safeModel: IdentifiablePlantModel = usable
    ? bestResult.model
    : ({ family: bestResult.model.family, k: 0, t: 1, tau: 0 } as IdentifiablePlantModel);

  return {
    model: safeModel,
    r_squared: Number(r2.toFixed(4)),
    confidence,
    usable,
    message,
    fit_curve: {
      times,
      y_fitted: bestResult.fitted,
    },
  };
}

/** 别名导出符合蛇形工具命名 */
export const identify_plant = identifyPlant;
