/**
 * FFT (Fast Fourier Transform) 频谱分析计算引擎
 * 用于 VOFA+ 级波形图表实时频谱/频域特征透视
 */

import type { AnalysisProvenance } from './provenance';

export interface FftResult {
  frequencies: number[]; // 频率数组 (Hz), 长度 N / 2
  amplitudes: number[];   // 归一化单边幅值数组, 长度 N / 2
  peakFreq: number;      // 主频峰值频率 (Hz)
  peakAmp: number;       // 主频幅值
  sampleRate: number;    // 估计采样率 (Hz)
  provenance?: AnalysisProvenance;
}

export interface FftInputQuality {
  valid: boolean;
  reason?: string;
  pointCount: number;
  sampleRateHz?: number;
  maxIntervalDeviationPct?: number;
}

/** Validate the exact trailing power-of-two window that the FFT engine will use. */
export function inspectFftInput(
  timestamps: ArrayLike<number>,
  values: ArrayLike<number>,
  maxPoints = 1024,
  maxIntervalDeviationPct = 2
): FftInputQuality {
  if (timestamps.length !== values.length) {
    return { valid: false, reason: '时间戳与样本数量不一致', pointCount: Math.min(timestamps.length, values.length) };
  }
  const len = Math.min(timestamps.length, values.length);
  let n = 16;
  while (n * 2 <= len && n * 2 <= maxPoints) n *= 2;
  if (n < 16 || !Number.isFinite(maxPoints) || maxPoints < 16) {
    return { valid: false, reason: '数据点数不足，FFT 至少需要 16 个有效样本', pointCount: len };
  }

  const offset = len - n;
  for (let i = offset; i < len; i++) {
    if (!Number.isFinite(timestamps[i])) {
      return { valid: false, reason: `时间戳 ${i + 1} 不是有限数值`, pointCount: n };
    }
    if (!Number.isFinite(values[i])) {
      return { valid: false, reason: `样本 ${i + 1} 缺失或不是有限数值`, pointCount: n };
    }
  }

  const first = timestamps[offset];
  const last = timestamps[len - 1];
  const averageInterval = (last - first) / (n - 1);
  if (!(averageInterval > 0) || !Number.isFinite(averageInterval)) {
    return { valid: false, reason: '时间戳跨度为零或无效', pointCount: n };
  }

  let maxDeviation = 0;
  for (let i = offset + 1; i < len; i++) {
    const interval = timestamps[i] - timestamps[i - 1];
    if (!(interval > 0)) {
      return { valid: false, reason: '时间戳重复或逆序，无法确认采样顺序', pointCount: n };
    }
    maxDeviation = Math.max(maxDeviation, Math.abs(interval - averageInterval) / averageInterval * 100);
  }
  if (maxDeviation > maxIntervalDeviationPct) {
    return {
      valid: false,
      reason: `采样间隔最大偏差 ${maxDeviation.toFixed(2)}%，超过 ${maxIntervalDeviationPct}% 均匀采样门限`,
      pointCount: n,
      sampleRateHz: 1 / averageInterval,
      maxIntervalDeviationPct: maxDeviation,
    };
  }
  return {
    valid: true,
    pointCount: n,
    sampleRateHz: 1 / averageInterval,
    maxIntervalDeviationPct: maxDeviation,
  };
}

/**
 * 原地 Cooley-Tukey 基-2 快速傅里叶变换
 * @param re 实部数组 (长度必须为 2^M)
 * @param im 虚部数组 (长度必须为 2^M)
 */
export function transformRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) {
    throw new Error('FFT length must be a power of 2');
  }

  // 1. 位反转置换 (Bit-reversal permutation)
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      const tempRe = re[i];
      re[i] = re[j];
      re[j] = tempRe;

      const tempIm = im[i];
      im[i] = im[j];
      im[j] = tempIm;
    }
    let k = n >> 1;
    while (k <= j) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }

  // 2. 蝶形运算 (Cooley-Tukey Butterfly computation)
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wStepRe = Math.cos(angle);
    const wStepIm = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < halfLen; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + halfLen] * wRe - im[i + k + halfLen] * wIm;
        const vIm = re[i + k + halfLen] * wIm + im[i + k + halfLen] * wRe;

        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + halfLen] = uRe - vRe;
        im[i + k + halfLen] = uIm - vIm;

        const nextWRe = wRe * wStepRe - wIm * wStepIm;
        const nextWIm = wRe * wStepIm + wIm * wStepRe;
        wRe = nextWRe;
        wIm = nextWIm;
      }
    }
  }
}

/**
 * 对输入的实数时域序列计算单边幅值谱 (支持 Hanning 加窗与去直流)
 * @param timestamps 时间戳数组 (秒)
 * @param values 采样幅值数组
 * @param maxPoints 最大 FFT 采样点数 (必须是 2 的幂，默认 1024)
 */
export function computeFftSpectrum(
  timestamps: ArrayLike<number>,
  values: ArrayLike<number>,
  maxPoints: number = 1024
): FftResult | null {
  const len = Math.min(timestamps.length, values.length);
  const quality = inspectFftInput(timestamps, values, maxPoints);
  if (!quality.valid) return null;

  // 计算最大不超过 len 且不超过 maxPoints 的 2 的幂
  let n = 16;
  while (n * 2 <= len && n * 2 <= maxPoints) {
    n *= 2;
  }

  // 计算平均采样率
  const tStart = timestamps[len - n];
  const tEnd = timestamps[len - 1];
  const dtTotal = tEnd - tStart;
  if (dtTotal <= 0) return null;

  const dtAvg = dtTotal / (n - 1);
  const sampleRate = 1 / dtAvg;

  // 截取最新 n 个采样点
  const offset = len - n;
  let mean = 0;
  for (let i = 0; i < n; i++) {
    mean += values[offset + i];
  }
  mean /= n;

  const re = new Float64Array(n);
  const im = new Float64Array(n);

  // 应用 Hanning 窗消除频谱泄露，并去除直流偏移
  for (let i = 0; i < n; i++) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    re[i] = (values[offset + i] - mean) * hann;
    im[i] = 0;
  }

  // 执行基-2 FFT
  transformRadix2(re, im);

  const halfN = n / 2;
  const frequencies: number[] = new Array(halfN);
  const amplitudes: number[] = new Array(halfN);

  let peakFreq = 0;
  let peakAmp = -Infinity;

  // 计算单边幅值谱 (Hanning 窗幅值校正系数为 2)
  const normFactor = 4 / n;
  for (let k = 0; k < halfN; k++) {
    const f = (k * sampleRate) / n;
    const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * normFactor;
    frequencies[k] = parseFloat(f.toFixed(2));
    amplitudes[k] = parseFloat(mag.toFixed(4));

    // 忽略前几个极低频直流残留
    if (k > 1 && mag > peakAmp) {
      peakAmp = mag;
      peakFreq = f;
    }
  }

  if (peakAmp === -Infinity) {
    peakAmp = 0;
    peakFreq = 0;
  }

  return {
    frequencies,
    amplitudes,
    peakFreq: parseFloat(peakFreq.toFixed(2)),
    peakAmp: parseFloat(peakAmp.toFixed(4)),
    sampleRate: parseFloat(sampleRate.toFixed(1)),
  };
}
