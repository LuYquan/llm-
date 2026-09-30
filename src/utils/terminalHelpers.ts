/**
 * terminalHelpers.ts - 底部单行终端条与极简交互纯函数与辅助类
 */

/**
 * 格式化字节流量为人类可读格式 (B / KB / MB)
 */
export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0 || isNaN(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 构建串口下发报文载荷并按需填充换行符
 * 规则：HEX 模式下绝对不自动追加换行；文本模式下按选单补齐对应 CRLF/LF/CR
 */
export function buildPayload(
  rawText: string,
  isHex: boolean,
  newlineType: 'crlf' | 'lf' | 'cr' | 'none'
): string {
  let payload = rawText;
  if (!isHex) {
    if (newlineType === 'crlf') {
      if (!payload.endsWith('\r\n')) payload += '\r\n';
    } else if (newlineType === 'lf') {
      if (!payload.endsWith('\n')) payload += '\n';
    } else if (newlineType === 'cr') {
      if (!payload.endsWith('\r')) payload += '\r';
    }
  }
  return payload;
}

/**
 * 计算波形时基分度值 (基于物理步进 Δt，按每格 50 点换算)
 */
export function calcTimeDiv(deltaTMs: number): string {
  const safeDelta = isNaN(deltaTMs) || deltaTMs <= 0 ? 1.0 : deltaTMs;
  return `${(safeDelta * 50).toFixed(1)} ms/div`;
}

/**
 * 判断 Scrubber 回溯进度条是否处于活跃回溯状态
 */
export function isScrubbingActive(posPercent: number): boolean {
  return posPercent < 99.5;
}

/**
 * 命令历史管理器 (支持最近 50 条记忆、连续去重、草稿状态暂存与 ↑/↓ 穿梭恢复)
 */
export class CommandHistoryManager {
  private history: string[] = [];
  private index = -1;
  private draft = '';
  private readonly maxHistory: number;

  constructor(maxHistory = 50) {
    this.maxHistory = maxHistory;
  }

  /**
   * 记录已发送指令并复位穿梭游标与草稿
   */
  public push(cmd: string): void {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    if (this.history.length === 0 || this.history[this.history.length - 1] !== cmd) {
      this.history.push(cmd);
      if (this.history.length > this.maxHistory) {
        this.history.shift();
      }
    }
    this.index = -1;
    this.draft = '';
  }

  /**
   * 键盘 ↑ 键：召回前一条历史指令，并在首次离开输入态时保存用户草稿
   */
  public arrowUp(currentInput: string): string {
    if (this.history.length === 0) return currentInput;
    if (this.index === -1) {
      this.draft = currentInput;
      this.index = this.history.length - 1;
    } else if (this.index > 0) {
      this.index--;
    }
    return this.history[this.index] || '';
  }

  /**
   * 键盘 ↓ 键：移向较新的指令，若越过最新一条则完整恢复用户先前的草稿内容
   */
  public arrowDown(): string {
    if (this.history.length === 0 || this.index === -1) {
      return this.draft;
    }
    if (this.index < this.history.length - 1) {
      this.index++;
      return this.history[this.index] || '';
    } else {
      this.index = -1;
      return this.draft;
    }
  }

  /**
   * 重置游标与草稿暂存 (例如清空输入框时)
   */
  public resetNavigation(): void {
    this.index = -1;
    this.draft = '';
  }

  /**
   * 获取当前所有历史记录镜像
   */
  public getHistory(): string[] {
    return [...this.history];
  }

  /**
   * 获取当前穿梭游标
   */
  public getCurrentIndex(): number {
    return this.index;
  }
}
