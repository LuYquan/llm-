import type {
  FirmwareAnomaly,
  AnomalyType,
  AnomalyLevel,
  OscillationCheckConfig,
} from './types';

interface RegexRule {
  type: AnomalyType;
  level: AnomalyLevel;
  pattern: RegExp;
  extractMessage: (match: RegExpMatchArray, line: string) => string;
}

const FIRMWARE_RULES: RegexRule[] = [
  {
    type: 'hardfault',
    level: 'critical',
    pattern: /(?:HardFault(?:_Handler)?|MemManage(?:_Handler)?|BusFault(?:_Handler)?|UsageFault(?:_Handler)?|\bhard\s*fault\b)/i,
    extractMessage: (m, line) => `硬件级硬错误中断 (${m[0]}): ${line.trim()}`,
  },
  {
    type: 'assert',
    level: 'critical',
    pattern: /(?:assert(?:ion)?\s*(?:failed|error)?|\bASSERT\b|\bassert_param\b)/i,
    extractMessage: (m, line) => `固件断言触发 (${m[0]}): ${line.trim()}`,
  },
  {
    type: 'watchdog',
    level: 'critical',
    pattern: /(?:watchdog(?:\s*timeout|\s*reset)?|\b(?:IWDG|WWDG)\b|\bWDT\s*(?:timeout|reset)\b)/i,
    extractMessage: (m, line) => `看门狗复位警告 (${m[0]}): ${line.trim()}`,
  },
  {
    type: 'overtemp',
    level: 'critical',
    pattern: /(?:over[\s_-]?temp(?:erature)?|overheat(?:ed)?|过温|温度超限|TEMP_LIMIT)/i,
    extractMessage: (m, line) => `系统过温保护 (${m[0]}): ${line.trim()}`,
  },
  {
    type: 'overcurrent',
    level: 'critical',
    pattern: /(?:over[\s_-]?current|过流|CURRENT_LIMIT)/i,
    extractMessage: (m, line) => `电机/功率级过流保护 (${m[0]}): ${line.trim()}`,
  },
  {
    type: 'undervoltage',
    level: 'critical',
    pattern: /(?:under[\s_-]?voltage|欠压|VOLTAGE_LOW)/i,
    extractMessage: (m, line) => `母线欠压警告 (${m[0]}): ${line.trim()}`,
  },
  {
    type: 'param_limit',
    level: 'warning',
    pattern: /(?:param(?:eter)?[\s_-]?(?:limit|exceed(?:ed)?|overflow|out[\s_-]?of[\s_-]?range)|参数超限|超限报警|LIMIT_EXCEEDED)/i,
    extractMessage: (m, line) => `参数边界超限告警 (${m[0]}): ${line.trim()}`,
  },
  {
    type: 'error',
    level: 'warning',
    pattern: /(?:\[(?:ERROR|FAULT)\]|\bERR:|\bfatal\b)/i,
    extractMessage: (_m, line) => `系统运行错误: ${line.trim()}`,
  },
];

let anomalyIdSeq = 0;
function nextAnomalyId(): string {
  return `anom_${Date.now()}_${++anomalyIdSeq}`;
}

export class LogAnalyzer {
  private recentAnomalies: FirmwareAnomaly[] = [];
  private maxRetainedAnomalies = 50;
  private lastAnomalyKeyTime = new Map<string, number>();
  private deduplicateWindowMs = 800;

  /**
   * 纯文本单行日志分析
   */
  public analyzeLogLine(text: string, timestamp = Date.now()): FirmwareAnomaly | null {
    if (!text || typeof text !== 'string') return null;

    // 清洗去除行首时间戳如 [12:34:56.789] 或 12:34:56 或帧头序号
    const cleanedText = text.replace(/^\[?\d{1,4}[:\-.]\d{1,4}[:\-.]\d{1,4}(?:[.:]\d+)?\]?\s*/, '').trim();

    for (const rule of FIRMWARE_RULES) {
      const match = cleanedText.match(rule.pattern) || text.match(rule.pattern);
      if (match) {
        // 去重 key 使用 规则类型 + 核心错误特征文本 (去除动态数字)
        const normalizedMsg = cleanedText.slice(0, 48).toLowerCase();
        const dedupKey = `${rule.type}:${normalizedMsg}`;
        const lastTime = this.lastAnomalyKeyTime.get(dedupKey) || 0;
        if (timestamp - lastTime < this.deduplicateWindowMs) {
          return null; // 去重防刷屏
        }
        this.lastAnomalyKeyTime.set(dedupKey, timestamp);

        const anomaly: FirmwareAnomaly = {
          id: nextAnomalyId(),
          timestamp,
          type: rule.type,
          level: rule.level,
          message: rule.extractMessage(match, text),
          rawLine: text,
        };

        this.recordAnomaly(anomaly);
        return anomaly;
      }
    }

    return null;
  }

  /**
   * 批量分析多行文本日志
   */
  public analyzeBatch(
    logs: Array<{ text: string; time?: string; timestamp?: number }>
  ): FirmwareAnomaly[] {
    const list: FirmwareAnomaly[] = [];
    const now = Date.now();
    for (const item of logs) {
      const res = this.analyzeLogLine(item.text, item.timestamp || now);
      if (res) list.push(res);
    }
    return list;
  }

