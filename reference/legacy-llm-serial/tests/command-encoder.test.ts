import assert from 'node:assert/strict';
import { encodeCommand } from '../src/services/transport/command-encoder.ts';

export function runCommandEncoderTests(): void {
  assert.deepEqual([...encodeCommand('AA 55 00 ff', { encoding: 'hex' })], [0xAA, 0x55, 0x00, 0xFF]);
  assert.deepEqual([...encodeCommand('AA5500FF', { encoding: 'hex' })], [0xAA, 0x55, 0x00, 0xFF]);
  assert.throws(() => encodeCommand('AA 5', { encoding: 'hex' }), /完整字节/);
  assert.throws(() => encodeCommand('AA GG', { encoding: 'hex' }), /非法字符/);
  assert.deepEqual([...encodeCommand('STOP\\n', { encoding: 'text', escapeText: true })], [...new TextEncoder().encode('STOP\n')]);
  assert.deepEqual([...encodeCommand('STOP\\n', { encoding: 'text', escapeText: false })], [...new TextEncoder().encode('STOP\\n')]);
  assert.deepEqual([...encodeCommand('停止', { encoding: 'text' })], [...new TextEncoder().encode('停止')]);
  assert.deepEqual([...encodeCommand('GO', { encoding: 'text', appendNewline: true })], [...new TextEncoder().encode('GO\r\n')]);
  assert.deepEqual([...encodeCommand('GO\n', { encoding: 'text', appendNewline: true })], [...new TextEncoder().encode('GO\n')]);
  assert.deepEqual([...encodeCommand(' GO ', { encoding: 'text', appendNewline: true, lineEnding: 'lf' })], [...new TextEncoder().encode(' GO \n')]);
  assert.deepEqual([...encodeCommand('GO', { encoding: 'text', appendNewline: true, lineEnding: 'cr' })], [...new TextEncoder().encode('GO\r')]);
  assert.deepEqual([...encodeCommand('GO', { encoding: 'text', appendNewline: false, lineEnding: 'crlf' })], [...new TextEncoder().encode('GO')]);
  assert.deepEqual([...encodeCommand('AA 0A', { encoding: 'hex', appendNewline: true, lineEnding: 'crlf' })], [0xAA, 0x0A]);
}
