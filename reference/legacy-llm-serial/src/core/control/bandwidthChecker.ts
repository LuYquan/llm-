/**
 * Adjacent-loop bandwidth design policy, not a stability or hardware certificate.
 * The ratios 3/5 and fs/10 ceiling are this product's conservative heuristics.
 */
export interface LoopBandwidthInfo {
  id: string;
  name?: string;
  order: number;
  /** User-provided or model-derived open-loop crossover, rad/s. */
  omega_c: number;
  sampleTime?: number;
}

// 'safe' is retained for existing consumers; it means the policy passed only.
export type BandwidthRiskLevel = 'safe' | 'medium' | 'high' | 'critical';

export interface PairBandwidthResult {
  innerId: string; innerName: string; outerId: string; outerName: string;
  innerOmegaC: number; outerOmegaC: number;
  /** Full precision is used for decisions. Null means unavailable. */
  ratio: number | null;
  passed: boolean;
  risk_level: BandwidthRiskLevel;
  message: string;
  advice: string;
  suggestedOuterOmegaC: number | null;
}

export interface BandwidthHierarchyReport {
  passed: boolean;
  overall_risk: BandwidthRiskLevel;
  pairs: PairBandwidthResult[];
  /** Compatibility name: these are design-ceiling warnings, not a Nyquist proof. */
  nyquist_warnings: string[];
  input_errors: string[];
  limitations: string[];
  summary: string;
}

const display = (value: number) => Number.isFinite(value) ? Number(value.toPrecision(6)).toString() : '待提供';
const rank: Record<BandwidthRiskLevel, number> = { safe: 0, medium: 1, high: 2, critical: 3 };

export class BandwidthChecker {
  public static readonly MIN_ISOLATION_RATIO = 3;
  public static readonly OPTIMAL_ISOLATION_RATIO = 5;
  /** wc <= 0.2π/Ts = 2πfs/10. Actual Nyquist frequency is π/Ts. */
  public static readonly SAMPLING_DESIGN_FACTOR = 0.2 * Math.PI;

  public static checkPair(inner: LoopBandwidthInfo, outer: LoopBandwidthInfo): PairBandwidthResult {
    const innerName = inner.name || inner.id;
    const outerName = outer.name || outer.id;
    const wIn = inner.omega_c, wOut = outer.omega_c;
    const valid = Number.isFinite(wIn) && wIn > 0 && Number.isFinite(wOut) && wOut > 0;
    const ratio = valid ? wIn / wOut : NaN;
    const suggestion = valid ? wIn / this.OPTIMAL_ISOLATION_RATIO : NaN;
    const base = { innerId: inner.id, innerName, outerId: outer.id, outerName, innerOmegaC: wIn, outerOmegaC: wOut };
    if (!valid || !Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(suggestion) || suggestion <= 0) {
      return { ...base, ratio: null, passed: false, risk_level: 'critical',
        message: '缺少有效带宽或数值范围无法可靠计算；不能判定分层通过。',
        advice: '提供带单位的有效模型计算或实测剪切频率，不使用环路层级猜测数值。',
        suggestedOuterOmegaC: null };
    }
    if (ratio <= 1) {
      return { ...base, ratio, passed: false, risk_level: 'critical',
        message: '串级带宽倒置：外环 ' + display(wOut) + ' rad/s 不低于内环 ' + display(wIn) + ' rad/s。',
        advice: '核对对象与控制方向，再评估外环目标；经验建议为 ' + display(suggestion) + ' rad/s。比例本身不能证明是否振荡。',
        suggestedOuterOmegaC: suggestion };
    }
    if (ratio < this.MIN_ISOLATION_RATIO) {
      return { ...base, ratio, passed: false, risk_level: 'high',
        message: '带宽比 ' + display(ratio) + 'x，低于配置的带宽分层阈值 3x。',
        advice: '可评估将外环目标降低至 ' + display(wIn / this.MIN_ISOLATION_RATIO) + ' rad/s 以下；仍需联合闭环与采样验证。',
        suggestedOuterOmegaC: suggestion };
    }
    const medium = ratio < this.OPTIMAL_ISOLATION_RATIO;
    return { ...base, ratio, passed: true, risk_level: medium ? 'medium' : 'safe',
      message: '带宽比 ' + display(ratio) + 'x，通过当前' + (medium ? '最低' : '优选') + '经验分层检查。',
      advice: '这项比例检查不证明稳定、解耦或设备安全；还需核对完整模型、采样、延迟、饱和与闭环响应。',
      suggestedOuterOmegaC: medium ? suggestion : wOut };
  }

