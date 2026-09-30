import type { BaseWidgetConfig, NumericWidgetBase, PayloadEncoding } from '../../types/widget';

/**
 * 解析常用转义字符：\n, \r, \t, \\, 以及 \xNN
 */
export function parseEscapeSequences(str: string): string {
  return str.replace(/\\(n|r|t|\\|x[0-9A-Fa-f]{2})/g, (match, p1) => {
    if (p1 === 'n') return '\n';
    if (p1 === 'r') return '\r';
    if (p1 === 't') return '\t';
    if (p1 === '\\') return '\\';
    if (p1.startsWith('x')) {
      const code = parseInt(p1.slice(1), 16);
      return String.fromCharCode(code);
    }
    return match;
  });
}

/**
 * 将转义字符还原为可视化表示（用于在预览区展示）
 */
export function visualizeEscapeSequences(str: string): string {
  return str
    .replace(/\r\n/g, '\\r\\n⏎\n')
    .replace(/\n/g, '\\n⏎\n')
    .replace(/\r/g, '\\r⏎')
    .replace(/\t/g, '\\t⇥');
}

/**
 * 将数值按照指定的二进制格式转换为 HEX 字节串 (空格分隔，如 "01 C4")
 */
export function encodeNumberToHex(
  val: number,
  format: NumericWidgetBase['hex_val_format'] = 'u16le'
): string {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);

  let byteLen = 2;
  switch (format) {
    case 'u8':
      view.setUint8(0, val & 0xff);
      byteLen = 1;
      break;
    case 'i8':
      view.setInt8(0, val);
      byteLen = 1;
      break;
    case 'u16le':
      view.setUint16(0, val, true);
      byteLen = 2;
      break;
    case 'u16be':
      view.setUint16(0, val, false);
      byteLen = 2;
      break;
    case 'i16le':
      view.setInt16(0, val, true);
      byteLen = 2;
      break;
    case 'i16be':
      view.setInt16(0, val, false);
      byteLen = 2;
      break;
    case 'f32le':
      view.setFloat32(0, val, true);
      byteLen = 4;
      break;
    case 'f32be':
      view.setFloat32(0, val, false);
      byteLen = 4;
      break;
    default:
      view.setUint16(0, val, true);
      byteLen = 2;
      break;
  }

  const bytes: string[] = [];
  for (let i = 0; i < byteLen; i++) {
    bytes.push(view.getUint8(i).toString(16).padStart(2, '0').toUpperCase());
  }
  return bytes.join(' ');
}

/**
 * 校验模板合法性 (支持 VOFA+ 经典的 %% 占位符以及 {val}、{value}、%f 等)
 */
export function validateTemplate(
  template: string,
  encoding: PayloadEncoding,
  requireVal: boolean
): { valid: boolean; error?: string } {
  if (!template || template.trim() === '') {
    return { valid: false, error: '指令模板不能为空' };
  }

  const hasPlaceholder =
    template.includes('{val}') ||
    template.includes('{value}') ||
    template.includes('%%') ||
    /%[0-9]*\.?[0-9]*[fdis]/.test(template);

  if (requireVal && !hasPlaceholder) {
    return { valid: false, error: '数值类控件指令模板中必须包含 {val}、{value} 或 %% 占位符' };
  }

  if (encoding === 'hex') {
    // 替换掉占位符后校验其余部分是否均为合法十六进制字节
    const rawTokens = template
      .replace(/\{val\}|\{value\}|%%/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const token of rawTokens) {
      if (!/^[0-9A-Fa-f]{2}$/.test(token)) {
        return {
          valid: false,
          error: `HEX 模式下必须为标准的两位十六进制字节 (如 AA 01)，非法标记: "${token}"`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * 渲染指令模板
 */
export function renderTemplate(
  config: BaseWidgetConfig,
  valStr: string,
  numVal?: number
): { payload: string; bytes: Uint8Array } {
  const tpl = config.command_template || '';

  if (config.encoding === 'hex') {
    let hexContent = tpl;
    const num = numVal !== undefined ? numVal : parseFloat(valStr) || 0;
    // 默认 HEX 浮点注入为 4 字节 IEEE 754 小端 (f32le)
    const hexFormat = (config as NumericWidgetBase).hex_val_format || (tpl.includes('%%') ? 'f32le' : 'u16le');
    const hexVal = encodeNumberToHex(num, hexFormat);

    if (hexContent.includes('%%')) {
      hexContent = hexContent.replace(/%%/g, hexVal);
    }
    if (hexContent.includes('{val}') || hexContent.includes('{value}')) {
      hexContent = hexContent.replace(/\{val\}|\{value\}/g, hexVal);
    }

    // 格式化为大写规整的 HEX 字符串
    const tokens = hexContent.trim().split(/\s+/).filter(Boolean);
    const bytes = new Uint8Array(tokens.length);
    for (let i = 0; i < tokens.length; i++) {
      const parsed = parseInt(tokens[i], 16);
      bytes[i] = isNaN(parsed) ? 0 : parsed & 0xff;
    }

    const payload = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');

    return { payload, bytes };
  }

  // text 文本模式
  let text = tpl;
  const num = numVal !== undefined ? numVal : parseFloat(valStr) || 0;

  // 1. 支持 printf 风格 %f / %.2f / %d
  text = text.replace(/%(\d*)(\.(\d+))?f/g, (_match, _width, _hasDot, prec) => {
    const p = prec !== undefined ? parseInt(prec, 10) : 2;
    return num.toFixed(p);
  });
  text = text.replace(/%d/g, () => Math.round(num).toString());

  // 2. 支持 {val} 与 {value} 别名
  if (text.includes('{val}') || text.includes('{value}')) {
    text = text.replace(/\{val\}|\{value\}/g, valStr);
  }

  text = parseEscapeSequences(text);
  const bytes = new TextEncoder().encode(text);
  return { payload: text, bytes };
}
