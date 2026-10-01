/** User-authored raw units are declarations, never inferred conversion metadata. */
export const CHANNEL_UNIT_MAX_LENGTH = 24;
const FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

export interface ChannelUnitMetadata {
  unit?: string;
  unitSource?: 'user';
}

export interface ChannelPresentation extends ChannelUnitMetadata {
  id: string;
  label: string;
  alias?: string;
}

export interface ChannelPresentationMetadata {
  name?: unknown;
  unit?: unknown;
  unitSource?: unknown;
}

function ownValue(value: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key);
  if (!field) return undefined;
  if (!('value' in field)) throw new Error('通道原始单位必须为普通数据字段。');
  return field.value;
}

/** Throws before mutation. Undefined pairs represent an explicit in-memory clear. */
export function normalizeChannelUnitMetadata(value: unknown): ChannelUnitMetadata {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('通道元数据必须为对象。');
  const unit = ownValue(value, 'unit');
  const source = ownValue(value, 'unitSource');
  if (unit === undefined && source === undefined) return {};
  if (typeof unit !== 'string' || source !== 'user') {
    throw new Error('原始单位必须为文本，并配对标记为用户提供；没有单位时不能保留来源。');
  }
  if (FORBIDDEN_TEXT.test(unit)) throw new Error('原始单位不能包含控制、隐藏格式或换行字符。');
  const normalized = unit.trim();
  if (!normalized || normalized.length > CHANNEL_UNIT_MAX_LENGTH) {
    throw new Error(`原始单位须为 1 到 ${CHANNEL_UNIT_MAX_LENGTH} 个字符；清空时请同时移除单位与来源。`);
  }
  return { unit: normalized, unitSource: 'user' };
}

/** Presentation only: preserves the supplied canonical ID and never touches data. */
export function presentChannel(canonicalId: string, meta?: ChannelPresentationMetadata | null): ChannelPresentation {
  if (typeof canonicalId !== 'string' || !canonicalId.trim()) throw new Error('真实通道 ID 不能为空。');
  const name = typeof meta?.name === 'string' ? meta.name.trim() : '';
  const alias = name && name !== canonicalId && name.length <= 128 && !FORBIDDEN_TEXT.test(meta!.name as string)
    ? name : undefined;
  const result: ChannelPresentation = { id: canonicalId, label: alias ? `${alias} · ${canonicalId}` : canonicalId };
  if (alias) result.alias = alias;
  try { Object.assign(result, normalizeChannelUnitMetadata(meta ?? undefined)); }
  catch { /* Malformed declarations do not become trusted units in a read path. */ }
  return result;
}
