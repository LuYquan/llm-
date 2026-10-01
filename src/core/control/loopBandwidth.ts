import type { ControlLoop } from '../project/types';
import { computeBode } from './computeBode';
import { validatePlantModel } from './transferFunction';
import type { LoopBandwidthInfo } from './bandwidthChecker';

export interface LoopBandwidthEvidence {
  info: LoopBandwidthInfo;
  source: 'model-estimate' | 'unavailable';
  explanation: string;
}

/** Only use actual project inputs. Never choose a frequency from loop order or a default period. */
export function estimateLoopBandwidth(loop: ControlLoop): LoopBandwidthEvidence {
  const period = loop.sample_period_s ?? loop.sample_time;
  const info: LoopBandwidthInfo = { id: loop.id, name: loop.name, order: loop.order, omega_c: NaN, sampleTime: period };
  const missing = (explanation: string): LoopBandwidthEvidence => ({ info, source: 'unavailable', explanation });
  if (!Number.isFinite(period) || (period ?? 0) <= 0) return missing('待提供有效采样周期；不使用默认 1ms。');
  if (!loop.identified_model || loop.state === 'untuned') return missing('待提供当前环的有效对象模型；不能按层级填入典型频率。');
  const errors = validatePlantModel(loop.identified_model);
  if (errors.length) return missing(errors.join(' '));
  const params = loop.current_params;
  if (!params || ![params.kp, params.ki, params.kd].every(Number.isFinite)) return missing('待提供有限的项目 PID 参数。');
  const pid = { kp: params.kp, ki: loop.structure === 'PI' || loop.structure === 'PID' ? params.ki : 0, kd: loop.structure === 'PD' || loop.structure === 'PID' ? params.kd : 0 };
  try {
    const result = computeBode(loop.identified_model, pid, { sampleTime: period, pointsCount: 1000 });
    if (result.omega_c === null || !Number.isFinite(result.omega_c) || result.omega_c <= 0) return missing('当前模型扫描没有有效 0dB 剪切频率；不能判为通过。');
    return { info: { ...info, omega_c: result.omega_c }, source: 'model-estimate', explanation: '来自项目对象与 PID 的模型估计（连续 PID、采样延迟近似），不是设备实测或固件验证。' };
  } catch (error) {
    return missing(error instanceof Error ? error.message : '对象频域计算失败。');
  }
}
