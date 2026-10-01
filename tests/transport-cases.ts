/**
 * 串口传输抽象层 (TransportAdapter) 深度单元测试实现
 * 覆盖: TransportError, UnsupportedTransport, TransportFactory, TauriTransport, useSerialSession
 */

import assert from 'node:assert/strict';
import {
  TransportError,
  type TransportStatus,
  type SerialOpenOptions,
  type ParsedBatch,
} from '../src/services/transport/types.ts';
import { UnsupportedTransport } from '../src/services/transport/unsupported-transport.ts';
import { TransportFactory } from '../src/services/transport/factory.ts';
import { TauriTransport } from '../src/services/transport/tauri-transport.ts';
import { useSerialSession, resetSession, stripPersistedSecrets } from '../src/services/transport/session.ts';
import type { WaveformBatch, SerialStatusEvent } from '../src/types/ipc.ts';

// 简单测试断言套件
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

export async function runTransportTests() {
  await test('普通持久化配置会递归移除 API Key，且不修改运行时对象', () => {
    const runtimeConfig = {
      ai_config: { api_key: 'sk-session-only', api_key_configured: true, provider: 'custom' },
      nested: [{ ApiKey: 'case-insensitive', value: 1 }],
      headers: {
        Authorization: 'Bearer bearer-secret',
        access_token: 'access-secret',
        refreshToken: 'refresh-secret',
        token_count: 3,
      },
    };
    const persisted = stripPersistedSecrets(runtimeConfig);
    assert.deepEqual(persisted, {
      ai_config: { api_key_configured: true, provider: 'custom' },
      nested: [{ value: 1 }],
      headers: { token_count: 3 },
    });
    assert.equal(runtimeConfig.ai_config.api_key, 'sk-session-only');
  });

  await test('Web 工作区保存不会把 API Key 写入 localStorage', async () => {
    const previousWindow = (globalThis as any).window;
    const previousStorage = (globalThis as any).localStorage;
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    (globalThis as any).window = {};
    (globalThis as any).localStorage = storage;
    try {
      const session = useSerialSession();
      const runtimeConfig = { ai_config: { api_key: 'sk-web-memory-only', provider: 'custom' } };
      await session.saveAppConfig(runtimeConfig);
      const serialized = values.get('llm_serial_app_config') || '';
      assert.equal(serialized.includes('sk-web-memory-only'), false);
      assert.equal(runtimeConfig.ai_config.api_key, 'sk-web-memory-only');
      assert.deepEqual(await session.loadAppConfig(), { ai_config: { provider: 'custom', api_key_configured: false } });
      const configuredRuntime = { ai_config: { api_key: 'sk-web-session', api_key_configured: true, provider: 'custom' } };
      await session.saveAppConfig(configuredRuntime);
      const configuredReload = await session.loadAppConfig();
      assert.equal(configuredReload?.ai_config?.api_key_configured, false);
      assert.equal(configuredReload?.ai_config?.api_key, undefined);
    } finally {
      if (previousWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = previousWindow;
      if (previousStorage === undefined) delete (globalThis as any).localStorage;
      else (globalThis as any).localStorage = previousStorage;
    }
  });

  console.log('\n--- 单元测试套件 1: TransportError 契约与错误码映射 ---');

  await test('TransportError 应当正确保留 code、message 与 originalError', () => {
    const rawErr = new Error('底座错误');
    const err = new TransportError('串口已被占用', 'PortBusy', rawErr);

    assert.equal(err.name, 'TransportError');
    assert.equal(err.message, '串口已被占用');
    assert.equal(err.code, 'PortBusy');
    assert.equal(err.originalError, rawErr);
    assert.ok(err instanceof Error);
    assert.ok(err instanceof TransportError);
  });

  await test('TransportError 默认错误码为 Unknown', () => {
    const err = new TransportError('未定义错误');
    assert.equal(err.code, 'Unknown');
    assert.equal(err.originalError, undefined);
  });

  await test('TauriTransport.mapToTransportError 能够覆盖全部错误码映射分支', () => {
    const transport = new TauriTransport();
    const mapFn = (transport as any).mapToTransportError.bind(transport);

    assert.equal(mapFn('COM3 Access is denied (os error 5)').code, 'PortBusy');
    assert.equal(mapFn('端口已经被占用').code, 'PortBusy');
    assert.equal(mapFn('Permission denied to open serial device').code, 'PermissionDenied');
    assert.equal(mapFn('用户权限不足，权限被拒绝').code, 'PermissionDenied');
    assert.equal(mapFn('系统找不到指定的文件').code, 'PortNotFound');
    assert.equal(mapFn('Device not found').code, 'PortNotFound');
    assert.equal(mapFn('读取数据超时 Timeout').code, 'Timeout');
    assert.equal(mapFn('串口设备已拔出').code, 'DeviceLost');
    assert.equal(mapFn('device lost during transmission').code, 'DeviceLost');
    assert.equal(mapFn('环形缓冲区溢出 BufferOverflow').code, 'BufferOverflow');
    assert.equal(mapFn('奇偶校验错误 ParityError').code, 'ParityError');
    assert.equal(mapFn('串口帧错误 Framing error').code, 'FramingError');
    assert.equal(mapFn('端口已经连接，请勿重复操作').code, 'AlreadyConnected');
    assert.equal(mapFn('串口未连接或管线未启动').code, 'NotConnected');
    assert.equal(mapFn('当前运行环境不支持该特性').code, 'NotSupported');
    assert.equal(mapFn('其他未知故障').code, 'Unknown');
  });

  console.log('\n--- 单元测试套件 2: UnsupportedTransport 降级驱动 ---');

  await test('UnsupportedTransport 具备正确的 kind 与 capabilities', () => {
    const transport = new UnsupportedTransport('测试原因');
    assert.equal(transport.kind, 'webserial');
    assert.deepEqual(transport.capabilities, {
      canEnumerateAllPorts: false,
      requiresUserGestureToAddPort: true,
      globalEmergencyStop: false,
      fileSystemLogging: false,
    });
    assert.equal(transport.getReason(), '测试原因');
  });

  await test('UnsupportedTransport 调用 listPorts 应当返回空数组', async () => {
    const transport = new UnsupportedTransport();
    const ports = await transport.listPorts();
    assert.deepEqual(ports, []);
  });

  await test('UnsupportedTransport 执行 connect / write / emergencyStop 均抛出 NotSupported 错误', async () => {
    const transport = new UnsupportedTransport('环境不支持');

    await assert.rejects(
      async () => {
        await transport.connect('COM1', { baudRate: 115200 });
      },
      (err: any) => {
        return err instanceof TransportError && err.code === 'NotSupported';
      }
    );

    await assert.rejects(
      async () => {
        await transport.write(new Uint8Array([0x01, 0x02]));
      },
      (err: any) => {
        return err instanceof TransportError && err.code === 'NotSupported';
      }
    );

    await assert.rejects(
      async () => {
        await transport.emergencyStop(new Uint8Array([0xff]));
      },
      (err: any) => {
        return err instanceof TransportError && err.code === 'NotSupported';
      }
    );
  });

  await test('UnsupportedTransport.onStatusChange 会异步推送一次 error 状态', async () => {
    const transport = new UnsupportedTransport();
    let receivedStatus: TransportStatus | null = null;
    transport.onStatusChange((s) => {
      receivedStatus = s;
    });

    // 等待 setTimeout 执行
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(receivedStatus, 'error');
  });

  await test('UnsupportedTransport.onStatusChange 立即退订不会触发回调 (防泄漏与幽灵回调)', async () => {
    const transport = new UnsupportedTransport();
    let called = false;
    const unsub = transport.onStatusChange(() => {
      called = true;
    });
    unsub();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(called, false);
  });

  console.log('\n--- 单元测试套件 3: TransportFactory 宿主嗅探与动态加载 ---');

  await test('在非 Tauri 非 WebSerial 环境下，TransportFactory.create() 返回 UnsupportedTransport', async () => {
    const transport = await TransportFactory.create();
    assert.ok(transport instanceof UnsupportedTransport);
  });

  await test('TransportFactory.isTauri() 与 isWebSerialSupported() 在 Node 环境下为 false', () => {
    assert.equal(TransportFactory.isTauri(), false);
    assert.equal(TransportFactory.isWebSerialSupported(), false);
  });

  console.log('\n--- 单元测试套件 4: TauriTransport 接口实现与核心逻辑 ---');

  await test('TauriTransport 具备正确的 kind 与桌面端 capabilities', () => {
    const transport = new TauriTransport();
    assert.equal(transport.kind, 'tauri');
    assert.deepEqual(transport.capabilities, {
      canEnumerateAllPorts: true,
      requiresUserGestureToAddPort: false,
      globalEmergencyStop: true,
      fileSystemLogging: true,
    });
    assert.equal(transport.getCurrentStatus(), 'idle');
    assert.equal(transport.getConnectedPortId(), null);
  });

  await test('TauriTransport 未连接时调用 write 应当抛出 NotConnected 错误', async () => {
    const transport = new TauriTransport();
    await assert.rejects(
      async () => {
        await transport.write(new Uint8Array([1, 2, 3]));
      },
      (err: any) => {
        return err instanceof TransportError && err.code === 'NotConnected';
      }
    );
  });

  await test('TauriTransport 未连接时仍执行本地软件停止并调用停止屏障命令', async () => {
    const transport = new TauriTransport();
    await assert.rejects(
      async () => {
        await transport.emergencyStop(new Uint8Array([0xaa, 0xbb]));
      },
      (err: any) => {
        return err instanceof TransportError;
      }
    );
  });

  await test('TauriTransport.onBatch 能够按严格时间升序接收并转换波形批次', async () => {
    const transport = new TauriTransport();
    let receivedBatch: ParsedBatch | null = null;
    (transport as any).handleSerialStatus({
      is_connected: true,
      port: 'COM-test',
      session_id: 'test_sess',
      channel_epoch: 1,
      error: null,
    } satisfies SerialStatusEvent);

    const unsub = transport.onBatch((batch) => {
      receivedBatch = batch;
    });

    const mockWaveform: WaveformBatch = {
      session_id: 'test_sess',
      channel_epoch: 1,
      channel_names: ['setpoint', 'actual'],
      points: [],
      timestamps: [0.01, 0.02],
      series: [
        [10.0, 10.0],
        [9.5, 9.8],
      ],
    };

    // 触发内部波形批次处理
    (transport as any).handleWaveformBatch(mockWaveform);

    assert.ok(receivedBatch);
    assert.equal((receivedBatch as ParsedBatch).samples.length, 4);
    // 严格时序单调递增：t=0.01 先输出，随后为 t=0.02
    assert.deepEqual((receivedBatch as ParsedBatch).samples[0], {
      channel: 'setpoint',
      t: 0.01,
      v: 10.0,
    });
    assert.deepEqual((receivedBatch as ParsedBatch).samples[1], {
      channel: 'actual',
      t: 0.01,
      v: 9.5,
    });
    assert.deepEqual((receivedBatch as ParsedBatch).samples[2], {
      channel: 'setpoint',
      t: 0.02,
      v: 10.0,
    });
    assert.deepEqual((receivedBatch as ParsedBatch).samples[3], {
      channel: 'actual',
      t: 0.02,
      v: 9.8,
    });

    unsub();
    receivedBatch = null;
    (transport as any).handleWaveformBatch(mockWaveform);
    // 退订后不再触发
    assert.equal(receivedBatch, null);
  });

  await test('TauriTransport 丢弃旧会话和旧协议代次的在途波形批次', () => {
    const transport = new TauriTransport();
    let received = 0;
    transport.onWaveformBatch(() => { received += 1; });
    (transport as any).handleSerialStatus({
      is_connected: true,
      port: 'COM-new',
      session_id: 'new-session',
      channel_epoch: 8,
      error: null,
    } satisfies SerialStatusEvent);
    const batch: WaveformBatch = {
      session_id: 'new-session',
      channel_epoch: 8,
      channel_names: ['actual'],
      points: [],
      timestamps: [1],
      series: [[2]],
    };

    (transport as any).handleWaveformBatch({ ...batch, session_id: 'old-session' });
    (transport as any).handleWaveformBatch({ ...batch, channel_epoch: 7 });
    (transport as any).handleWaveformBatch({ ...batch, channel_epoch: 9 });
    assert.equal(received, 0);

    (transport as any).handleWaveformBatch(batch);
    assert.equal(received, 1);
    (transport as any).handleProtocolApplied(9);
    (transport as any).handleWaveformBatch(batch);
    assert.equal(received, 1);
    (transport as any).handleWaveformBatch({ ...batch, channel_epoch: 9 });
    assert.equal(received, 2);

    (transport as any).handleSerialStatus({
      is_connected: false,
      port: 'COM-new',
      session_id: 'new-session',
      channel_epoch: 9,
      error: null,
    } satisfies SerialStatusEvent);
    (transport as any).handleWaveformBatch({ ...batch, channel_epoch: 9 });
    assert.equal(received, 2);
  });

  await test('TauriTransport 丢弃旧会话和旧协议代次的写入回执', () => {
    const transport = new TauriTransport();
    const received: string[] = [];
    transport.onWriteResult((result) => received.push(result.request_id));
    (transport as any).handleSerialStatus({
      is_connected: true,
      port: 'COM-write',
      session_id: 'write-session',
      channel_epoch: 3,
      error: null,
    } satisfies SerialStatusEvent);
    const valid = {
      request_id: 'valid',
      session_id: 'write-session',
      epoch: 3,
      source: 'terminal',
      status: 'written',
      requested_bytes: 2,
      written_bytes: 2,
    } as const;
    (transport as any).handleWriteResult({ ...valid, session_id: 'old-session', request_id: 'old-session' });
    (transport as any).handleWriteResult({ ...valid, epoch: 2, request_id: 'old-epoch' });
    (transport as any).handleWriteResult(valid);
    assert.deepEqual(received, ['valid']);
  });

  await test('TauriTransport 不会把格式化日志伪装成原始接收字节', async () => {
    const transport = new TauriTransport();
    let receivedLogCount = 0;
    transport.onLogsBatch(() => { receivedLogCount += 1; });

    const mockLogs = [
      {
        timestamp_us: 1000,
        direction: 'Rx' as const,
        level: 'Data' as const,
        text: '01 03 00 01',
        raw_hex: '01 03 00 01',
      },
    ];

    (transport as any).handleLogsBatch(mockLogs);

    assert.equal(receivedLogCount, 1);
    assert.equal(transport.onRawData, undefined);
  });

  await test('TauriTransport.onBatch 能够正确接收并转换日志批次', async () => {
    const transport = new TauriTransport();
    let receivedBatch: ParsedBatch | null = null;

    transport.onBatch((batch) => {
      receivedBatch = batch;
    });

    const mockLogs = [
      {
        timestamp_us: 1500000,
        direction: 'Rx' as const,
        level: 'Info' as const,
        text: 'PID controller init OK',
        rx_origin: { source: 'serial-read' as const, session_id: 'native-test', epoch: 2, first_rx_sequence: 7, last_rx_sequence: 8 },
      },
    ];

    (transport as any).handleLogsBatch(mockLogs);

    assert.ok(receivedBatch);
    assert.equal((receivedBatch as ParsedBatch).samples.length, 0);
    assert.equal((receivedBatch as ParsedBatch).logLines.length, 1);
    assert.equal((receivedBatch as ParsedBatch).logLines[0].text, 'PID controller init OK');
    assert.equal((receivedBatch as ParsedBatch).logLines[0].t, 1.5);
    assert.deepEqual((receivedBatch as ParsedBatch).logLines[0].rx_origin, mockLogs[0].rx_origin,
      'generic native log subscribers retain the actual cross-chunk receive identity');
  });

  await test('TauriTransport.handleSerialStatus 正确驱动状态流转', async () => {
    const transport = new TauriTransport();
    const statusHistory: TransportStatus[] = [];

    transport.onStatusChange((s) => {
      statusHistory.push(s);
    });

    // 初始状态已推入
    assert.equal(statusHistory[0], 'idle');

    // 收到连接状态
    const connectedEvent: SerialStatusEvent = {
      is_connected: true,
      port: 'COM3',
      session_id: 'sess_1',
      channel_epoch: 1,
      error: null,
    };
    (transport as any).handleSerialStatus(connectedEvent);
    assert.equal(transport.getCurrentStatus(), 'connected');
    assert.equal(transport.getConnectedPortId(), 'COM3');

    // 收到断开伴随错误
    const errorEvent: SerialStatusEvent = {
      is_connected: false,
      port: 'COM3',
      session_id: 'sess_1',
      channel_epoch: 1,
      error: '串口已被拔出',
    };
    (transport as any).handleSerialStatus(errorEvent);
    assert.equal(transport.getCurrentStatus(), 'device-lost');

    // 清理
    await transport.dispose();
  });

  console.log('\n--- 单元测试套件 5: useSerialSession 响应式会话层 ---');

  await test('useSerialSession 能够正确初始化会话并提供统一门面', async () => {
    await resetSession();
    const session = useSerialSession();

    assert.equal(session.isConnected.value, false);
    assert.equal(session.isConnecting.value, false);
    assert.equal(session.status.value, 'idle');
    assert.deepEqual(session.ports.value, []);

    // 初始化会话（在测试环境下返回 UnsupportedTransport）
    const tp = await session.init();
    assert.ok(tp);
    assert.equal(session.capabilities.value.globalEmergencyStop, false);

    // 测试 emergencyStop 在无底层驱动时的错误拦截
    await assert.rejects(
      async () => {
        await session.emergencyStop('CMD:STOP\n');
      },
      (err: any) => {
        return err instanceof TransportError;
      }
    );

    await resetSession();
  });

  await test('useSerialSession 异步退订防护正常工作', async () => {
    const session = useSerialSession();
    let batchCalled = false;
    const unsub = session.onBatch(() => {
      batchCalled = true;
    });
    unsub(); // 立即取消
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(batchCalled, false);
    await resetSession();
  });

  console.log(`\n========================================`);
  console.log(`测试完成: ${passedCount} 通过, ${failedCount} 失败`);
  console.log(`========================================\n`);

  if (failedCount > 0) {
    process.exit(1);
  }
}
