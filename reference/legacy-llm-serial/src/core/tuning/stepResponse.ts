export type StepReference =
  | { valid: true; initialTarget: number; finalTarget: number; amplitude: number; direction: number; transitionIndex: number }
  | { valid: false; reason: string };

/** Identify one sampled step, without guessing a ramp or merging repeated steps. */
export function identifyStepReference(setpoints: ArrayLike<number>, tolerance: unknown): StepReference {
  const invalid = (reason: string): StepReference => ({ valid: false, reason });
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
    return invalid('请设置有限且非负的阶跃设定值容差；旧配置没有该值时需先补充。');
  }
  const count = setpoints.length;
  if (!Number.isSafeInteger(count) || count < 10) return invalid('单次阶跃需要至少 5 组阶跃前和 5 组阶跃后平台采样。');
  const median = (start: number) => {
    const values = Array.from({ length: 5 }, (_, index) => setpoints[start + index]).sort((a, b) => a - b);
    return values[2];
  };
  const initialTarget = median(0);
  const finalTarget = median(count - 5);
  const difference = finalTarget - initialTarget;
  const amplitude = Math.abs(difference);
  if (!Number.isFinite(amplitude) || amplitude === 0 || tolerance * 2 >= amplitude) {
    return invalid('首尾设定值没有可区分的阶跃；容差必须小于阶跃幅度的一半。');
  }
  let transitionIndex = -1;
  for (let index = 0; index < count; index++) {
    const value = setpoints[index];
    if (!Number.isFinite(value)) return invalid('设定值包含无效数字，不能识别单次阶跃。');
    const onInitial = Math.abs(value - initialTarget) <= tolerance;
    const onFinal = Math.abs(value - finalTarget) <= tolerance;
    if (!onInitial && !onFinal) return invalid('设定值包含中间目标、渐变或超出容差的波动；请采集单次阶跃，或使用轨迹跟踪目标。');
    if (onFinal && transitionIndex < 0) transitionIndex = index;
    else if (onInitial && transitionIndex >= 0) return invalid('设定值发生多次跳变，不能合并为一次阶跃响应；请分开采集或使用轨迹跟踪目标。');
  }
  if (transitionIndex < 5 || count - transitionIndex < 5) return invalid('单次阶跃需要至少 5 组阶跃前和 5 组阶跃后平台采样。');
  return { valid: true, initialTarget, finalTarget, amplitude, direction: Math.sign(difference), transitionIndex };
}