  public static checkHierarchy(loops: LoopBandwidthInfo[]): BandwidthHierarchyReport {
    const inputErrors: string[] = [];
    const warnings: string[] = [];
    const ids = new Set<string>(), orders = new Set<number>();
    if (!loops.length) inputErrors.push('尚无控制环，不能进行分层检查。');
    for (const loop of loops) {
      const name = loop.name || loop.id || '未命名环';
      if (!loop.id || ids.has(loop.id)) inputErrors.push('环 ' + name + ' 的标识缺失或重复。');
      ids.add(loop.id);
      if (!Number.isInteger(loop.order) || loop.order < 0 || orders.has(loop.order)) inputErrors.push('环 ' + name + ' 的层级必须是唯一非负整数。');
      orders.add(loop.order);
      if (!Number.isFinite(loop.omega_c) || loop.omega_c <= 0) inputErrors.push('环 ' + name + ' 缺少正有限剪切频率。');
      if (!Number.isFinite(loop.sampleTime) || (loop.sampleTime ?? 0) <= 0) {
        inputErrors.push('环 ' + name + ' 缺少正有限采样周期，采样检查尚不能通过。');
      } else if (Number.isFinite(loop.omega_c) && loop.omega_c > 0) {
        const ceiling = this.SAMPLING_DESIGN_FACTOR / loop.sampleTime!;
        if (loop.omega_c > ceiling) warnings.push(
          '环 ' + name + ' 剪切频率 ' + display(loop.omega_c) + ' rad/s 超过本产品采样设计上限 ' + display(ceiling) + ' rad/s（fs/10）；请评估离散化与计算延迟。该经验上限不是奈奎斯特定理的安全保证。'
        );
      }
    }
    const sorted = [...loops].sort((a, b) => a.order - b.order);
    const pairs = sorted.slice(1).map((outer, i) => this.checkPair(sorted[i], outer));
    let overallRisk: BandwidthRiskLevel = inputErrors.length ? 'critical' : 'safe';
    for (const pair of pairs) if (rank[pair.risk_level] > rank[overallRisk]) overallRisk = pair.risk_level;
    if (warnings.length && rank[overallRisk] < rank.high) overallRisk = 'high';
    const passed = !inputErrors.length && !warnings.length && pairs.every(pair => pair.passed);
    return { passed, overall_risk: overallRisk, pairs, nyquist_warnings: warnings, input_errors: inputErrors,
      limitations: ['通过只表示当前输入满足本产品的经验分层和采样设计检查，不证明多环闭环稳定或硬件安全。', '剪切频率和采样周期必须来自用户确认的数据或明确标记的模型计算；本检查不生成设备数值。'],
      summary: passed
        ? sorted.length + ' 个环通过经验分层与采样设计检查；完整闭环和设备效果仍需验证。'
        : '检查未通过：' + inputErrors.length + ' 项输入待补/无效、' + pairs.filter(pair => !pair.passed).length + ' 对分层不满足、' + warnings.length + ' 项采样设计告警。' };
  }

  public static recommendOuterBandwidth(innerOmegaC: number, factor = 5): {
    recommended_omega_c: number;
    /** Legacy field name: an engineering search range, not a stability guarantee. */
    safe_range: [number, number];
    explanation: string;
  } {
    if (!Number.isFinite(innerOmegaC) || innerOmegaC <= 0 || !Number.isFinite(factor) || factor <= 0) throw new Error('内环带宽和分层因子必须是正有限数值。');
    const f = Math.max(this.MIN_ISOLATION_RATIO, factor);
    const rec = innerOmegaC / f, low = innerOmegaC / 10, high = innerOmegaC / this.MIN_ISOLATION_RATIO;
    if (![rec, low, high].every(value => Number.isFinite(value) && value > 0)) throw new Error('带宽数值范围无法可靠计算，请调整单位。');
    return { recommended_omega_c: rec, safe_range: [low, high],
      explanation: '基于内环 ' + display(innerOmegaC) + ' rad/s，可评估外环 ' + display(rec) + ' rad/s 与区间 [' + display(low) + ', ' + display(high) + '] rad/s；这是经验候选区间，不是稳定性或硬件安全证明。' };
  }
}
