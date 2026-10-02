import type { ProtocolConfig } from '../../core/protocol/types';
import type { RecordedRawChunk, RecordingPage, RecordingStatus, RecordingSummary } from '../transport/session';

const DATABASE_NAME = 'llm-serial-recordings';
const DATABASE_VERSION = 1;
const STORE_NAME = 'sessions';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CHUNKS = 100_000;

type BrowserRecordingManifest = RecordingSummary['manifest'] & {
  source: 'webserial' | 'mock';
};

interface BrowserRecordingRecord {
  directory: string;
  manifest: BrowserRecordingManifest;
  chunks: RecordedRawChunk[];
}

export interface BrowserRecordingMetadata {
  source: 'webserial' | 'mock';
  port: string | null;
  baudRate: number | null;
  protocolConfig: ProtocolConfig | null;
}

function hasIndexedDb(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error('浏览器记录数据库打开失败'));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function getAll(database: IDBDatabase): Promise<BrowserRecordingRecord[]> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    request.onerror = () => reject(request.error ?? new Error('浏览器记录清单读取失败'));
    request.onsuccess = () => resolve((request.result as BrowserRecordingRecord[] | undefined) ?? []);
  });
}

function put(database: IDBDatabase, record: BrowserRecordingRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.onerror = () => reject(transaction.error ?? new Error('浏览器记录写入失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('浏览器记录写入被中止'));
    transaction.oncomplete = () => resolve();
    transaction.objectStore(STORE_NAME).put(record, record.manifest.sessionId);
  });
}

function cloneRecord(record: BrowserRecordingRecord): BrowserRecordingRecord {
  return {
    directory: record.directory,
    manifest: { ...record.manifest, segments: record.manifest.segments.map((segment) => ({ ...segment })) },
    chunks: record.chunks.map((chunk) => ({ ...chunk, bytes: [...chunk.bytes] })),
  };
}

function statusFor(record: BrowserRecordingRecord | null): RecordingStatus {
  if (!record) {
    return { isRecording: false, sessionId: null, directory: null, rxBytes: 0, rxChunks: 0, error: null };
  }
  return {
    isRecording: record.manifest.status === 'recording',
    sessionId: record.manifest.sessionId,
    directory: record.directory,
    rxBytes: record.manifest.rxBytes,
    rxChunks: record.manifest.rxChunks,
    error: record.manifest.error,
  };
}

function close(database: IDBDatabase): void {
  try { database.close(); } catch { /* best effort */ }
}

/**
 * Small bounded browser recorder. It stores raw chunks only; replay owns its
 * decoder and never writes into the live channel store or serial transport.
 */
export class BrowserRecordingStore {
  private active: BrowserRecordingRecord | null = null;
  private lastStatus: RecordingStatus | null = null;
  private memory = new Map<string, BrowserRecordingRecord>();
  private pendingWrite: Promise<void> = Promise.resolve();
  private sequence = 0;
  private connectStartedAtUs = 0;

  setReceiveClock(startedAtUs: number): void {
    this.connectStartedAtUs = Number.isFinite(startedAtUs) ? startedAtUs : 0;
    this.sequence = 0;
  }

  nextReceiveSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  receiveTimeUs(): number {
    const now = typeof performance !== 'undefined' ? performance.now() * 1000 : Date.now() * 1000;
    return Math.max(0, Math.round(now - this.connectStartedAtUs));
  }

  async start(metadata: BrowserRecordingMetadata): Promise<RecordingStatus> {
    if (this.active?.manifest.status === 'recording') throw new Error('已有浏览器记录会话正在运行');
    const startedUnixMs = Date.now();
    const sessionId = `web-${startedUnixMs}-${Math.random().toString(36).slice(2, 10)}`;
    const record: BrowserRecordingRecord = {
      directory: `indexeddb://llm-serial-recordings/${sessionId}`,
      manifest: {
        formatVersion: 1,
        sessionId,
        epoch: 1,
        source: metadata.source,
        port: metadata.port,
        baudRate: metadata.baudRate,
        protocolConfig: metadata.protocolConfig ? JSON.parse(JSON.stringify(metadata.protocolConfig)) : null,
        timeSource: 'host_monotonic_receive',
        status: 'recording',
        startedUnixMs,
        endedUnixMs: null,
        rxBytes: 0,
        rxChunks: 0,
        unindexedBytes: 0,
        segments: [],
        error: null,
      },
      chunks: [],
    };
    await this.persist(record);
    this.active = record;
    return statusFor(record);
  }

