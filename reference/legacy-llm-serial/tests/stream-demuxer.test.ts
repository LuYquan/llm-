/**
 * 纯 TypeScript 流分流器 7 组黄金数据集验证测试
 * 100% 对齐 Rust 后端 src-tauri/tests/fixtures_verification.rs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamDemuxer, TextParser, TeleplotAligner } from '../src/services/transport/worker/stream-demuxer.ts';
import type { SamplePoint, LogLine } from '../src/types/ipc.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.resolve(__dirname, 'fixtures', 'stream');

let passedCount = 0;
let failedCount = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    failedCount++;
  }
}

/** 深度比对采样点数组 */
function assertSamplesMatch(actual: SamplePoint[], expectedVal: any) {
  const expSamples = expectedVal.samples;
  assert.equal(
    actual.length,
    expSamples.length,
    `Sample count mismatch: expected ${expSamples.length}, got ${actual.length}`
  );

  for (let i = 0; i < actual.length; i++) {
    const actS = actual[i];
    const expS = expSamples[i];
    const expVals = expS.values;

    assert.equal(
      actS.values.length,
      expVals.length,
      `Sample ${i} channel count mismatch: expected ${expVals.length}, got ${actS.values.length}`
    );

    for (let ch = 0; ch < expVals.length; ch++) {
      const act = actS.values[ch];
      const exp = expVals[ch];

      if (act !== null && act !== undefined && exp !== null && exp !== undefined) {
        assert.ok(
          Math.abs(act - exp) < 1e-4,
          `Sample ${i} channel ${ch} mismatch: expected ${exp}, got ${act}`
        );
      } else if ((act === null || act === undefined) && exp === null) {
        // 匹配 null 通道
      } else {
        assert.fail(
          `Sample ${i} channel ${ch} nullability mismatch: expected ${exp}, got ${act}`
        );
      }
    }
  }
}

/** 深度比对日志数组 */
function assertLogsMatch(actual: LogLine[], expectedVal: any) {
  const expLogs = expectedVal.logs;
  assert.equal(
    actual.length,
    expLogs.length,
    `Log count mismatch: expected ${expLogs.length}, got ${actual.length}`
  );

  for (let i = 0; i < actual.length; i++) {
    const actL = actual[i];
    const expL = expLogs[i];

    assert.equal(
      actL.text,
      expL.text,
      `Log ${i} text mismatch: expected ${expL.text}, got ${actL.text}`
    );
    assert.equal(
      actL.level,
      expL.level,
      `Log ${i} level mismatch: expected ${expL.level}, got ${actL.level}`
    );
  }
}

/** 深度比对统计摘要 */
function assertSummaryMatch(
  dirtyCounter: number,
  demuxErrorCount: number,
  actualSamplesLen: number,
  actualLogsLen: number,
  expectedVal: any
) {
  const summary = expectedVal.summary;
  if (summary.byte_dirty_count !== undefined) {
    assert.equal(dirtyCounter, summary.byte_dirty_count, 'byte_dirty_count mismatch');
  }
  if (summary.demux_error_count !== undefined) {
    assert.equal(demuxErrorCount, summary.demux_error_count, 'demux_error_count mismatch');
  }
  if (summary.sample_count !== undefined) {
    assert.equal(actualSamplesLen, summary.sample_count, 'sample_count mismatch');
  }
  if (summary.log_count !== undefined) {
    assert.equal(actualLogsLen, summary.log_count, 'log_count mismatch');
  }
}

