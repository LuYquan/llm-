import type { RecordedRawChunk, RecordingPage, RecordingSummary } from '../transport/session';
import {
  RecordingReplayDecoder,
  recordingProtocolReplaySupport,
  type RecordingReplaySample,
} from './replay-decoder';

interface ValueSlot<T> { value: T }

/** Value slots accept Vue refs in the UI and plain objects in local tests. */
export interface RecordingReplayState {
  session: ValueSlot<RecordingSummary | null>;
  page: ValueSlot<RecordingPage | null>;
  chunks: ValueSlot<RecordedRawChunk[]>;
  loading: ValueSlot<boolean>;
  error: ValueSlot<string | null>;
  samples: ValueSlot<RecordingReplaySample[]>;
  logs: ValueSlot<{ timeSeconds: number; text: string }[]>;
  decoder: ValueSlot<RecordingReplayDecoder | null>;
  decodeNotice: ValueSlot<string | null>;
  decodeErrorCount: ValueSlot<number>;
}

type ReadRecordingPage = (
  sessionId: string,
  directory: string,
  afterRxSequence?: number,
  maxBytes?: number,
) => Promise<RecordingPage>;

interface ReplayIdentity {
  sessionId: string;
  directory: string;
  epoch: number;
}

/** Each selection owns its parser and request generation, including same-ID reopen. */
export class RecordingReplayController {
  private generation = 0;
  private loadingGeneration: number | null = null;
  private readonly state: RecordingReplayState;
  private readonly readPage: ReadRecordingPage;

  constructor(state: RecordingReplayState, readPage: ReadRecordingPage) {
    this.state = state;
    this.readPage = readPage;
  }

  async open(item: RecordingSummary): Promise<void> {
    this.close();
    const snapshot: RecordingSummary = {
      directory: item.directory,
      manifest: {
        ...item.manifest,
        protocolConfig: item.manifest.protocolConfig
          ? JSON.parse(JSON.stringify(item.manifest.protocolConfig))
          : null,
        segments: item.manifest.segments.map((segment) => ({ ...segment })),
      },
    };
    this.state.session.value = snapshot;
    const notice = recordingProtocolReplaySupport(snapshot.manifest.protocolConfig);
    this.state.decodeNotice.value = notice;
    this.state.decoder.value = snapshot.manifest.protocolConfig && !notice
      ? new RecordingReplayDecoder(snapshot.manifest.protocolConfig)
      : null;
    await this.load();
  }

  close(): void {
    this.generation += 1;
    this.loadingGeneration = null;
    this.state.session.value = null;
    this.state.page.value = null;
    this.state.chunks.value = [];
    this.state.loading.value = false;
    this.state.error.value = null;
    this.state.samples.value = [];
    this.state.logs.value = [];
    this.state.decoder.value = null;
    this.state.decodeNotice.value = null;
    this.state.decodeErrorCount.value = 0;
  }

  async load(afterRxSequence?: number): Promise<void> {
    const item = this.state.session.value;
    const generation = this.generation;
    if (!item || this.loadingGeneration === generation) return;
    const identity: ReplayIdentity = {
      sessionId: item.manifest.sessionId,
      directory: item.directory,
      epoch: item.manifest.epoch,
    };
    const decoder = this.state.decoder.value;
    this.loadingGeneration = generation;
    this.state.loading.value = true;
    this.state.error.value = null;
    try {
      const page = await this.readPage(identity.sessionId, identity.directory, afterRxSequence, 64 * 1024);
      if (!this.isCurrent(generation, identity)) return;
      if (page.sessionId !== identity.sessionId || page.epoch !== identity.epoch) {
        throw new Error('回放页的会话或数据世代不匹配，已拒绝载入；请重新打开记录。');
      }
      // Decode only after identity validation, using this request's own parser.
      const chunks = page.chunks.map((chunk) => ({ ...chunk, bytes: [...chunk.bytes] }));
      const decoded = decoder?.feedPage(page);
      this.state.page.value = page;
      this.state.chunks.value.push(...chunks);
      if (decoded) {
        this.state.samples.value.push(...decoded.samples);
        this.state.logs.value.push(...decoded.logs);
        this.state.decodeErrorCount.value += decoded.errorCount;
      }
    } catch (error) {
      if (this.isCurrent(generation, identity)) {
        this.state.error.value = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (this.isCurrent(generation, identity)) {
        this.loadingGeneration = null;
        this.state.loading.value = false;
      }
    }
  }

  private isCurrent(generation: number, identity: ReplayIdentity): boolean {
    const selected = this.state.session.value;
    return this.generation === generation
      && selected?.manifest.sessionId === identity.sessionId
      && selected.directory === identity.directory
      && selected.manifest.epoch === identity.epoch;
  }
}
