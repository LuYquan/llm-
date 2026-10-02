import { validateProtocolConfig, type ProtocolConfig } from '../protocol/types';
import { isActiveParameter } from './engine';
import type { TuningPlan } from './types';

export interface TuningProtocolCapabilityInput {
  protocolConfig: ProtocolConfig | null;
  plan: Pick<TuningPlan, 'structure' | 'channels' | 'confirmation' | 'baseline'>;
  /** Exact buffer IDs from ChannelStore.listChannels(), never display aliases. */
  canonicalChannelIds: readonly string[];
}

const NUMERIC_FORMATS = ['u8', 'i8', 'u16le', 'u16be', 'i16le', 'i16be', 'u32le', 'u32be', 'i32le', 'i32be', 'f32le', 'f32be', 'f64le', 'f64be'];

/**
 * Execution capability only: this grants neither device authorization nor fresh
 * telemetry evidence. Callers must recheck session identity, generation, channel
 * age and these capabilities after asynchronous waits and before each write.
 * Offline model candidate calculation does not require this check.
 */
export function validateTuningProtocolCapabilities(input: TuningProtocolCapabilityInput): string[] {
  const { protocolConfig, plan, canonicalChannelIds } = input;
  const errors: string[] = [];
  let protocolValid = false;
  try {
    const protocolError = protocolConfig ? validateProtocolConfig(protocolConfig) : '缺少当前协议配置';
    if (protocolError) errors.push(`当前协议配置无效：${protocolError}。`);
    else if (protocolConfig?.type === 'custom' && !NUMERIC_FORMATS.includes(protocolConfig.dataType)) {
      // The shared validator currently checks frame shape but not dataType.
      errors.push('当前自定义协议数值类型无效，不能用于调参反馈。');
    } else protocolValid = true;
  } catch { errors.push('当前协议配置无效，不能用于调参反馈。'); }
  if (protocolValid && protocolConfig?.type === 'rawdata' && protocolConfig.mode === 'display') {
    errors.push('RawData 原始显示模式不产生数值遥测；调参反馈需要先配置数值解码协议。');
  }
  if (!plan || !['P', 'PI', 'PD', 'PID'].includes(plan.structure)
    || !plan.channels || typeof plan.channels !== 'object' || !plan.channels.parameters
    || !plan.confirmation || !['manual', 'acknowledgement', 'parameter-channels'].includes(plan.confirmation.mode)
    || !plan.baseline || !['unset', 'manual', 'parameter-channels'].includes(plan.baseline.source)) {
    return [...errors, '调参通道与设备确认配置无效。'];
  }
  if (plan.confirmation.mode === 'acknowledgement' && (!protocolValid || protocolConfig?.type !== 'firewater')) {
    errors.push('文本写入应答确认仅支持 FireWater；当前协议请使用参数回传或逐轮人工核对。');
  }
  if (!Array.isArray(canonicalChannelIds) || canonicalChannelIds.some(id => typeof id !== 'string' || !id.trim())
    || new Set(canonicalChannelIds).size !== canonicalChannelIds.length) {
    return [...errors, '当前真实通道 ID 列表无效，请重新读取当前连接的通道。'];
  }
  const canonical = new Set(canonicalChannelIds);
  const bindings: Array<{ label: string; id: unknown }> = [
    { label: '设定值', id: plan.channels.setpoint },
    { label: '实际反馈', id: plan.channels.feedback },
    { label: '控制输出', id: plan.channels.output },
  ];
  if (plan.confirmation.mode === 'parameter-channels' || plan.baseline.source === 'parameter-channels') {
    for (const key of ['kp', 'ki', 'kd'] as const) {
      if (isActiveParameter(plan.structure, key)) bindings.push({ label: `${key.toUpperCase()} 参数回传`, id: plan.channels.parameters[key] });
    }
  }
  const used = new Map<string, string>();
  for (const { label, id } of bindings) {
    if (typeof id !== 'string' || !id.trim() || !canonical.has(id)) {
      errors.push(`${label}必须绑定当前连接中精确的真实通道 ID；别名或未出现的通道不能用于调参执行。`);
      continue;
    }
    const previous = used.get(id);
    if (previous) errors.push(`${label}与${previous}重复绑定真实通道 ${id}；调参执行需要各变量独立的遥测来源。`);
    else used.set(id, label);
  }
  return errors;
}
