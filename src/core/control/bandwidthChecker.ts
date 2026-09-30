/**
 * 带宽分层检查器 (BandwidthChecker)
 * 严格执行工业界控制法则：相邻两环的截止频率/剪切频率 ωc 必须保持 ≥ 3 ~ 5 倍差距
 * 及时预警带宽过于接近或倒置引起的高危闭环振荡，并给出定量调参建议
 */

export interface LoopBandwidthInfo {
  id: string;
  name?: string;
  order: number;
  /** 剪切角频率 ωc (rad/s) */
  omega_c: number;
  /** 采样时间 Ts (秒，可选，用于采样频率上限校验) */
  sampleTime?: number;
}

export type BandwidthRiskLevel = 'safe' | 'medium' | 'high' | 'critical';

export interface PairBandwidthResult {
  innerId: string;
  innerName: string;
  outerId: string;
  outerName: string;
  innerOmegaC: number;
  outerOmegaC: number;
  /** 频率隔离比 R = ωc_inner / ωc_outer */
  ratio: number;
  passed: boolean;
  risk_level: BandwidthRiskLevel;
  message: string;
  advice: string;
  suggestedOuterOmegaC: number;
}

export interface BandwidthHierarchyReport {
  passed: boolean;
  overall_risk: BandwidthRiskLevel;
  pairs: PairBandwidthResult[];
  nyquist_warnings: string[];
  summary: string;
}

export class BandwidthChecker {
  /** 推荐最低频率隔离比 (最低容忍阈值) */
  public static readonly MIN_ISOLATION_RATIO = 3.0;

  /** 推荐优选频率隔离比 (优良动态解耦阈值) */
  public static readonly OPTIMAL_ISOLATION_RATIO = 5.0;

  /**
   * 检查一对相邻环路 (内环与外环) 的带宽隔离度
   */
  public static checkPair(
    inner: LoopBandwidthInfo,
    outer: LoopBandwidthInfo
  ): PairBandwidthResult {
    const innerName = inner.name || inner.id;
    const outerName = outer.name || outer.id;
    const wIn = inner.omega_c;
    const wOut = outer.omega_c;

    // 默认建议外环剪切频率 = 内环的 1/5
    const suggestedOuter = Number((wIn / this.OPTIMAL_ISOLATION_RATIO).toFixed(2));

    // 异常与未输入频率防护
    if (wIn <= 0 || wOut <= 0 || !Number.isFinite(wIn) || !Number.isFinite(wOut)) {
      return {
        innerId: inner.id,
        innerName,
        outerId: outer.id,
        outerName,
        innerOmegaC: wIn,
        outerOmegaC: wOut,
        ratio: 0,
        passed: false,
        risk_level: 'critical',
        message: `【非法带宽参数】环路 '${innerName}' (ωc=${wIn}) 或 '${outerName}' (ωc=${wOut}) 剪切频率必须为正有效数`,
        advice: '请通过系统辨识或频域解算获取真实剪切频率后再执行分层校验。',
        suggestedOuterOmegaC: 0,
      };
    }

    const ratio = Number((wIn / wOut).toFixed(2));

    // 1. 致命缺陷：带宽倒置 (外环比内环还快)
    if (ratio <= 1.0) {
      return {
        innerId: inner.id,
        innerName,
        outerId: outer.id,
        outerName,
        innerOmegaC: wIn,
        outerOmegaC: wOut,
        ratio,
        passed: false,
        risk_level: 'critical',
        message: `【极度危险：串级带宽倒置】外环 '${outerName}' 剪切频率 (${wOut.toFixed(1)} rad/s) 大于或等于内环 '${innerName}' (${wIn.toFixed(1)} rad/s)，隔离比仅为 ${ratio}x！`,
        advice: `外环动态响应快于内环将导致内环严重饱和与剧烈发散自激震荡！必须立即将外环剪切频率调降至 ≤ ${suggestedOuter} rad/s，或大幅提高内环带宽。`,
        suggestedOuterOmegaC: suggestedOuter,
      };
    }

    // 2. 高危警告：带宽过于接近 (1.0 < ratio < 3.0)
    if (ratio < this.MIN_ISOLATION_RATIO) {
      const safeMax = Number((wIn / this.MIN_ISOLATION_RATIO).toFixed(2));
      return {
        innerId: inner.id,
        innerName,
        outerId: outer.id,
        outerName,
        innerOmegaC: wIn,
        outerOmegaC: wOut,
        ratio,
        passed: false,
        risk_level: 'high',
        message: `【高危预警：带宽严重重叠】内环 '${innerName}' 与外环 '${outerName}' 剪切频率隔离比为 ${ratio}x，低于工业安全底线 3.0x！`,
        advice: `由于内环在 ωc=${wOut.toFixed(1)} rad/s 处存在显著相角滞后，外环将出现强烈谐振超调并恶化相位裕度。建议将外环剪切频率降低至 ≤ ${safeMax} rad/s (推荐 ${suggestedOuter} rad/s)。`,
        suggestedOuterOmegaC: suggestedOuter,
      };
    }

    // 3. 次优提醒：满足最低要求但未达充裕解耦 (3.0 <= ratio < 5.0)
    if (ratio < this.OPTIMAL_ISOLATION_RATIO) {
      return {
        innerId: inner.id,
        innerName,
        outerId: outer.id,
        outerName,
        innerOmegaC: wIn,
        outerOmegaC: wOut,
        ratio,
        passed: true,
        risk_level: 'medium',
        message: `【满足合格线】内环 '${innerName}' 与外环 '${outerName}' 带宽比为 ${ratio}x，满足 ≥ 3.0x 最低解耦准则。`,
        advice: `在存在机械谐振或大负载突变工况下，建议将外环目标进一步调整至内环的 1/5 (${suggestedOuter} rad/s)，以获得更充裕的抗扰鲁棒性。`,
        suggestedOuterOmegaC: suggestedOuter,
      };
    }

    // 4. 优良：充分频域解耦 (ratio >= 5.0)
    return {
      innerId: inner.id,
      innerName,
      outerId: outer.id,
      outerName,
      innerOmegaC: wIn,
      outerOmegaC: wOut,
      ratio,
      passed: true,
      risk_level: 'safe',
      message: `【优良解耦】内环 '${innerName}' (${wIn.toFixed(1)} rad/s) 与外环 '${outerName}' (${wOut.toFixed(1)} rad/s) 隔离比达 ${ratio}x (≥ 5.0x)，频域解耦充分。`,
      advice: '多环动态互不干扰，具备优秀的抗扰度与相角裕度裕量。',
      suggestedOuterOmegaC: wOut,
    };
  }

