import type { PlantModel } from './types';
import { validatePlantModel } from './transferFunction';

export interface SimulationPidInput {
  kp: number;
  ki: number;
  kd: number;
  tf?: number;
}

export type PlantModelSource = 'example' | 'identified' | 'manual';

export function getPlantModelError(plant: PlantModel | null | undefined): string | null {
  if (!plant) return '尚无有效对象模型，请先完成实测辨识或手动设定对象参数。';
  if (plant.family === 'transfer_function') return validatePlantModel(plant)[0] ?? null;
  if (!Number.isFinite(plant.k)) return '对象模型增益必须是有限数值。';
  if (!Number.isFinite(plant.tau) || plant.tau < 0) return '对象模型滞后必须是非负有限数值。';

  if (plant.family === 'sopdt') {
    if (!Number.isFinite(plant.wn) || plant.wn <= 0) return '二阶模型固有频率必须大于 0。';
    if (!Number.isFinite(plant.zeta) || plant.zeta <= 0) return '二阶模型阻尼比必须大于 0。';
    return null;
  }

  if (!Number.isFinite(plant.t) || plant.t <= 0) return '对象模型时间常数必须大于 0。';
  return null;
}

export function getPidParameterError(
  pid: SimulationPidInput | null | undefined,
  sampleTime: number,
): string | null {
  if (!pid) return '尚无 PID 候选，请先运行频域解算。';
  if (!Number.isFinite(sampleTime) || sampleTime <= 0) return '采样周期必须是大于 0 的有限数值。';
  if (![pid.kp, pid.ki, pid.kd].every(Number.isFinite)) return 'PID 参数必须全部是有限数值。';
  if (pid.tf !== undefined && (!Number.isFinite(pid.tf) || pid.tf < 0)) return '微分滤波时间常数必须是非负有限数值。';
  return null;
}

export function getSimulationInputError(
  plant: PlantModel | null | undefined,
  pid: SimulationPidInput | null | undefined,
  sampleTime: number,
): string | null {
  return getPlantModelError(plant) ?? getPidParameterError(pid, sampleTime);
}

export function getPidCandidateUseError(
  source: PlantModelSource,
  hasSuccessfulSolve: boolean,
  plant: PlantModel | null | undefined,
  pid: SimulationPidInput | null | undefined,
  sampleTime: number,
): string | null {
  if (source === 'example') return '示例模型仅用于离线预览，不能生成设备命令。';
  if (!hasSuccessfulSolve) return '尚无基于当前模型与采样周期的有效 PID 解算候选。';
  return getSimulationInputError(plant, pid, sampleTime);
}
