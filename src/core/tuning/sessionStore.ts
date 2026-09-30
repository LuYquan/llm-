import type { TuningSession } from './types';
import { validatePlanShape } from './engine';

const STORAGE_KEY = 'llm-serial-tuning-sessions-v1';
const MAX_SESSIONS = 12;
const MAX_TRIALS_PER_SESSION = 100;

export function loadTuningSession(): TuningSession | null {
  return readSession();
}

export function loadTuningStageSession(groupId: string, scenarioId: string, topologyId: string, stageId: string): TuningSession | null {
  return readSession((session) => session.scenarioGroupId === groupId
    && session.plan.suite?.id === scenarioId && session.plan.suite.topologyId === topologyId && session.plan.suite.stageId === stageId);
}

function readSession(matches: (session: TuningSession) => boolean = () => true): TuningSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    // saveTuningSession stores a newest-first list; accept the original
    // single-session shape as a migration path for early local drafts.
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    const session = candidates.find((candidate) => isTuningSession(candidate) && matches(candidate));
    if (!session) return null;
    const resumed = JSON.parse(JSON.stringify(session)) as TuningSession;
    // Historic write records survive a restart, but none proves what a newly
    // connected device is running. Require a new attestation and authorization.
    resumed.plan.baseline.confirmed = false;
    resumed.plan.baseline.stableBaseConfirmed = false;
    if (resumed.plan.suite) resumed.plan.suite.modelConfirmed = false;
    resumed.lastConfirmed = null;
    if (['awaiting-confirmation', 'collecting', 'ready'].includes(resumed.status)) {
      resumed.status = 'paused';
      resumed.stopReason = '软件重新启动后实验已暂停。请重新核对当前设备基线与模型，再授权执行。';
    }
    return resumed;
  } catch {
    return null;
  }
}

export function saveTuningSession(session: TuningSession): boolean {
  try {
    const boundedSession = { ...session, trials: session.trials.slice(0, MAX_TRIALS_PER_SESSION) };
    if (!isTuningSession(boundedSession)) return false;
    const prior = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as unknown;
    const priorSessions = Array.isArray(prior) ? prior : isTuningSession(prior) ? [prior] : [];
    const sessions = priorSessions.filter((item) => !item || typeof item !== 'object' || item.id !== session.id);
    sessions.unshift(boundedSession);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
    return true;
  } catch {
    return false;
  }
}

function isTuningSession(value: unknown): value is TuningSession {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TuningSession>;
  if (candidate.scenarioGroupId !== undefined && (typeof candidate.scenarioGroupId !== 'string' || candidate.scenarioGroupId.length > 160)) return false;
  if (candidate.formDraft !== undefined) {
    const form = candidate.formDraft;
    if (!form || typeof form !== 'object' || !['physical', 'transfer', 'ai'].includes(form.modelSource)
      || !['numerator', 'denominator', 'delay'].every((key) => typeof form[key as 'numerator'] === 'string' && form[key as 'numerator'].length <= 1000)
      || !form.parameters || !['kp', 'ki', 'kd'].every((key) => typeof form.parameters[key as 'kp'] === 'string' && form.parameters[key as 'kp'].length <= 256)) return false;
  }
  if (typeof candidate.id !== 'string' || !candidate.id || candidate.id.length > 160 || validatePlanShape(candidate.plan).length
    || !['draft', 'ready', 'awaiting-confirmation', 'collecting', 'paused', 'completed', 'stopped'].includes(candidate.status ?? '')
    || !Array.isArray(candidate.trials) || candidate.trials.length > MAX_TRIALS_PER_SESSION
    || !Number.isFinite(candidate.updatedAt) || candidate.startedAt !== null && !Number.isFinite(candidate.startedAt)
    || candidate.stopReason !== null && (typeof candidate.stopReason !== 'string' || candidate.stopReason.length > 4000)) return false;
  return candidate.trials.every((trial) => trial && typeof trial === 'object' && typeof trial.id === 'string' && trial.id.length <= 160
    && (trial.sourceChannelGeneration === undefined || Number.isSafeInteger(trial.sourceChannelGeneration) && trial.sourceChannelGeneration >= 0)
    && ['proposed', 'queued', 'sent', 'confirmed', 'evaluated', 'rejected', 'failed'].includes(trial.status)
    && isPidValues(trial.before) && isPidValues(trial.candidate) && typeof trial.note === 'string' && trial.note.length <= 6000
    && Number.isFinite(trial.createdAt))
    && (candidate.bestVerified === null || isPidValues(candidate.bestVerified))
    && (candidate.lastConfirmed === null || Boolean(candidate.lastConfirmed && isPidValues(candidate.lastConfirmed.params)
      && ['manual', 'parameter-channels', 'acknowledgement'].includes(candidate.lastConfirmed.mode) && Number.isFinite(candidate.lastConfirmed.at)));
}

function isPidValues(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const params = value as Record<string, unknown>;
  return ['kp', 'ki', 'kd'].every((key) => typeof params[key] === 'number' && Number.isFinite(params[key]));
}
