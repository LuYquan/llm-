/** Synthetic host read/write order tests; these do not exercise a UART/device. */
import assert from 'node:assert/strict';
import { WebSerialTransport } from '../src/services/transport/web-serial-transport.ts';
import { StreamDemuxer } from '../src/services/transport/worker/stream-demuxer.ts';
import type { RxOrigin } from '../src/types/ipc.ts';
import type { ParsedBatch, WriteReceipt } from '../src/services/transport/types.ts';
import type { WorkerInMessage, WorkerOutMessage } from '../src/services/transport/worker/types.ts';

const encode = (text: string) => new TextEncoder().encode(text);
const origin = (sequence: number, epoch = 1): RxOrigin => ({
  source: 'web-serial-read', session_id: 'web-order-fixture', epoch,
  first_rx_sequence: sequence, last_rx_sequence: sequence,
});
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
async function until(predicate: () => boolean): Promise<void> {
  const limit = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > limit) throw new Error('Synthetic read/write observation timed out');
    await new Promise(done => setTimeout(done, 1));
  }
}

async function withPort(
  sink: (text: string, receive: (text: string) => void) => void | Promise<void>,
  exercise: (context: {
    driver: WebSerialTransport; receive: (text: string) => void;
    logs: ParsedBatch['logLines']; batches: ParsedBatch[]; readCount: () => number;
    reconnect: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const receive = (text: string) => controller.enqueue(encode(text));
  const port = {
    readable: null as ReadableStream<Uint8Array> | null,
    writable: null as WritableStream<Uint8Array> | null,
    open: async () => {
      port.readable = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      port.writable = new WritableStream<Uint8Array>({ write(bytes) { return sink(new TextDecoder().decode(bytes), receive); } });
    },
    close: async () => {},
    getInfo: () => ({ usbVendorId: 0xf17e, usbProductId: 0x0002 }),
  };
  const driver = new WebSerialTransport();
  // Register one literal synthetic port, then exercise the actual public API,
  // read loop, WritableStream queue and fallback parser. No hardware is opened.
  const registered = (driver as any).registerPort(port);
  const logs: ParsedBatch['logLines'] = [];
  const batches: ParsedBatch[] = [];
  let readCount = 0;
  driver.onRawData!(() => { readCount += 1; });
  driver.onBatch(batch => { batches.push(batch); logs.push(...batch.logLines); });
  await driver.connect(registered.id, { baudRate: 115200 });
  try {
    await exercise({ driver, receive, logs, batches, readCount: () => readCount,
      reconnect: async () => {
        await driver.disconnect();
        await driver.connect(registered.id, { baudRate: 115200 });
      },
    });
  } finally {
    await driver.dispose();
  }
}

let workerSequence = 0;
async function withWorker(exercise: (send: (data: WorkerInMessage) => void, batches: () => ParsedBatch[]) => void): Promise<void> {
  const originalSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const oldSetInterval = globalThis.setInterval;
  const oldClearInterval = globalThis.clearInterval;
  const outputs: WorkerOutMessage[] = [];
  const scope = {
    onmessage: null as ((event: { data: WorkerInMessage }) => void) | null,
    postMessage(message: WorkerOutMessage) { outputs.push(message); },
  };
  Object.defineProperty(globalThis, 'self', { configurable: true, value: scope });
  globalThis.setInterval = (() => 0) as any;
  globalThis.clearInterval = (() => {}) as any;
  try {
    await import(`../src/services/transport/worker/demuxer.worker.ts?receive-order=${++workerSequence}`);
    exercise(data => scope.onmessage!({ data }), () => outputs.flatMap(output => output.type === 'BATCH' ? [output.batch] : []));
  } finally {
    globalThis.setInterval = oldSetInterval;
    globalThis.clearInterval = oldClearInterval;
    if (originalSelf) Object.defineProperty(globalThis, 'self', originalSelf);
    else delete (globalThis as any).self;
  }
}

export async function runWebReceiveOrderTests(): Promise<void> {
  const cases: [string, () => void | Promise<void>][] = [
    ['split text retains first contributing chunk and each subsequent line gets its own origin', () => {
      const demux = new StreamDemuxer();
      assert.deepEqual(demux.processBytesWithOrigin(encode('PID_AP'), origin(1)), []);
      assert.deepEqual(demux.processBytesWithOrigin(encode('PLIED first\nPID_APPLIED second\n'), origin(2)), [
        { text: 'PID_APPLIED first', rx_origin: { ...origin(1), last_rx_sequence: 2 } },
        { text: 'PID_APPLIED second', rx_origin: origin(2) },
      ]);
    }],
    ['unknown bytes and mixed epochs never become trusted line origin', () => {
      const demux = new StreamDemuxer();
      demux.processBytesWithOrigin(encode('PID_'));
      assert.equal(demux.processBytesWithOrigin(encode('APPLIED unknown\n'), origin(2))[0].rx_origin, undefined);
      demux.processBytesWithOrigin(encode('PID_'), origin(3));
      demux.processBytesWithOrigin(encode('AP'));
      assert.equal(demux.processBytesWithOrigin(encode('PLIED middle\n'), origin(4))[0].rx_origin, undefined);
      demux.processBytesWithOrigin(encode('PID_'), origin(5));
      assert.equal(demux.processBytesWithOrigin(encode('APPLIED epoch\n'), origin(6, 2))[0].rx_origin, undefined);
      assert.deepEqual(demux.processBytesWithOrigin(encode('PID_APPLIED fresh\n'), origin(7, 2))[0].rx_origin, origin(7, 2));
    }],
    ['bad UTF8 and oversized lines discard origin along with content', () => {
      const demux = new StreamDemuxer();
      demux.processBytesWithOrigin(new Uint8Array([0xff]), origin(1));
      const lines = demux.processBytesWithOrigin(encode('\nPID_APPLIED valid\n'), origin(2));
      assert.deepEqual(lines, [{ text: 'PID_APPLIED valid', rx_origin: origin(2) }]);
      demux.processBytesWithOrigin(new Uint8Array(65537).fill(65), origin(3));
      assert.deepEqual(demux.processBytesWithOrigin(encode('\nPID_APPLIED fresh\n'), origin(4)), [{ text: 'PID_APPLIED fresh', rx_origin: origin(4) }]);
      assert.equal(demux.dirtyByteCount(), 2);
    }],
    ['Worker batch delay preserves original sequence and configure keeps old batch identity', async () => {
      await withWorker((send, batches) => {
        send({ type: 'CONFIGURE', protocolConfig: { type: 'firewater' }, receiveContext: { session_id: origin(1).session_id, epoch: 1 } });
        send({ type: 'CHUNK', data: encode('PID_APPLIED old\n'), timestampUs: 123, rxOrigin: origin(1) });
        assert.equal(batches().length, 0, 'log is buffered before any BATCH dispatch');
        send({ type: 'CONFIGURE', protocolConfig: { type: 'firewater' }, receiveContext: { session_id: origin(1).session_id, epoch: 2 } });
        send({ type: 'CHUNK', data: encode('PID_APPLIED new\n'), timestampUs: 123, rxOrigin: origin(2, 2) });
        send({ type: 'FLUSH' });
        assert.deepEqual(batches().map(batch => batch.channel_epoch), [1, 2]);
        assert.deepEqual(batches().flatMap(batch => batch.logLines.map(log => log.rx_origin)), [origin(1), origin(2, 2)]);
      });
    }],
    ['Worker reset and configure remove pre-boundary partial ACK text', async () => {
      await withWorker((send, batches) => {
        send({ type: 'CONFIGURE', protocolConfig: { type: 'firewater' } });
        send({ type: 'CHUNK', data: encode('PID_AP'), rxOrigin: origin(1) });
        send({ type: 'CONFIGURE', protocolConfig: { type: 'firewater' }, receiveContext: { session_id: origin(1).session_id, epoch: 2 } });
        send({ type: 'CHUNK', data: encode('PLIED after-config\nPID_APPLIED fresh\n'), rxOrigin: origin(2, 2) });
        send({ type: 'FLUSH' });
        assert.deepEqual(batches().flatMap(batch => batch.logLines.map(log => log.text)), ['PLIED after-config', 'PID_APPLIED fresh']);
        send({ type: 'CHUNK', data: encode('PID_AP'), rxOrigin: origin(3, 2) });
        send({ type: 'RESET' });
        send({ type: 'CHUNK', data: encode('PLIED after-reset\n'), rxOrigin: origin(4, 2) });
        send({ type: 'FLUSH' });
        assert.equal(batches().at(-1)!.logLines[0].text, 'PLIED after-reset');
      });
    }],
    ['actual stream ACK before write Promise resolves remains later than dispatch', async () => {
      const pending = defer();
      let dispatched = false;
      await withPort(async (_text, receive) => {
        dispatched = true;
        receive('PID_APPLIED early\n');
        await pending.promise;
      }, async ({ driver, logs }) => {
        const write = driver.write(encode('PID,early\n'));
        try {
          await until(() => dispatched && logs.length > 0);
          let finished = false;
          void write.then(() => { finished = true; });
          assert.equal(finished, false, 'ACK batch arrives before driver completion');
          pending.resolve();
          const receipt = await write;
          assert.equal(receipt.rx_dispatch!.rx_sequence, 0);
          assert.equal(logs[0].rx_origin!.first_rx_sequence, 1);
          assert.equal(logs[0].rx_origin!.session_id, receipt.session_id);
        } finally { pending.resolve(); await write.catch(() => {}); }
      });
    }],
    ['queued dispatch waterline includes received prefix before actual write', async () => {
      const first = defer();
      const second = defer();
      const dispatched: string[] = [];
      await withPort(async text => {
        dispatched.push(text.trim());
        await (dispatched.length === 1 ? first.promise : second.promise);
      }, async ({ driver, receive, logs, readCount }) => {
        const write1 = driver.write(encode('FIRST\n'));
        const write2 = driver.write(encode('SECOND\n'));
        try {
          await until(() => dispatched.length === 1);
          receive('PID_AP');
          await until(() => readCount() === 1);
          first.resolve();
          await until(() => dispatched.length === 2);
          receive('PLIED queued\n');
          await until(() => logs.length === 1);
          second.resolve();
          const receipt1 = await write1;
          const receipt2 = await write2;
          assert.equal(receipt1.rx_dispatch!.rx_sequence, 0);
          assert.equal(receipt2.rx_dispatch!.rx_sequence, 1, 'waterline is dispatch time rather than enqueue time');
          assert.equal(logs[0].rx_origin!.first_rx_sequence, 1);
          assert.equal(logs[0].rx_origin!.last_rx_sequence, 2);
          assert.ok(logs[0].rx_origin!.first_rx_sequence <= receipt2.rx_dispatch!.rx_sequence, 'pre-dispatch prefix cannot pass causal boundary');
        } finally { first.resolve(); second.resolve(); await Promise.allSettled([write1, write2]); }
      });
    }],
    ['read sequence advances before raw observers synchronously call write', async () => {
      await withPort(() => {}, async ({ driver, receive, logs }) => {
        let write: Promise<WriteReceipt> | undefined;
        driver.onRawData!(() => { write = driver.write(encode('FROM_OBSERVER\n')); });
        receive('PID_APPLIED existing\n');
        await until(() => !!write && logs.length === 1);
        const receipt = await write!;
        assert.equal(receipt.rx_dispatch!.rx_sequence, 1);
        assert.equal(logs[0].rx_origin!.first_rx_sequence, 1);
      });
    }],
    ['inflight receipt scope freezes while protocol changes and reconnect resets only new session', async () => {
      const held = defer();
      let hold = true;
      await withPort(async () => { if (hold) await held.promise; }, async ({ driver, receive, readCount, logs, reconnect }) => {
        receive('PID_AP');
        await until(() => readCount() === 1);
        const write = driver.write(encode('OLD_EPOCH\n'));
        try {
          await driver.configureProtocol({ type: 'firewater' });
          receive('PLIED no-prefix\n');
          await until(() => logs.length === 1);
          held.resolve(); hold = false;
          const receipt = await write;
          assert.equal(receipt.epoch, 1);
          assert.equal(receipt.rx_dispatch!.epoch, 1);
          assert.equal(receipt.rx_dispatch!.rx_sequence, 1);
          assert.equal(logs[0].text, 'PLIED no-prefix');
          assert.equal(logs[0].rx_origin!.epoch, 2);
          const next = await driver.write(encode('NEW_EPOCH\n'));
          assert.equal(next.epoch, 2);
          assert.equal(next.rx_dispatch!.rx_sequence, 2, 'protocol switch retains session read sequence');
          await reconnect();
          const fresh = await driver.write(encode('NEW_SESSION\n'));
          assert.notEqual(fresh.session_id, receipt.session_id);
          assert.equal(fresh.epoch, 1);
          assert.equal(fresh.rx_dispatch!.rx_sequence, 0);
        } finally { held.resolve(); await write.catch(() => {}); }
      });
    }],
    ['stop cancels queued normal task, prioritizes STOP and does not invent canceled dispatch', async () => {
      const held = defer();
      const dispatched: string[] = [];
      await withPort(async text => {
        dispatched.push(text.trim());
        if (dispatched.length === 1) await held.promise;
      }, async ({ driver }) => {
        const first = driver.write(encode('INFLIGHT\n'));
        const queued = driver.write(encode('CANCEL_ME\n'));
        const rejected = assert.rejects(queued, /待发队列已取消/);
        try {
          await until(() => dispatched.length === 1);
          const stopped = driver.emergencyStop(encode('STOP\n'));
          await rejected;
          held.resolve();
          await first;
          await stopped;
          assert.deepEqual(dispatched, ['INFLIGHT', 'STOP']);
          await assert.rejects(() => driver.write(encode('BLOCKED\n')), /停止屏障/);
          await driver.resumeWrites();
          const resumed = await driver.write(encode('RESUMED\n'));
          assert.equal(resumed.rx_dispatch!.rx_sequence, 0);
        } finally { held.resolve(); await Promise.allSettled([first, queued]); }
      });
    }],
    ['oversized pre-dispatch line tail cannot become a new ACK; true next line recovers', async () => {
      await withPort(() => {}, async ({ driver, receive, logs, readCount }) => {
        receive('A'.repeat(65537));
        await until(() => readCount() === 1);
        const receipt = await driver.write(encode('PID,oversized\n'));
        assert.equal(receipt.rx_dispatch!.rx_sequence, 1);
        receive('PID_APPLIED stale-tail');
        await until(() => readCount() === 2);
        receive('\nPID_APPLIED independent\n');
        await until(() => logs.length > 0);
        assert.deepEqual(logs.map(log => log.text), ['PID_APPLIED independent']);
        assert.equal(logs[0].rx_origin!.first_rx_sequence, 3);
        assert.equal(logs[0].rx_origin!.last_rx_sequence, 3);
        const demux = new StreamDemuxer();
        demux.processBytesWithOrigin(encode('A'.repeat(65537)), origin(1));
        demux.reset();
        assert.deepEqual(demux.processBytesWithOrigin(encode('PID_APPLIED after-reset\n'), origin(2)), [{ text: 'PID_APPLIED after-reset', rx_origin: origin(2) }]);
      });
    }],
    ['old session/epoch batches remain visible to logs but cannot roll waveform context back', async () => {
      await withPort(() => {}, async ({ driver, logs }) => {
        const receipt = await driver.write(encode('IDENTITY\n'));
        const sessionId = receipt.session_id!;
        const waveforms: { session_id: string; channel_epoch: number }[] = [];
        driver.onWaveformBatch!(batch => waveforms.push(batch));
        // A Worker event can arrive after CONFIGURE input advanced, before the
        // CONFIGURED reply. Exercise the actual registered batch observers.
        (driver as any).receiveEpoch = 2;
        const emit = (batch: ParsedBatch) => {
          for (const listener of (driver as any).batchListeners) listener(batch);
        };
        const delayed: ParsedBatch = {
          session_id: sessionId, channel_epoch: 1,
          samples: [{ channel: 'actual', t: 1, v: 10 }],
          logLines: [{ t: 1, text: 'PID_APPLIED delayed', rx_origin: { ...origin(1), session_id: sessionId } }],
        };
        emit(delayed);
        assert.equal(logs.length, 1, 'raw log origin remains observable for the ACK predicate');
        assert.equal(logs[0].rx_origin!.epoch, 1);
        assert.equal(waveforms.length, 0, 'old CONFIGURE flush must not update waveform context');
        emit({ ...delayed, session_id: 'old-disconnected-session', channel_epoch: 2 });
        assert.equal(waveforms.length, 0, 'old connection must not update waveform context either');
        emit({ ...delayed, channel_epoch: 2, logLines: [] });
        assert.deepEqual(waveforms, [{ session_id: sessionId, channel_epoch: 2,
          channel_names: ['actual'], points: [], timestamps: [1], series: [[10]], dropped_bytes: 0 }]);
        (driver as any).sessionEpoch = 2;
        emit(delayed);
        assert.equal(waveforms.length, 1, 'late old batch stays rejected after CONFIGURED');
        assert.equal(logs.length, 3, 'log consumers retain original evidence instead of current-context rewriting');
      });
    }],
  ];
  console.log('\n--- Web Serial synthetic host receive-order tests ---');
  for (const [name, exercise] of cases) {
    await exercise();
    console.log(`  ✓ ${name}`);
  }
  console.log(`  ${cases.length}/${cases.length} host-order cases passed; hardware acceptance not exercised.`);
}
