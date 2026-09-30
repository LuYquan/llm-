import type { BaseWidgetConfig, SendResult } from '../../types/widget';
import { renderTemplate } from './templateEngine';
import { checkAndSanitizeNumeric } from './safetyGuard';

export type SerialSender = (payload: string, isHex: boolean, appendNewline: boolean) => Promise<void>;
export type LogWriter = (logTitle: string, payload: string, isHex: boolean) => void;

interface PendingTask {
  widgetId: string;
  config: BaseWidgetConfig;
  valStr: string;
  numVal?: number;
  resolve: (res: SendResult) => void;
  reject: (err: any) => void;
}

export class SendGate {
  private minIntervalMs: number = 20;
  private isPortConnected: boolean = false;
  private sender: SerialSender | null = null;
  private logWriter: LogWriter | null = null;

  // 排队队列
  private queue: PendingTask[] = [];
  private isProcessing: boolean = false;
  private lastSentTime: number = 0;
  private experimentLocked = false;

  constructor(minIntervalMs: number = 20) {
    this.minIntervalMs = minIntervalMs;
  }

  public setPortConnected(connected: boolean) {
    this.isPortConnected = connected;
    if (!connected) {
      // 串口断开时清空剩余队列并返回错误
      while (this.queue.length > 0) {
        const task = this.queue.shift();
        if (task) {
          task.resolve({
            ok: false,
            reason: 'port_closed',
            message: '串口未打开，无法下发指令',
          });
        }
      }
    }
  }

  public setSender(sender: SerialSender | null) {
    this.sender = sender;
  }

  public setLogWriter(writer: LogWriter) {
    this.logWriter = writer;
  }

  public getConnected(): boolean {
    return this.isPortConnected;
  }

  public async acquireExperimentLock(): Promise<void> {
    this.experimentLocked = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      task?.resolve({ ok: false, reason: 'disabled', message: '自动调参开始前，待发送的普通控件命令已取消。' });
    }
    while (this.isProcessing) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  public releaseExperimentLock(): void {
    this.experimentLocked = false;
  }

  /**
   * 派发控件指令下发请求（带安全过滤、同源合并与排队节流）
   */
  public async dispatch(
    config: BaseWidgetConfig,
    valStr: string = '',
    numVal?: number
  ): Promise<SendResult> {
    if (this.experimentLocked) {
      return {
        ok: false,
        reason: 'disabled',
        message: '范围内自动调参期间，普通控件发送已暂停。',
      };
    }
    // 1. 检查串口连接状态
    if (!this.isPortConnected) {
      return {
        ok: false,
        reason: 'port_closed',
        message: '⚠️ 串口未打开，请先点击顶部“打开串口”后再操作',
      };
    }

    // 2. 检查控件是否禁用
    if (config.enabled === false) {
      return {
        ok: false,
        reason: 'disabled',
        message: '控件已禁用',
      };
    }

    if (typeof config.command_template !== 'string' || !config.command_template.trim()) {
      return {
        ok: false,
        reason: 'disabled',
        message: '控件尚未绑定设备指令，未产生任何串口字节。',
      };
    }

    // 3. 数值型控件 SafetyGuard 限幅校验
    if (config.type === 'slider' || config.type === 'knob' || config.type === 'number' || config.type === 'number-input') {
      const numConfig = config as any;
      if (typeof numConfig.min === 'number' && typeof numConfig.max === 'number') {
        const targetVal = numVal !== undefined ? numVal : parseFloat(valStr);
        const safetyResult = checkAndSanitizeNumeric(targetVal, numConfig);
        if (!safetyResult.ok) {
          return {
            ok: false,
            reason: safetyResult.reason || 'out_of_range',
            message: safetyResult.message || '参数未通过安全限幅校验',
          };
        }
        valStr = safetyResult.formattedStr;
        numVal = safetyResult.value;
      }
    }

    // 4. 入队并执行同源合并 (同一 widgetId 的排队任务只保留最新一条)
    return new Promise<SendResult>((resolve, reject) => {
      const existingIdx = this.queue.findIndex((t) => t.widgetId === config.id);
      if (existingIdx !== -1) {
        // 合并：旧任务直接通知被覆盖
        const oldTask = this.queue[existingIdx];
        this.queue.splice(existingIdx, 1);
        oldTask.resolve({
          ok: false,
          reason: 'superseded',
          message: '该命令已被同一控件更新的待发送命令替代，未发送。',
        });
      }

      this.queue.push({
        widgetId: config.id,
        config,
        valStr,
        numVal,
        resolve,
        reject,
      });

      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        if (this.experimentLocked) break;
        const now = Date.now();
        const elapsed = now - this.lastSentTime;
        if (elapsed < this.minIntervalMs) {
          await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
        }

        const task = this.queue.shift();
        if (!task) break;

        if (this.experimentLocked) {
          task.resolve({ ok: false, reason: 'disabled', message: '自动调参开始前，普通控件命令已取消。' });
          continue;
        }

        if (!this.isPortConnected) {
          task.resolve({
            ok: false,
            reason: 'port_closed',
            message: '串口未连接',
          });
          continue;
        }

        try {
          const { payload, bytes } = renderTemplate(task.config, task.valStr, task.numVal);
          const isHex = task.config.encoding === 'hex';

          const sender = this.sender;
          if (!sender) {
            task.resolve({
              ok: false,
              reason: 'io_error',
              message: '串口发送器尚未就绪，命令未发送。',
            });
            continue;
          }
          await sender(payload, isHex, false);

          // 回写日志记录
          if (this.logWriter) {
            this.logWriter(task.config.title, payload, isHex);
          }

          this.lastSentTime = Date.now();
          task.resolve({
            ok: true,
            payload,
            bytes,
          });
        } catch (err: any) {
          task.resolve({
            ok: false,
            reason: 'io_error',
            message: `下发失败: ${err?.message || err}`,
          });
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}

export const globalSendGate = new SendGate(20);
