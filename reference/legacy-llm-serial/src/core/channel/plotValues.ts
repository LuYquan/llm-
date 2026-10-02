import type uPlot from 'uplot';

/** Display transforms must not coerce malformed metadata into measured zero. */
export function transformPlotValues(raw: Float64Array, scale?: unknown, yOffset?: unknown): Float64Array {
  const multiplier = scale === undefined ? 1 : scale;
  const offset = yOffset === undefined ? 0 : yOffset;
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier)
    || typeof offset !== 'number' || !Number.isFinite(offset)) {
    return new Float64Array(raw.length).fill(Number.NaN);
  }
  if (multiplier === 1 && offset === 0) return raw;
  return Float64Array.from(raw, value => value * multiplier + offset);
}

/**
 * uPlot treats null as a gap, whereas NaN poisons a shared automatic Y range.
 * Convert only the final displayed Y values. Raw snapshots and aligned analysis
 * arrays keep their original values; neither path is mutated here.
 */
export function toUPlotValues<T extends uPlot.TypedArray | readonly number[]>(values: T): T | (number | null)[] {
  for (let index = 0; index < values.length; index++) {
    if (!Number.isFinite(values[index])) {
      return Array.from(values, value => Number.isFinite(value) ? value : null);
    }
  }
  // The common finite typed-array path stays zero-copy.
  return values;
}
