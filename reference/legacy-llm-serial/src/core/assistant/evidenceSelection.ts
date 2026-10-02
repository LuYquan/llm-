import type { ChannelSnapshot } from '../channel/types';
import { presentChannel } from '../channel/channelPresentation';

export const MAX_SELECTION_CHANNELS = 8;
export const MAX_SELECTION_SAMPLES = 256;
const MAX_INPUT_SAMPLES = 50_000;

export interface EvidenceSelectionContext {
  readonly sessionId: string | null;
  readonly epoch: number | null;
  readonly generation: number;
  readonly timeSource: string;
  readonly source: 'live' | 'demo' | 'unknown';
}
export interface FrozenSelectionChannel {
  readonly canonicalId: string;
  readonly label: string;
  readonly unit?: string;
  readonly unitSource?: 'user';
  readonly counts: Readonly<{ selected: number; valid: number; rejectedNonFiniteValues: number; retained: number; omittedForLimit: number }>;
  readonly summary: Readonly<{ scope: 'all-finite-samples-in-selected-cache'; count: number; from: number; to: number; min: number; max: number; mean: number; last: number }>;
  readonly samples: Readonly<{ timestamps: readonly number[]; values: readonly number[] }>;
  readonly sampling: 'all-original' | 'uniform-original-indices-including-ends';
}
export interface EvidenceSelection {
  readonly version: 1;
  readonly context: EvidenceSelectionContext;
  readonly range: Readonly<{ from: number; to: number }>;
  readonly sourceWidget: Readonly<{ id: string; title: string }>;
  readonly channels: readonly FrozenSelectionChannel[];
  readonly scopeNote: string;
}
export interface CreateFrozenSelectionInput {
  context: EvidenceSelectionContext;
  range: { from: number; to: number };
  sourceWidget: { id: string; title: string };
  channels: { canonicalId: string; snapshot: ChannelSnapshot; metadata?: { name?: unknown; unit?: unknown; unitSource?: unknown } | null }[];
}
function boundedText(value: unknown, name: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) throw new Error(`${name}无效`);
  return value;
}

/** Freeze original cache samples; display transforms and device completeness are never inferred. */
export function createFrozenSelection(input: CreateFrozenSelectionInput): EvidenceSelection {
  const { context, range } = input;
  if (!Number.isFinite(range.from) || !Number.isFinite(range.to) || range.from > range.to) throw new Error('选区必须是有限且有序的原始秒时间范围');
  if (!Number.isSafeInteger(context.generation) || context.generation < 0
    || (context.epoch !== null && (!Number.isSafeInteger(context.epoch) || context.epoch < 0))
    || !['live', 'demo', 'unknown'].includes(context.source)) throw new Error('选区会话身份无效');
  if (context.sessionId !== null) boundedText(context.sessionId, '会话 ID', 256);
  const timeSource = boundedText(context.timeSource, '时间来源', 128);
  if (!input.channels.length || input.channels.length > MAX_SELECTION_CHANNELS) throw new Error('选区需要 1–8 个通道');
  const ids = new Set<string>();
  const channels = input.channels.map(({ canonicalId, snapshot, metadata }): FrozenSelectionChannel => {
    boundedText(canonicalId, 'canonical 通道 ID', 256);
    if (ids.has(canonicalId)) throw new Error('选区不得重复引用同一个 canonical 通道');
    ids.add(canonicalId);
    if (!Number.isSafeInteger(snapshot.count) || snapshot.count < 0 || snapshot.count > MAX_INPUT_SAMPLES
      || snapshot.timestamps.length !== snapshot.count || snapshot.values.length !== snapshot.count) throw new Error('选区原始快照长度无效');
    const timestamps: number[] = [], values: number[] = [];
    let selected = 0, rejected = 0, previous = -Infinity, min = Infinity, max = -Infinity, mean = 0;
    for (let i = 0; i < snapshot.count; i++) {
      const t = snapshot.timestamps[i], v = snapshot.values[i];
      if (!Number.isFinite(t) || t < previous) throw new Error(`通道 ${canonicalId} 的原始时间无效或倒序，无法冻结选区`);
      previous = t;
      if (t < range.from || t > range.to) continue;
      selected++;
      if (!Number.isFinite(v)) { rejected++; continue; }
      timestamps.push(t); values.push(v); min = Math.min(min, v); max = Math.max(max, v);
      // Weighted incremental mean avoids overflowing an otherwise finite sum.
      mean = mean * ((values.length - 1) / values.length) + v / values.length;
    }
    if (!values.length || !Number.isFinite(mean)) throw new Error(`通道 ${canonicalId} 的选区没有可用的有限样本`);
    const retained = Math.min(MAX_SELECTION_SAMPLES, values.length);
    const indices = Array.from({ length: retained }, (_, i) => retained === values.length ? i : Math.round(i * (values.length - 1) / (retained - 1)));
    const presentation = presentChannel(canonicalId, metadata);
    return Object.freeze({ canonicalId, label: presentation.label,
      ...(presentation.unit ? { unit: presentation.unit, unitSource: 'user' as const } : {}),
      counts: Object.freeze({ selected, valid: values.length, rejectedNonFiniteValues: rejected, retained, omittedForLimit: values.length - retained }),
      summary: Object.freeze({ scope: 'all-finite-samples-in-selected-cache' as const, count: values.length,
        from: timestamps[0], to: timestamps[timestamps.length - 1], min, max, mean, last: values[values.length - 1] }),
      samples: Object.freeze({ timestamps: Object.freeze(indices.map(i => timestamps[i])), values: Object.freeze(indices.map(i => values[i])) }),
      sampling: values.length > retained ? 'uniform-original-indices-including-ends' : 'all-original' });
  });
  return Object.freeze({ version: 1, context: Object.freeze({ sessionId: context.sessionId, epoch: context.epoch,
      generation: context.generation, source: context.source, timeSource }), range: Object.freeze({ from: range.from, to: range.to }),
    sourceWidget: Object.freeze({ id: boundedText(input.sourceWidget.id, '图表 ID', 256), title: boundedText(input.sourceWidget.title, '图表名称', 256) }),
    channels: Object.freeze(channels), scopeNote: '原始秒范围内的冻结显示缓存；统计覆盖全部有限所选样本，原始数组最多每通道256点、8通道。按原样本索引均匀取点并保留首尾，不插值、不平均，不保证时间均匀或完整动态；不是完整原始串口记录或硬件采样时钟证明。无效值已拒绝并计数。' });
}

export function selectionMatchesContext(selection: EvidenceSelection, context: Pick<EvidenceSelectionContext, 'sessionId' | 'epoch' | 'generation'>): boolean {
  return selection.context.sessionId === context.sessionId && selection.context.epoch === context.epoch && selection.context.generation === context.generation;
}

/** No selection payload, including raw arrays, exists without explicit opt-in. */
export function selectionUploadEvidence(selection: EvidenceSelection | null, optedIn: boolean): EvidenceSelection | undefined {
  return optedIn && selection ? selection : undefined;
}

/** Identifies evidence/options and cancellation independently of new live samples. */
export class AssistantEvidenceGuard {
  private revision = 0;
  capture(contextKey: string): Readonly<{ revision: number; contextKey: string }> { return Object.freeze({ revision: this.revision, contextKey }); }
  cancel(): void { this.revision++; }
  accepts(token: Readonly<{ revision: number; contextKey: string }>, currentContextKey: string): boolean {
    return token.revision === this.revision && token.contextKey === currentContextKey;
  }
}