  /**
   * 检查全系统多环拓扑的完整带宽分层结构
   */
  public static checkHierarchy(loops: LoopBandwidthInfo[]): BandwidthHierarchyReport {
    const sorted = [...loops].sort((a, b) => a.order - b.order);
    const pairs: PairBandwidthResult[] = [];
    const nyquistWarnings: string[] = [];

    // 检查相邻环路
    for (let i = 0; i < sorted.length - 1; i++) {
      const inner = sorted[i];
      const outer = sorted[i + 1];
      const res = this.checkPair(inner, outer);
      pairs.push(res);
    }

    // 采样定理检查 (Shannon-Nyquist limit: ωc <= 0.2π / Ts = π / 5Ts)
    for (const loop of sorted) {
      if (loop.sampleTime && loop.sampleTime > 0) {
        const maxAllowedWc = (0.2 * Math.PI) / loop.sampleTime;
        if (loop.omega_c > maxAllowedWc) {
          const loopName = loop.name || loop.id;
          nyquistWarnings.push(
            `环路 '${loopName}' 剪切频率 (${loop.omega_c.toFixed(1)} rad/s) 超过采样定理安全上限 (${maxAllowedWc.toFixed(1)} rad/s，即 fs/10)，ZOH 离散滞后将损失超 54° 相角！`
          );
        }
      }
    }

    let overallRisk: BandwidthRiskLevel = 'safe';
    let allPassed = true;

    for (const p of pairs) {
      if (!p.passed) allPassed = false;
      if (p.risk_level === 'critical') overallRisk = 'critical';
      else if (p.risk_level === 'high' && overallRisk !== 'critical') overallRisk = 'high';
      else if (p.risk_level === 'medium' && overallRisk === 'safe') overallRisk = 'medium';
    }

    if (nyquistWarnings.length > 0 && overallRisk === 'safe') {
      overallRisk = 'high';
      allPassed = false;
    }

    const summary = allPassed
      ? `所有 ${sorted.length} 个控制环路带宽分层良好 (隔离比均 ≥ 3.0x)，无频率倒置与采样违例风险。`
      : `检测到 ${pairs.filter((p) => !p.passed).length} 处相邻环路带宽违背工业分层准则，存在自激振荡隐患。`;

    return {
      passed: allPassed,
      overall_risk: overallRisk,
      pairs,
      nyquist_warnings: nyquistWarnings,
      summary,
    };
  }

  /**
   * 根据内环带宽推荐外环设计剪切频率
   */
  public static recommendOuterBandwidth(
    innerOmegaC: number,
    factor: number = 5.0
  ): { recommended_omega_c: number; safe_range: [number, number]; explanation: string } {
    const f = Math.max(3.0, factor);
    const rec = Number((innerOmegaC / f).toFixed(2));
    const maxSafe = Number((innerOmegaC / 3.0).toFixed(2));
    const minSafe = Number((innerOmegaC / 10.0).toFixed(2));

    return {
      recommended_omega_c: rec,
      safe_range: [minSafe, maxSafe],
      explanation: `基于内环剪切频率 ${innerOmegaC.toFixed(1)} rad/s，推荐外环剪切频率设定为 ${rec} rad/s (1/${f} 内环带宽)，安全区间为 [${minSafe}, ${maxSafe}] rad/s。`,
    };
  }
}