export async function runStreamDemuxerTests() {
  console.log('\n--- 黄金数据集测试套件: 7 组端到端字节流解析比对 (对齐 Rust) ---');

  await test('Fixture 01: 纯 CSV 格式多通道数据流解析', () => {
    const rawBytes = fs.readFileSync(path.join(fixturesDir, '01_pure_csv.raw'));
    const expected = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, '01_pure_csv.expected.json'), 'utf-8')
    );

    const demuxer = new StreamDemuxer();
    const lines = demuxer.processBytes(new Uint8Array(rawBytes));

    assert.deepEqual(lines, expected.raw_lines);

    const samples: SamplePoint[] = [];
    const logs: LogLine[] = [];

    for (let idx = 0; idx < lines.length; idx++) {
      const ts = idx * 1000;
      const res = demuxer.demuxLine(lines[idx], ts, 'Rx');
      if (res.type === 'sample') samples.push(res.sample);
      else if (res.type === 'log') logs.push(res.log);
    }

    const flushed = demuxer.flush();
    if (flushed) samples.push(flushed);

    assertSamplesMatch(samples, expected);
    assertLogsMatch(logs, expected);
    assertSummaryMatch(
      demuxer.dirtyByteCount(),
      demuxer.errorCount(),
      samples.length,
      logs.length,
      expected
    );
  });

  await test('Fixture 02: Teleplot 键值对异步多变量微秒对齐与稀疏通道', () => {
    const rawBytes = fs.readFileSync(path.join(fixturesDir, '02_teleplot.raw'));
    const expected = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, '02_teleplot.expected.json'), 'utf-8')
    );

    const demuxer = new StreamDemuxer();
    const lines = demuxer.processBytes(new Uint8Array(rawBytes));

    assert.deepEqual(lines, expected.raw_lines);

    const samples: SamplePoint[] = [];
    const logs: LogLine[] = [];

    for (let idx = 0; idx < lines.length; idx++) {
      const ts = idx * 1000;
      const res = demuxer.demuxLine(lines[idx], ts, 'Rx');
      if (res.type === 'sample') samples.push(res.sample);
      else if (res.type === 'log') logs.push(res.log);
    }

    const flushed = demuxer.flush();
    if (flushed) samples.push(flushed);

    assert.deepEqual(demuxer.channelNames(), expected.channel_names);
    assertSamplesMatch(samples, expected);
    assertLogsMatch(logs, expected);
    assertSummaryMatch(
      demuxer.dirtyByteCount(),
      demuxer.errorCount(),
      samples.length,
      logs.length,
      expected
    );
  });

  await test('Fixture 03: CSV 数值波形与常规 printf 日志混合流', () => {
    const rawBytes = fs.readFileSync(path.join(fixturesDir, '03_csv_and_log_mixed.raw'));
    const expected = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, '03_csv_and_log_mixed.expected.json'), 'utf-8')
    );

    const demuxer = new StreamDemuxer();
    const lines = demuxer.processBytes(new Uint8Array(rawBytes));

    assert.deepEqual(lines, expected.raw_lines);

    const samples: SamplePoint[] = [];
    const logs: LogLine[] = [];

    for (let idx = 0; idx < lines.length; idx++) {
      const ts = idx * 1000;
      const res = demuxer.demuxLine(lines[idx], ts, 'Rx');
      if (res.type === 'sample') samples.push(res.sample);
      else if (res.type === 'log') logs.push(res.log);
    }

    const flushed = demuxer.flush();
    if (flushed) samples.push(flushed);

    assertSamplesMatch(samples, expected);
    assertLogsMatch(logs, expected);
    assertSummaryMatch(
      demuxer.dirtyByteCount(),
      demuxer.errorCount(),
      samples.length,
      logs.length,
      expected
    );
  });

  await test('Fixture 04: 半行截断跨 chunk 拼接与全量等价性', () => {
    const chunksJson = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, '04_chunk_boundary_half_line.chunks.json'), 'utf-8')
    );
    const expected = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, '04_chunk_boundary_half_line.expected.json'), 'utf-8')
    );

    const demuxer = new StreamDemuxer();
    const allExtractedLines: string[] = [];

    for (let stepIdx = 0; stepIdx < chunksJson.chunks.length; stepIdx++) {
      const chunkStr = chunksJson.chunks[stepIdx];
      const chunkBytes = new TextEncoder().encode(chunkStr);
      const extracted = demuxer.processBytes(chunkBytes);

      const expExtracted = expected.chunk_steps[stepIdx].extracted_lines;
      assert.deepEqual(extracted, expExtracted, `Chunk step ${stepIdx} extracted lines mismatch`);
      allExtractedLines.push(...extracted);
    }

    assert.equal(demuxer.dirtyByteCount(), 0);
    assert.deepEqual(allExtractedLines, expected.raw_lines);

    const samples: SamplePoint[] = [];
    const logs: LogLine[] = [];

    for (let idx = 0; idx < allExtractedLines.length; idx++) {
      const ts = idx * 1000;
      const res = demuxer.demuxLine(allExtractedLines[idx], ts, 'Rx');
      if (res.type === 'sample') samples.push(res.sample);
      else if (res.type === 'log') logs.push(res.log);
    }

    const flushed = demuxer.flush();
    if (flushed) samples.push(flushed);

    assertSamplesMatch(samples, expected);
    assertLogsMatch(logs, expected);
    assertSummaryMatch(
      demuxer.dirtyByteCount(),
      demuxer.errorCount(),
      samples.length,
      logs.length,
      expected
    );

    // 全量一次性灌入比对
    const rawBytes = fs.readFileSync(path.join(fixturesDir, '04_chunk_boundary_half_line.raw'));
    const oneshotDemuxer = new StreamDemuxer();
    const oneshotLines = oneshotDemuxer.processBytes(new Uint8Array(rawBytes));
    assert.deepEqual(
      allExtractedLines,
      oneshotLines,
      'Chunked vs oneshot line extraction must be identical'
    );
  });

  await test('Fixture 05: 非法 UTF-8 乱码、破损 CSV 与非法 Teleplot 容错', () => {
    const rawBytes = fs.readFileSync(path.join(fixturesDir, '05_invalid_utf8_and_corrupt.raw'));
    const expected = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, '05_invalid_utf8_and_corrupt.expected.json'), 'utf-8')
    );

    const demuxer = new StreamDemuxer();
    const lines = demuxer.processBytes(new Uint8Array(rawBytes));

    assert.equal(lines.length, expected.summary.valid_extracted_lines);

    const samples: SamplePoint[] = [];
    const logs: LogLine[] = [];

    for (let idx = 0; idx < lines.length; idx++) {
      const ts = idx * 1000;
      const res = demuxer.demuxLine(lines[idx], ts, 'Rx');
      if (res.type === 'sample') samples.push(res.sample);
      else if (res.type === 'log') logs.push(res.log);
    }

    assertSamplesMatch(samples, expected);
    assertLogsMatch(logs, expected);
    assertSummaryMatch(
      demuxer.dirtyByteCount(),
      demuxer.errorCount(),
      samples.length,
      logs.length,
      expected
    );
  });

  await test('Fixture 06: 超长行防护 (>64KiB 丢弃至真实换行后恢复)', () => {
    const chunksJson = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, '06_overlong_line_protection.chunks.json'), 'utf-8')
    );
    const expected = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, '06_overlong_line_protection.expected.json'), 'utf-8')
    );

    const chunk0Len = chunksJson.chunks[0].length;
    const chunk0Byte = chunksJson.chunks[0].repeat_byte;
    const chunk0 = new Uint8Array(chunk0Len);
    chunk0.fill(chunk0Byte);

    const chunk1Text = chunksJson.chunks[1].text;
    const chunk1 = new TextEncoder().encode(chunk1Text);

    const demuxer = new StreamDemuxer();

    // 阶段 1：注入超过 64 KiB 的无换行数据块
    const lines1 = demuxer.processBytes(chunk0);
    assert.equal(lines1.length, 0, '超长无换行数据不应产生有效行');
    assert.equal(demuxer.dirtyByteCount(), 1, '超过 64KiB 应计入 1 次 dirtyByteCount');

    // 阶段 2：真实换行结束超长行，再到达独立正常行
    const lines2 = demuxer.processBytes(chunk1);
    assert.equal(lines2.length, 1, '超长行完成重新同步后应成功提取独立正常行');
    assert.equal(lines2[0], '10.0,20.0,30.0');

    const samples: SamplePoint[] = [];
    const logs: LogLine[] = [];

    for (let idx = 0; idx < lines2.length; idx++) {
      const ts = idx * 1000;
      const res = demuxer.demuxLine(lines2[idx], ts, 'Rx');
      if (res.type === 'sample') samples.push(res.sample);
      else if (res.type === 'log') logs.push(res.log);
    }

    assertSamplesMatch(samples, expected);
    assertLogsMatch(logs, expected);
    assertSummaryMatch(
      demuxer.dirtyByteCount(),
      demuxer.errorCount(),
      samples.length,
      logs.length,
      expected
    );
  });

  await test('Fixture 07: Windows CRLF (\\r\\n) 与 Unix LF (\\n) 混合行尾符号解析', () => {
    const rawBytes = fs.readFileSync(path.join(fixturesDir, '07_line_endings_mixed.raw'));
    const expected = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, '07_line_endings_mixed.expected.json'), 'utf-8')
    );

    assert.equal(rawBytes.length, 130, '07_line_endings_mixed.raw 必须为严格混合的 130 字节');

    const demuxer = new StreamDemuxer();
    const lines = demuxer.processBytes(new Uint8Array(rawBytes));

    assert.deepEqual(lines, expected.raw_lines);
    for (const l of lines) {
      assert.ok(!l.endsWith('\r'), `Line must not end with \\r: ${l}`);
      assert.ok(!l.endsWith('\n'), `Line must not end with \\n: ${l}`);
    }

    const samples: SamplePoint[] = [];
    const logs: LogLine[] = [];

    for (let idx = 0; idx < lines.length; idx++) {
      const ts = idx * 1000;
      const res = demuxer.demuxLine(lines[idx], ts, 'Rx');
      if (res.type === 'sample') samples.push(res.sample);
      else if (res.type === 'log') logs.push(res.log);
    }

    const flushed = demuxer.flush();
    if (flushed) samples.push(flushed);

    assertSamplesMatch(samples, expected);
    assertLogsMatch(logs, expected);
    assertSummaryMatch(
      demuxer.dirtyByteCount(),
      demuxer.errorCount(),
      samples.length,
      logs.length,
      expected
    );
  });

  console.log(`\n========================================`);
  console.log(`黄金数据集测试完成: ${passedCount} 通过, ${failedCount} 失败`);
  console.log(`========================================\n`);

  if (failedCount > 0) {
    process.exit(1);
  }
}
