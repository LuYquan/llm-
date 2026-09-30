/**
 * 协议引擎单元测试 (ProtocolEngine Test Suite)
 * 覆盖 VOFA+ 官方 RawData / FireWater / JustFloat 及自定义帧协议
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ProtocolEngine,
  RawDataParser,
  FireWaterParser,
  JustFloatParser,
  CustomFrameParser,
  createProtocolEngine,
  validateProtocolConfig,
} from '../src/core/protocol';

interface BinaryProtocolFixture {
  name: string;
  config: Parameters<typeof createProtocolEngine>[0];
  chunks: number[][];
  expected: {
    frames: number[][];
    droppedBytes: number;
    errorCount: number;
  };
}

export async function runProtocolEngineTests() {
  console.log('--- [ProtocolEngine] 开始测试协议引擎与 VOFA+ 官方协议解析 ---');

  // 1. RawData 解析器测试
  {
    console.log('  1. 测试 RawData 解析器 (u8 / i16le / f32le / 多通道与分包)');
    const parserU8 = new RawDataParser({ format: 'u8', channels: 2 });
    const res1 = parserU8.feed(new Uint8Array([10, 20, 30, 40, 50])); // 5 个字节，只能成 2 帧 (4 字节)，剩 1 字节
    assert.equal(res1.frames.length, 2);
    assert.deepEqual(res1.frames[0].values, [10, 20]);
    assert.deepEqual(res1.frames[1].values, [30, 40]);

    // 分包追加后 1 字节补齐
    const res2 = parserU8.feed(new Uint8Array([60]));
    assert.equal(res2.frames.length, 1);
    assert.deepEqual(res2.frames[0].values, [50, 60]);

    // f32le 模式
    const parserF32 = new RawDataParser({ format: 'f32le', channels: 1 });
    const floatBuf = new Uint8Array(8);
    const view = new DataView(floatBuf.buffer);
    view.setFloat32(0, 3.14159, true);
    view.setFloat32(4, 2.71828, true);
    const resF32 = parserF32.feed(floatBuf);
    assert.equal(resF32.frames.length, 2);
    assert.ok(Math.abs(resF32.frames[0].values[0] - 3.14159) < 1e-4);
    assert.ok(Math.abs(resF32.frames[1].values[0] - 2.71828) < 1e-4);

    const nonFinite = new Uint8Array(4);
    new DataView(nonFinite.buffer).setFloat32(0, Number.NaN, true);
    const nonFiniteResult = parserF32.feed(nonFinite);
    assert.equal(nonFiniteResult.frames.length, 0);
    assert.equal(nonFiniteResult.droppedBytes, 4);
    assert.equal(nonFiniteResult.errorCount, 1);
  }

  // 2. FireWater 解析器测试
  {
    console.log('  2. 测试 FireWater 文本 CSV 与 Teleplot 解析器');
    const parser = new FireWaterParser();

    // 标准 CSV 数值行
    const input1 = new TextEncoder().encode('10.5, 20.3, -30.25\r\n40.1, 50.2, 60.3\n');
    const res1 = parser.feed(input1);
    assert.equal(res1.frames.length, 2);
    assert.deepEqual(res1.frames[0].values, [10.5, 20.3, -30.25]);
    assert.deepEqual(res1.frames[1].values, [40.1, 50.2, 60.3]);
    assert.equal(res1.logs.length, 0);

    // 科学计数法支持
    const inputSci = new TextEncoder().encode('1.2e-3, 4.5e2\n');
    const resSci = parser.feed(inputSci);
    assert.equal(resSci.frames.length, 1);
    assert.ok(Math.abs(resSci.frames[0].values[0] - 0.0012) < 1e-6);
    assert.equal(resSci.frames[0].values[1], 450);

    // Teleplot 行测试
    const inputTele = new TextEncoder().encode('>speed: 120.5\n>voltage: 24.2\n');
    const resTele = parser.feed(inputTele);
    assert.equal(resTele.frames.length, 2);
    assert.deepEqual(resTele.frames[0].values, [120.5]);
    assert.deepEqual(resTele.frames[0].channelNames, ['speed']);
    assert.deepEqual(resTele.frames[1].values, [24.2]);
    assert.deepEqual(resTele.frames[1].channelNames, ['voltage']);

    // 文本日志分离 (包括 [INFO]、带逗号的系统日志与注释行)
    const inputLogs = new TextEncoder().encode(
      '[INFO] System booted, 3 sensors found\n# Calibration done\n// Debug message\nERROR: Motor stalled\n'
    );
    const resLogs = parser.feed(inputLogs);
    assert.equal(resLogs.frames.length, 0);
    assert.equal(resLogs.logs.length, 4);
    assert.equal(resLogs.logs[0].level, 'Info');
    assert.equal(resLogs.logs[3].level, 'Error');

    // 流式切片断行测试 (两段拼合一行)
    const part1 = new TextEncoder().encode('100.1, 20');
    const part2 = new TextEncoder().encode('0.2, 300.3\n');
    const resP1 = parser.feed(part1);
    assert.equal(resP1.frames.length, 0);
    const resP2 = parser.feed(part2);
    assert.equal(resP2.frames.length, 1);
    assert.deepEqual(resP2.frames[0].values, [100.1, 200.2, 300.3]);
  }

  // 3. JustFloat 解析器测试 (VOFA+ 官方协议格式: 32位小端浮点数 + 0x00,0x00,0x80,0x7F 尾帧)
  {
    console.log('  3. 测试 JustFloat 二进制协议解析器 (小端 float32 + 00 00 80 7f 尾帧)');
    const parser = new JustFloatParser();

    // 构造包含 3 个浮点通道的合法帧 [1.5, 2.5, 3.5] + Tail
    const buf = new Uint8Array(3 * 4 + 4);
    const view = new DataView(buf.buffer);
    view.setFloat32(0, 1.5, true);
    view.setFloat32(4, 2.5, true);
    view.setFloat32(8, 3.5, true);
    // 尾帧 00 00 80 7f
    buf[12] = 0x00;
    buf[13] = 0x00;
    buf[14] = 0x80;
    buf[15] = 0x7f;

    const res1 = parser.feed(buf);
    assert.equal(res1.frames.length, 1);
    assert.equal(res1.frames[0].values.length, 3);
    assert.equal(res1.frames[0].values[0], 1.5);
    assert.equal(res1.frames[0].values[1], 2.5);
    assert.equal(res1.frames[0].values[2], 3.5);

    // 测试流式逐字节断包喂入 (1 字节喂一次)
    const parserByteByByte = new JustFloatParser();
    let collectedFrames: any[] = [];
    for (let i = 0; i < buf.length; i++) {
      const out = parserByteByByte.feed(buf.subarray(i, i + 1));
      if (out.frames.length > 0) {
        collectedFrames.push(...out.frames);
      }
    }
    assert.equal(collectedFrames.length, 1);
    assert.deepEqual(collectedFrames[0].values, [1.5, 2.5, 3.5]);

    // 测试前导脏字节容错与自动重新同步
    const dirtyBuf = new Uint8Array(2 + buf.length);
    dirtyBuf[0] = 0xee; // 脏字节
    dirtyBuf[1] = 0xff; // 脏字节
    dirtyBuf.set(buf, 2);

    const resDirty = parser.feed(dirtyBuf);
    assert.equal(resDirty.frames.length, 1);
    assert.deepEqual(resDirty.frames[0].values, [1.5, 2.5, 3.5]);
    assert.equal(resDirty.droppedBytes, 2);
    assert.equal(resDirty.errorCount, 1);

    const parserFixed = new JustFloatParser({ channels: 2 });
    const fixedFrame = new Uint8Array(3 * 4 + 4);
    const fixedView = new DataView(fixedFrame.buffer);
    fixedView.setFloat32(0, 1, true);
    fixedView.setFloat32(4, 2, true);
    fixedView.setFloat32(8, 3, true);
    fixedFrame.set([0, 0, 0x80, 0x7f], 12);
    const fixedResult = parserFixed.feed(fixedFrame);
    assert.deepEqual(fixedResult.frames[0].values, [2, 3]);
    assert.equal(fixedResult.droppedBytes, 4);
    assert.equal(fixedResult.errorCount, 1);

    const justFloatNaN = new Uint8Array(8);
    new DataView(justFloatNaN.buffer).setFloat32(0, Number.NaN, true);
    justFloatNaN.set([0, 0, 0x80, 0x7f], 4);
    const nanResult = new JustFloatParser().feed(justFloatNaN);
    assert.equal(nanResult.frames.length, 0);
    assert.equal(nanResult.droppedBytes, 4);
    assert.equal(nanResult.errorCount, 1);
  }

  // 4. 自定义帧解析器测试 (含 CRC16-CCITT 与溢出防御)
  {
    console.log('  4. 测试 CustomFrame 解析器 (Header 0xAA 0x55 + 2通道 int16le + Sum8 / CCITT 校验)');
    const custom = new CustomFrameParser({
      header: [0xaa, 0x55],
      channels: 2,
      dataType: 'i16le',
      checksum: 'sum8',
    });

    // 构造帧: AA 55 | [1000: E8 03] [-500: 0C FE] | Sum8
    // Checksum 计算: 0xE8 + 0x03 + 0x0C + 0xFE = 0x1F5 -> 0xF5
    const frame = new Uint8Array([0xaa, 0x55, 0xe8, 0x03, 0x0c, 0xfe, 0xf5]);
    const res = custom.feed(frame);
    assert.equal(res.frames.length, 1);
    assert.deepEqual(res.frames[0].values, [1000, -500]);

    // CCITT CRC16 校验测试
    const customCcitt = new CustomFrameParser({
      header: [0x55, 0xaa],
      channels: 1,
      dataType: 'u16le',
      checksum: 'crc16_ccitt',
    });
    // Payload: [0x12, 0x34].
    // CRC16-CCITT of [0x12, 0x34]:
    // byte 0: 0x12 -> crc = 0x8b32
    // byte 1: 0x34 -> crc = 0xdf84
    // little endian check bytes: 0x84, 0xdf
    // Let's verify by testing parser
    const payload = new Uint8Array([0x12, 0x34]);
    // Calculate expected:
    let expectedCrc = 0x0000;
    for (let i = 0; i < payload.length; i++) {
      expectedCrc ^= (payload[i] << 8) & 0xffff;
      for (let j = 0; j < 8; j++) {
        if (expectedCrc & 0x8000) {
          expectedCrc = ((expectedCrc << 1) ^ 0x1021) & 0xffff;
        } else {
          expectedCrc = (expectedCrc << 1) & 0xffff;
        }
      }
    }
    const ccittFrame = new Uint8Array([
      0x55, 0xaa,
      0x12, 0x34,
      expectedCrc & 0xff, (expectedCrc >> 8) & 0xff,
    ]);
    const resCcitt = customCcitt.feed(ccittFrame);
    assert.equal(resCcitt.frames.length, 1);
    assert.deepEqual(resCcitt.frames[0].values, [0x3412]);

    // u32le 与 u32be 自定义帧解析测试
    const customU32 = new CustomFrameParser({
      header: [0x5a, 0xa5],
      channels: 2,
      dataType: 'u32le',
    });
    const u32Buf = new Uint8Array(2 + 8);
    u32Buf[0] = 0x5a;
    u32Buf[1] = 0xa5;
    const u32View = new DataView(u32Buf.buffer);
    u32View.setUint32(2, 3000000000, true);
    u32View.setUint32(6, 12345678, true);
    const resU32 = customU32.feed(u32Buf);
    assert.equal(resU32.frames.length, 1);
    assert.deepEqual(resU32.frames[0].values, [3000000000, 12345678]);

    const customU32Be = new CustomFrameParser({
      header: [0x5a, 0xa5],
      channels: 1,
      dataType: 'u32be',
    });
    const u32BeBuf = new Uint8Array(2 + 4);
    u32BeBuf[0] = 0x5a;
    u32BeBuf[1] = 0xa5;
    const u32BeView = new DataView(u32BeBuf.buffer);
    u32BeView.setUint32(2, 4000000000, false);
    const resU32Be = customU32Be.feed(u32BeBuf);
    assert.equal(resU32Be.frames.length, 1);
    assert.deepEqual(resU32Be.frames[0].values, [4000000000]);

    // Shared Rust/Web config fixture semantics: CCITT over payload, big-endian check bytes.
    const configured = createProtocolEngine({
      type: 'custom',
      header: [0xaa, 0x55],
      tail: [0x0d, 0x0a],
      channels: 2,
      dataType: 'i16le',
      checksum: 'crc16_ccitt',
      checksumByteOrder: 'big',
    });
    const sharedPayload = new Uint8Array([1, 0, 0xfe, 0xff]);
    let sharedCrc = 0;
    for (const byte of sharedPayload) {
      sharedCrc ^= byte << 8;
      for (let bit = 0; bit < 8; bit++) {
        sharedCrc = sharedCrc & 0x8000 ? ((sharedCrc << 1) ^ 0x1021) & 0xffff : (sharedCrc << 1) & 0xffff;
      }
    }
    const sharedFrame = new Uint8Array([0xaa, 0x55, ...sharedPayload, sharedCrc >> 8, sharedCrc & 0xff, 0x0d, 0x0a]);
    const sharedOutput = { frames: [] as number[][] };
    for (const byte of sharedFrame) {
      sharedOutput.frames.push(...configured.feed(new Uint8Array([byte])).frames.map((frame) => frame.values));
    }
    assert.deepEqual(sharedOutput.frames, [[1, -2]]);
    assert.equal(validateProtocolConfig({
      type: 'custom', header: [0xaa], tail: [], channels: 1, dataType: 'f64le',
      checksum: 'crc16_modbus', checksumByteOrder: 'little',
    }), null);
    assert.notEqual(validateProtocolConfig({ type: 'custom', header: [], tail: [], channels: 1, dataType: 'i16le', checksum: 'none', checksumByteOrder: 'little' }), null);

    // FireWater 末尾多余逗号容错测试 (printf("%f,%f,\n"))
    const fwParser = new FireWaterParser();
    const resTrailing = fwParser.feed(new TextEncoder().encode('10.5, 20.3,\r\n'));
    assert.equal(resTrailing.frames.length, 1);
    assert.deepEqual(resTrailing.frames[0].values, [10.5, 20.3]);
  }

  // 5. ProtocolEngine 门面总控与热切换
  {
    console.log('  5. 测试 ProtocolEngine 门面总控调度与热切换');
    const engine = new ProtocolEngine('firewater');
    assert.equal(engine.getProtocol(), 'firewater');

    const resFw = engine.feed(new TextEncoder().encode('1.1, 2.2\n'));
    assert.equal(resFw.frames.length, 1);
    assert.deepEqual(resFw.frames[0].values, [1.1, 2.2]);

    // 热切换至 justfloat
    engine.setProtocol('justfloat');
    assert.equal(engine.getProtocol(), 'justfloat');

    const jfBuf = new Uint8Array(8);
    const view = new DataView(jfBuf.buffer);
    view.setFloat32(0, 99.5, true);
    jfBuf[4] = 0x00;
    jfBuf[5] = 0x00;
    jfBuf[6] = 0x80;
    jfBuf[7] = 0x7f;

    const resJf = engine.feed(jfBuf);
    assert.equal(resJf.frames.length, 1);
    assert.equal(resJf.frames[0].values[0], 99.5);

    const stats = engine.getStats();
    assert.equal(stats.totalFrames, 2);
  }

  // 6. Rust/Web 共享二进制黄金样本：同一组分块和诊断计数必须完全一致
  {
    const fixtures = JSON.parse(
      readFileSync(new URL('./fixtures/binary-protocol.json', import.meta.url), 'utf8'),
    ) as BinaryProtocolFixture[];
    assert.ok(fixtures.length > 0);
    for (const fixture of fixtures) {
      const engine = createProtocolEngine(fixture.config);
      const frames: number[][] = [];
      let droppedBytes = 0;
      let errorCount = 0;
      for (const chunk of fixture.chunks) {
        const output = engine.feed(new Uint8Array(chunk), 1_000);
        frames.push(...output.frames.map((frame) => frame.values));
        droppedBytes += output.droppedBytes;
        errorCount += output.errorCount;
      }
      assert.deepEqual(frames, fixture.expected.frames, `${fixture.name} frame mismatch`);
      assert.equal(droppedBytes, fixture.expected.droppedBytes, `${fixture.name} dropped-byte mismatch`);
      assert.equal(errorCount, fixture.expected.errorCount, `${fixture.name} error-count mismatch`);
    }
    console.log('  ✓ Rust/Web 共享二进制黄金样本与分块解析结果一致');
  }

  console.log('  ✓ [ProtocolEngine] 所有协议解析器与 VOFA+ 官方格式测试全部通过！\n');
}
