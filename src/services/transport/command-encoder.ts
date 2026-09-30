export type CommandEncoding = 'text' | 'hex';
export type CommandLineEnding = 'none' | 'lf' | 'cr' | 'crlf';

export interface CommandEncodingOptions {
  encoding: CommandEncoding;
  escapeText?: boolean;
  appendNewline?: boolean;
  lineEnding?: CommandLineEnding;
}

/** One deterministic encoder shared by Web Serial and the Tauri transport. */
export function encodeCommand(input: string, options: CommandEncodingOptions): Uint8Array {
  if (options.encoding === 'hex') {
    const compact = input.replace(/\s+/g, '');
    if (compact.length % 2 !== 0) {
      throw new Error('HEX 必须由完整字节组成；当前输入包含半个字节');
    }
    if (!/^[0-9a-f]*$/i.test(compact)) {
      const invalidAt = [...input].findIndex((char) => !/[\da-f\s]/i.test(char));
      throw new Error('HEX 包含非法字符' + (invalidAt >= 0 ? '，位置 ' + (invalidAt + 1) : ''));
    }
    const bytes = new Uint8Array(compact.length / 2);
    for (let index = 0; index < compact.length; index += 2) {
      bytes[index / 2] = Number.parseInt(compact.slice(index, index + 2), 16);
    }
    return bytes;
  }

  let text = options.escapeText ? decodeTextEscapes(input) : input;
  if (options.appendNewline && text.length > 0 && !text.endsWith('\r') && !text.endsWith('\n')) {
    const lineEnding = options.lineEnding ?? 'crlf';
    if (lineEnding === 'crlf') text += '\r\n';
    else if (lineEnding === 'lf') text += '\n';
    else if (lineEnding === 'cr') text += '\r';
  }
  return new TextEncoder().encode(text);
}

function decodeTextEscapes(input: string): string {
  return input.replace(/\\([rnt\\])/g, (_match, escaped: string) => {
    if (escaped === 'r') return '\r';
    if (escaped === 'n') return '\n';
    if (escaped === 't') return '\t';
    return '\\';
  });
}
