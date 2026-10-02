import { encodeCommand } from '../../services/transport/command-encoder';

export type TuningCommandFormat = {
  escapeText: boolean;
  lineEnding: 'none' | 'lf' | 'cr' | 'crlf';
};

export type TuningCommandPayload = {
  sourceText: string;
  format: TuningCommandFormat;
  /** Uppercase two-digit bytes separated by exactly one ASCII space. */
  hex: string;
  byteLength: number;
  /** JSON-quoted actual UTF-8 text, with control/format characters escaped. */
  visibleText: string;
};

const SOURCE_LENGTH_LIMIT = 4_096;
const BYTE_LENGTH_LIMIT = 8_192;
const DEFAULT_FORMAT: Readonly<TuningCommandFormat> = Object.freeze({ escapeText: true, lineEnding: 'crlf' });

/** Plain own data fields only: symbols, accessors and inherited contracts fail. */
function hasExactDataFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && fields.every(field => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return Boolean(descriptor && 'value' in descriptor && descriptor.enumerable);
  });
}

export function isTuningCommandFormat(value: unknown): value is TuningCommandFormat {
  try {
    return hasExactDataFields(value, ['escapeText', 'lineEnding']) && typeof value.escapeText === 'boolean'
      && ['none', 'lf', 'cr', 'crlf'].includes(value.lineEnding as string);
  } catch { return false; }
}

function encode(sourceText: string, format: TuningCommandFormat): Uint8Array {
  // JavaScript string.length counts UTF-16 code units; do not trim protocol text.
  if (typeof sourceText !== 'string' || sourceText.length === 0 || sourceText.length > SOURCE_LENGTH_LIMIT) {
    throw new Error('调参命令不能为空，且源码不得超过 4096 个 UTF-16 单元。');
  }
  if (!isTuningCommandFormat(format)) throw new Error('调参命令的转义和行尾格式无效。');
  const bytes = encodeCommand(sourceText, {
    encoding: 'text', escapeText: format.escapeText,
    appendNewline: format.lineEnding !== 'none', lineEnding: format.lineEnding,
  });
  if (bytes.length === 0 || bytes.length > BYTE_LENGTH_LIMIT) throw new Error('调参命令的最终字节长度必须为 1 到 8192。');
  return bytes;
}

function hexBytes(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function visibleBytes(bytes: Uint8Array): string {
  // Preserve even a leading UTF-8 BOM in the preview; TextDecoder's default
  // BOM handling would otherwise hide a real EF BB BF prefix from the user.
  const actual = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return JSON.stringify(actual).replace(/\p{Cc}|\p{Cf}|\u2028|\u2029/gu, character => {
    // C0 controls are already JSON-escaped. DEL, C1 and Unicode format controls
    // need this extra pass to avoid invisible bytes or directional text tricks.
    return Array.from(character, codePoint => {
      const value = codePoint.codePointAt(0)!;
      if (value <= 0xffff) return `\\u${value.toString(16).padStart(4, '0')}`;
      const pair = value - 0x10000;
      return `\\u${(0xd800 + (pair >> 10)).toString(16)}\\u${(0xdc00 + (pair & 0x3ff)).toString(16)}`;
    }).join('');
  });
}

/** Freeze the exact final wire representation before review or authorization. */
export function materializeTuningCommand(sourceText: string, format: TuningCommandFormat = DEFAULT_FORMAT): TuningCommandPayload {
  const bytes = encode(sourceText, format);
  const copiedFormat = Object.freeze({ escapeText: format.escapeText, lineEnding: format.lineEnding });
  return Object.freeze({ sourceText, format: copiedFormat, hex: hexBytes(bytes), byteLength: bytes.length, visibleText: visibleBytes(bytes) });
}

function checkedBytes(payload: unknown, expectedSourceText?: string): Uint8Array {
  if (!hasExactDataFields(payload, ['sourceText', 'format', 'hex', 'byteLength', 'visibleText'])
    || typeof payload.sourceText !== 'string' || !isTuningCommandFormat(payload.format)
    || typeof payload.hex !== 'string' || !Number.isSafeInteger(payload.byteLength)
    || typeof payload.visibleText !== 'string'
    || expectedSourceText !== undefined && payload.sourceText !== expectedSourceText) {
    throw new Error('调参命令字节契约缺失、无效或已不对应当前命令。请重新生成候选。');
  }
  const bytes = encode(payload.sourceText, payload.format);
  if (payload.byteLength !== bytes.length || payload.hex !== hexBytes(bytes) || payload.visibleText !== visibleBytes(bytes)) {
    throw new Error('调参命令字节、长度或可见预览与冻结契约不一致。请重新生成候选。');
  }
  return bytes;
}

export function validateTuningCommandPayload(payload: unknown, expectedSourceText?: string): payload is TuningCommandPayload {
  try { checkedBytes(payload, expectedSourceText); return true; } catch { return false; }
}

/** Always returns an independent copy; no mutable bytes are stored in payload. */
export function tuningCommandBytes(payload: unknown, expectedSourceText?: string): Uint8Array {
  return new Uint8Array(checkedBytes(payload, expectedSourceText));
}