  append(chunk: Uint8Array, receivedAtUs: number): void {
    const active = this.active;
    if (!active || active.manifest.status !== 'recording' || chunk.length === 0) return;
    const bytes = Array.from(chunk);
    this.pendingWrite = this.pendingWrite
      .then(async () => {
        if (this.active !== active || active.manifest.status !== 'recording') return;
        if (active.manifest.rxBytes + bytes.length > MAX_BYTES || active.chunks.length >= MAX_CHUNKS) {
          active.manifest.status = 'interrupted';
          active.manifest.error = `浏览器记录达到上限（${MAX_BYTES.toLocaleString()} 字节或 ${MAX_CHUNKS.toLocaleString()} 块）`;
          active.manifest.endedUnixMs = Date.now();
          await this.persist(active);
          return;
        }
        const rxSequence = this.nextReceiveSequence();
        active.chunks.push({ rxSequence, receivedAtUs, bytes });
        active.manifest.rxBytes += bytes.length;
        active.manifest.rxChunks += 1;
        await this.persist(active);
      })
      .catch((error) => {
        if (this.active === active) {
          active.manifest.status = 'interrupted';
          active.manifest.error = `浏览器记录写入失败: ${error instanceof Error ? error.message : String(error)}`;
          active.manifest.endedUnixMs = Date.now();
        }
      });
  }

  async stop(): Promise<RecordingStatus> {
    const active = this.active;
    if (!active) return statusFor(null);
    await this.pendingWrite;
    if (active.manifest.status === 'recording') {
      active.manifest.status = 'complete';
      active.manifest.endedUnixMs = Date.now();
      await this.persist(active);
    }
    const result = statusFor(active);
    this.lastStatus = result;
    this.active = null;
    return result;
  }

  status(): RecordingStatus {
    return this.active ? statusFor(this.active) : (this.lastStatus ?? statusFor(null));
  }

  async list(): Promise<RecordingSummary[]> {
    const records = await this.readAll();
    const currentId = this.active?.manifest.sessionId;
    for (const record of records) {
      if (record.manifest.status === 'recording' && record.manifest.sessionId !== currentId) {
        record.manifest.status = 'interrupted';
        record.manifest.error = '浏览器页面在记录结束前退出，已恢复为异常中断';
        record.manifest.endedUnixMs = record.manifest.endedUnixMs ?? Date.now();
        await this.persist(record);
      }
    }
    return records
      .sort((a, b) => b.manifest.startedUnixMs - a.manifest.startedUnixMs)
      .map((record) => ({ directory: record.directory, manifest: { ...record.manifest, segments: record.manifest.segments.map((segment) => ({ ...segment })) } }));
  }

  async readPage(sessionId: string, directory: string, afterRxSequence?: number, maxBytes = 64 * 1024): Promise<RecordingPage> {
    if (!sessionId || !directory || maxBytes <= 0 || maxBytes > 256 * 1024) throw new Error('浏览器记录分页参数无效');
    const record = (await this.readAll()).find((item) => item.manifest.sessionId === sessionId && item.directory === directory);
    if (!record) throw new Error('找不到匹配的浏览器记录会话');
    if (record.manifest.status === 'recording') throw new Error('记录仍在进行中，请先停止后再回放');
    const after = afterRxSequence ?? 0;
    const chunks: RecordedRawChunk[] = [];
    let bytes = 0;
    for (const chunk of record.chunks) {
      if (chunk.rxSequence <= after) continue;
      if (chunks.length > 0 && bytes + chunk.bytes.length > maxBytes) break;
      chunks.push({ ...chunk, bytes: [...chunk.bytes] });
      bytes += chunk.bytes.length;
    }
    const nextAfterRxSequence = chunks.length > 0 ? chunks[chunks.length - 1].rxSequence : null;
    const last = chunks.length > 0 ? chunks[chunks.length - 1].rxSequence : after;
    const sequenceGap = chunks.some((chunk, index) => chunk.rxSequence !== (index === 0 ? after + 1 : chunks[index - 1].rxSequence + 1));
    return {
      sessionId,
      epoch: record.manifest.epoch,
      chunks,
      nextAfterRxSequence,
      eof: last >= (record.chunks.at(-1)?.rxSequence ?? -1),
      sequenceGap,
    };
  }

  private async persist(record: BrowserRecordingRecord): Promise<void> {
    const copy = cloneRecord(record);
    if (!hasIndexedDb()) {
      this.memory.set(copy.manifest.sessionId, copy);
      return;
    }
    const database = await openDatabase();
    try {
      await put(database, copy);
    } finally {
      close(database);
    }
  }

  private async readAll(): Promise<BrowserRecordingRecord[]> {
    if (!hasIndexedDb()) return Array.from(this.memory.values()).map(cloneRecord);
    const database = await openDatabase();
    try {
      return (await getAll(database)).map(cloneRecord);
    } finally {
      close(database);
    }
  }
}
