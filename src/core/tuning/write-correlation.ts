/**
 * Helpers for binding a tuning confirmation to the write attempt that started it.
 *
 * A timestamp alone is not enough: a reconnect can leave an old channel value in
 * the in-memory buffer, and a generic acknowledgement string can arrive late.
 * These predicates keep the UI state machine conservative. They do not claim
 * that a driver write means the device applied the parameters.
 */

export interface WriteCorrelation {
  requestId: string;
  sessionId?: string;
  epoch?: number;
  startedAt: number;
  completedAt?: number;
  channelGeneration: number;
  startLogId: number;
}

export interface CorrelatedWriteResult {
  trialId: string;
  requestId?: string;
  sessionId?: string;
  epoch?: number;
  status: 'queued' | 'written' | 'failed';
}

export interface CorrelatedChannelValue {
  receivedAt: number;
  /** Canonical channel ingestion revision, captured before subscriber dispatch. */
  revision: number;
  generation: number;
  value: number;
}

export interface WrittenConfirmationContext {
  writeStatus: CorrelatedWriteResult['status'];
  sessionId?: string;
  epoch?: number;
  currentSessionId: string | null;
  currentEpoch: number | null;
}

export type ParameterReadbackCorrelation = WrittenConfirmationContext &
  Pick<WriteCorrelation, 'startedAt' | 'channelGeneration'> & { startRevision: number };

export type AcknowledgementCorrelation = WrittenConfirmationContext &
  Pick<WriteCorrelation, 'startedAt' | 'startLogId'> & { protocolRequestId: string };

export interface CorrelatedLogLine {
  id: number;
  text: string;
  tag?: string;
  level?: string;
  at?: number;
}

/** Only a result carrying a request id can advance a trial out of proposed. */
export function isWriteResultForTrial(
  result: CorrelatedWriteResult,
  trialId: string,
  expectedRequestId?: string,
): boolean {
  if (result.trialId !== trialId) return false;
  const requestId = result.requestId?.trim();
  if (!requestId) return false;
  return !expectedRequestId || requestId === expectedRequestId;
}

function isWrittenInCurrentSession(context: WrittenConfirmationContext): boolean {
  return context.writeStatus === 'written'
    && typeof context.sessionId === 'string' && context.sessionId.trim().length > 0
    && context.sessionId === context.currentSessionId
    && Number.isSafeInteger(context.epoch) && context.epoch! >= 0
    && context.epoch === context.currentEpoch;
}

/**
 * Require a new ingested value after the dispatch watermark, plus an independently
 * confirmed driver write. Subscriber callback order and millisecond timestamps do
 * not establish whether a sample preceded this write attempt.
 */
export function isFreshChannelValue(
  value: CorrelatedChannelValue | undefined,
  correlation: ParameterReadbackCorrelation,
): boolean {
  return Boolean(
    value && isWrittenInCurrentSession(correlation) &&
      value.generation === correlation.channelGeneration &&
    Number.isSafeInteger(correlation.startRevision) && correlation.startRevision >= 0 &&
    Number.isSafeInteger(value.revision) && value.revision > correlation.startRevision &&
    Number.isFinite(correlation.startedAt) &&
      Number.isFinite(value.receivedAt) &&
    value.receivedAt >= correlation.startedAt,
  );
}

/**
 * Match this attempt's unique protocol id after its RX watermark, and require
 * written receipt/session identity separately. A real ACK may reach the frontend
 * before the driver receipt callback; their arrival order is not device causality.
 */
export function isAcknowledgementForWrite(
  log: CorrelatedLogLine,
  expectedText: string,
  correlation: AcknowledgementCorrelation,
): boolean {
  const expected = expectedText.trim();
  const protocolRequestId = correlation.protocolRequestId?.trim();
  if (!isWrittenInCurrentSession(correlation) || !protocolRequestId || !expected.includes(protocolRequestId)
    || !Number.isSafeInteger(correlation.startLogId) || correlation.startLogId < 0
    || !Number.isSafeInteger(log.id) || log.id <= correlation.startLogId
    || !Number.isFinite(correlation.startedAt)) return false;
  if (log.at !== undefined && (!Number.isFinite(log.at) || log.at < correlation.startedAt)) return false;
  return /RX|接收/i.test(`${log.tag ?? ''} ${log.level ?? ''}`) && log.text.trim() === expected;
}
