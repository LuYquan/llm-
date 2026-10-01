import assert from 'node:assert/strict';
import { encodeCommand } from '../src/services/transport/command-encoder';
import { isTuningCommandFormat, materializeTuningCommand, tuningCommandBytes, validateTuningCommandPayload } from '../src/core/tuning/commandContract';
import type { TuningCommandFormat, TuningCommandPayload } from '../src/core/tuning/commandContract';

export function runTuningCommandContractTests(): void {
  let checked = 0;
  const defaultPayload = materializeTuningCommand('PID,1,2,3');
  assert.deepEqual(defaultPayload.format, { escapeText: true, lineEnding: 'crlf' });
  assert.deepEqual([...tuningCommandBytes(defaultPayload)], [...new TextEncoder().encode('PID,1,2,3\r\n')]);
  assert.equal(defaultPayload.hex, '50 49 44 2C 31 2C 32 2C 33 0D 0A');
  assert.equal(defaultPayload.visibleText, '"PID,1,2,3\\r\\n"');
  assert.equal(defaultPayload.byteLength, 11);
  assert.ok(Object.isFrozen(defaultPayload) && Object.isFrozen(defaultPayload.format));
  assert.equal(validateTuningCommandPayload(defaultPayload, 'PID,1,2,3'), true);
  assert.equal(validateTuningCommandPayload(defaultPayload, 'PID,1,2,4'), false);
  checked++;

  for (const lineEnding of ['none', 'lf', 'cr', 'crlf'] as const) {
    for (const escapeText of [false, true]) {
      const format: TuningCommandFormat = { escapeText, lineEnding };
      for (const source of ['GO', 'GO\n', 'GO\r', 'GO\r\n', 'GO\\n', ' GO ', '停止🚀', '\\r\\n\\t\\\\', '\u0000\u007f\u0085', '\ufeffPING', '\u202e\u200b\u2028\u2029', '\ud800']) {
        const payload = materializeTuningCommand(source, format);
        const expected = encodeCommand(source, { encoding: 'text', escapeText, appendNewline: lineEnding !== 'none', lineEnding });
        assert.deepEqual([...tuningCommandBytes(payload, source)], [...expected], `${JSON.stringify(source)} ${JSON.stringify(format)}`);
        assert.equal(payload.byteLength, expected.length);
        assert.equal(payload.hex, Array.from(expected, byte => byte.toString(16).toUpperCase().padStart(2, '0')).join(' '));
        assert.equal(validateTuningCommandPayload(payload, source), true);
        assert.equal(JSON.parse(payload.visibleText), new TextDecoder('utf-8', { ignoreBOM: true }).decode(expected), 'visible preview preserves the entire actual UTF-8 payload');
        assert.ok(!/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(payload.visibleText), 'control/format characters never remain invisible in the preview');
        checked++;
      }
    }
  }
  assert.equal(materializeTuningCommand('GO\n').hex, '47 4F 0A', 'an existing LF is not changed to or followed by CRLF');
  assert.equal(materializeTuningCommand('GO\r').hex, '47 4F 0D', 'an existing CR is not followed by a guessed LF');
  assert.equal(materializeTuningCommand('GO\\n').visibleText, '"GO\\n"');
  assert.equal(materializeTuningCommand('GO\\n', { escapeText: false, lineEnding: 'none' }).visibleText, '"GO\\\\n"');
  assert.equal(materializeTuningCommand('\u0000\u007f\u0085', { escapeText: false, lineEnding: 'none' }).visibleText, '"\\u0000\\u007f\\u0085"');
  assert.equal(materializeTuningCommand('\ufeffPING', { escapeText: true, lineEnding: 'none' }).hex, 'EF BB BF 50 49 4E 47');
  assert.equal(materializeTuningCommand('\ufeffPING', { escapeText: true, lineEnding: 'none' }).visibleText, '"\\ufeffPING"');
  checked++;

  const sensitive = materializeTuningCommand('GO\\n');
  const malformed: unknown[] = [
    null, [], {}, { ...sensitive, sourceText: 'STOP\\n' },
    { ...sensitive, format: { escapeText: false, lineEnding: 'crlf' } },
    { ...defaultPayload, format: { escapeText: true, lineEnding: 'none' } },
    { ...sensitive, hex: sensitive.hex.toLowerCase() },
    { ...sensitive, hex: sensitive.hex.replaceAll(' ', '') },
    { ...sensitive, hex: sensitive.hex + ' ' },
    { ...sensitive, hex: sensitive.hex.replace('47', '48') },
    { ...sensitive, byteLength: sensitive.byteLength + 1 },
    { ...sensitive, byteLength: 3.5 },
    { ...sensitive, visibleText: '"GO\\\\n"' },
    { ...sensitive, visibleText: 'GO\n' },
    { ...sensitive, extra: true },
    { ...sensitive, format: { ...sensitive.format, extra: true } },
    { ...sensitive, format: { escapeText: 1, lineEnding: 'crlf' } },
    { ...sensitive, format: { escapeText: true, lineEnding: 'auto' } },
    { ...sensitive, format: null },
    { ...sensitive, sourceText: '' },
  ];
  for (const payload of malformed) {
    assert.equal(validateTuningCommandPayload(payload), false, JSON.stringify(payload));
    assert.throws(() => tuningCommandBytes(payload), 'invalid contracts never produce bytes');
    checked++;
  }
  const symbolExtra = { ...sensitive, [Symbol('extra')]: 1 };
  const hiddenExtra = Object.defineProperty({ ...sensitive }, 'hidden', { value: true });
  const accessor = Object.defineProperty({ ...sensitive }, 'sourceText', { enumerable: true, get() { throw new Error('must not run getter'); } });
  const inherited = Object.create(sensitive);
  for (const value of [symbolExtra, hiddenExtra, accessor, inherited]) {
    assert.equal(validateTuningCommandPayload(value), false);
    assert.throws(() => tuningCommandBytes(value));
    checked++;
  }

  assert.equal(isTuningCommandFormat({ escapeText: false, lineEnding: 'none' }), true);
  assert.equal(isTuningCommandFormat(undefined), false);
  assert.deepEqual(materializeTuningCommand('GO', undefined).format, { escapeText: true, lineEnding: 'crlf' }, 'omitted optional format uses the documented default');
  for (const value of [null, [], {}, { escapeText: false }, { lineEnding: 'none' }, { escapeText: 'false', lineEnding: 'none' }, { escapeText: true, lineEnding: 'none', appendNewline: true }]) {
    assert.equal(isTuningCommandFormat(value), false);
    assert.throws(() => materializeTuningCommand('GO', value as TuningCommandFormat), /格式/);
    checked++;
  }

  assert.throws(() => materializeTuningCommand(''), /不能为空/);
  assert.throws(() => materializeTuningCommand('a'.repeat(4097)), /4096/);
  const longestAscii = materializeTuningCommand('a'.repeat(4096));
  assert.equal(longestAscii.byteLength, 4098);
  const byteBoundary = materializeTuningCommand('é'.repeat(4096), { escapeText: false, lineEnding: 'none' });
  assert.equal(byteBoundary.byteLength, 8192);
  assert.equal(validateTuningCommandPayload(byteBoundary), true);
  assert.throws(() => materializeTuningCommand('é'.repeat(4096), { escapeText: false, lineEnding: 'lf' }), /8192/);
  assert.throws(() => materializeTuningCommand('中'.repeat(2731), { escapeText: false, lineEnding: 'none' }), /8192/);
  assert.equal(materializeTuningCommand('🚀'.repeat(2048), { escapeText: false, lineEnding: 'none' }).byteLength, 8192);
  assert.throws(() => materializeTuningCommand('🚀'.repeat(2049), { escapeText: false, lineEnding: 'none' }), /4096/);
  checked++;

  const firstCopy = tuningCommandBytes(defaultPayload);
  const secondCopy = tuningCommandBytes(defaultPayload);
  firstCopy.fill(0);
  assert.equal(secondCopy[0], 0x50);
  assert.equal(tuningCommandBytes(defaultPayload)[0], 0x50);
  assert.throws(() => tuningCommandBytes(defaultPayload, 'old-command'));
  assert.throws(() => { (defaultPayload as TuningCommandPayload).sourceText = 'changed'; }, TypeError);
  assert.throws(() => { defaultPayload.format.lineEnding = 'none'; }, TypeError);
  const format: TuningCommandFormat = { escapeText: true, lineEnding: 'crlf' };
  const independentFormat = materializeTuningCommand('GO', format);
  format.lineEnding = 'none';
  assert.equal(independentFormat.format.lineEnding, 'crlf');
  checked++;

  console.log(`✓ 调参命令最终字节冻结契约测试通过（${checked} 项）：共享编码、行尾/转义、UTF-8/可见控制符、篡改拒绝、长度边界和独立副本。`);
}

runTuningCommandContractTests();
