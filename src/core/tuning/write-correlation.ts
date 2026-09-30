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
  generation: number;
  value: number;
}

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

/** A parameter channel is fresh only in the same display generation and after the write. */
export function isFreshChannelValue(
  value: CorrelatedChannelValue | undefined,
  correlation: Pick<WriteCorrelation, 'channelGeneration' | 'completedAt'>,
): boolean {
  return Boolean(
    value &&
      value.generation === correlation.channelGeneration &&
      Number.isFinite(value.receivedAt) &&
      correlation.completedAt !== undefined &&
      value.receivedAt >= correlation.completedAt,
  );
}

/**
 * A text acknowledgement is only considered after this attempt's write marker.
 * The transport cannot prove device-level causality for a generic text token;
 * callers should keep a manual confirmation option available.
 */
export function isAcknowledgementForWrite(
  log: CorrelatedLogLine,
  expectedText: string,
  correlation: Pick<WriteCorrelation, 'startLogId' | 'completedAt'>,
): boolean {
  const expected = expectedText.trim();
  if (!expected || log.id <= correlation.startLogId) return false;
  if (log.at !== undefined && correlation.completedAt !== undefined && log.at < correlation.completedAt) return false;
  return /RX|接收/i.test(`${log.tag ?? ''} ${log.level ?? ''}`) && log.text.includes(expected);
}