  /**
   * 信号持续发散 / 高频震荡智能检测
   */
  public detectOscillationOrDivergence(
    channelName: string,
    timestamps: number[] | Float64Array,
    values: number[] | Float64Array,
    config: OscillationCheckConfig = {}
  ): FirmwareAnomaly | null {
    const len = values.length;
    if (len < 10) return null;

    const windowSize = Math.min(len, config.windowSize ?? 40);
    const reversalThreshold = config.reversalThreshold ?? 5;
    const amplitudeThreshold = config.amplitudeThreshold ?? 1.0;
    const divergenceStreak = config.divergenceStreak ?? 12;

    const startIdx = len - windowSize;
    let minVal = Infinity;
    let maxVal = -Infinity;
    let sum = 0;
    let validCount = 0;

    for (let i = startIdx; i < len; i++) {
      const v = values[i];
      if (Number.isFinite(v)) {
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
        sum += v;
        validCount++;
      }
    }

    if (validCount < 10) return null;
    const mean = sum / validCount;
    const p2p = maxVal - minVal;

    const wallNow = Date.now();
    const eventTime = timestamps.length > 0 ? timestamps[timestamps.length - 1] : wallNow;

    // 辅助防抖去重函数 (窗口 1200ms)
    const shouldRecordChannelAnomaly = (anomalyType: string): boolean => {
      const dedupKey = `${anomalyType}:${channelName}`;
      if (this.lastAnomalyKeyTime.has(dedupKey)) {
        const lastTime = this.lastAnomalyKeyTime.get(dedupKey)!;
        if (wallNow - lastTime < Math.max(1000, this.deduplicateWindowMs)) {
          return false;
        }
      }
      this.lastAnomalyKeyTime.set(dedupKey, wallNow);
      return true;
    };

    // 1. 持续发散检测 (单调指数递增/递减 或 越界数值爆炸)
    if (config.divergenceThreshold !== undefined && (Math.abs(maxVal) > config.divergenceThreshold || Math.abs(minVal) > config.divergenceThreshold)) {
      if (!shouldRecordChannelAnomaly('divergence')) {
        return null;
      }
      const anomaly: FirmwareAnomaly = {
        id: nextAnomalyId(),
        timestamp: eventTime,
        type: 'divergence',
        level: 'critical',
        message: `通道 [${channelName}] 数据幅值严重发散 (极值: ${Math.max(Math.abs(maxVal), Math.abs(minVal)).toFixed(2)} > 限幅 ${config.divergenceThreshold})`,
        channel: channelName,
        details: { minVal, maxVal, mean, p2p },
      };
      this.recordAnomaly(anomaly);
      return anomaly;
    }

    // 检查尾部连续递增/递减漂移 (发散趋势)
    let monotonicCount = 1;
    let lastDiffSign = 0;
    let isMonotonicDiverging = true;

    for (let i = len - divergenceStreak; i < len - 1; i++) {
      if (i < 0) continue;
      const diff = values[i + 1] - values[i];
      if (Math.abs(diff) < 1e-6) continue;
      const sign = Math.sign(diff);
      if (lastDiffSign === 0) {
        lastDiffSign = sign;
      } else if (sign !== lastDiffSign) {
        isMonotonicDiverging = false;
        break;
      }
      monotonicCount++;
    }

    if (isMonotonicDiverging && monotonicCount >= divergenceStreak && p2p > amplitudeThreshold * 3) {
      if (!shouldRecordChannelAnomaly('divergence')) {
        return null;
      }
      const anomaly: FirmwareAnomaly = {
        id: nextAnomalyId(),
        timestamp: eventTime,
        type: 'divergence',
        level: 'critical',
        message: `通道 [${channelName}] 呈现持续单向发散趋势 (连续 ${monotonicCount} 拍单调漂移，幅值变化 ${p2p.toFixed(2)})`,
        channel: channelName,
        details: { minVal, maxVal, monotonicCount, p2p },
      };
      this.recordAnomaly(anomaly);
      return anomaly;
    }

    // 2. 高频持续震荡检测 (极限环/欠阻尼发散震荡)
    // 统计穿越均值 (Zero-Crossings around Mean)
    let meanCrossings = 0;
    let lastSign = 0;

    for (let i = startIdx; i < len; i++) {
      const diff = values[i] - mean;
      if (Math.abs(diff) > 1e-9) {
        const curSign = Math.sign(diff);
        if (lastSign !== 0 && curSign !== lastSign) {
          meanCrossings++;
        }
        lastSign = curSign;
      }
    }

    if (meanCrossings >= reversalThreshold && p2p >= amplitudeThreshold) {
      if (!shouldRecordChannelAnomaly('oscillation')) {
        return null;
      }
      const anomaly: FirmwareAnomaly = {
        id: nextAnomalyId(),
        timestamp: eventTime,
        type: 'oscillation',
        level: 'warning',
        message: `通道 [${channelName}] 检测到高频持续震荡 (穿均值 ${meanCrossings} 次，峰峰值 ${p2p.toFixed(2)})`,
        channel: channelName,
        details: { meanCrossings, p2p, minVal, maxVal, mean },
      };
      this.recordAnomaly(anomaly);
      return anomaly;
    }

    return null;
  }

  /**
   * 记录并维护最近异常环形队列
   */
  private recordAnomaly(anomaly: FirmwareAnomaly) {
    this.recentAnomalies.unshift(anomaly);
    if (this.recentAnomalies.length > this.maxRetainedAnomalies) {
      this.recentAnomalies.pop();
    }
  }

  /**
   * 获取最近捕获的异常列表
   */
  public getRecentAnomalies(limit = 10): FirmwareAnomaly[] {
    return this.recentAnomalies.slice(0, limit);
  }

  /**
   * 获取最近异常总数
   */
  public getAnomalyCount(): number {
    return this.recentAnomalies.length;
  }

  /**
   * 清空异常队列
   */
  public clearAnomalies() {
    this.recentAnomalies = [];
    this.lastAnomalyKeyTime.clear();
  }
}

export const globalLogAnalyzer = new LogAnalyzer();
