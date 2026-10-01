import type { LoopStructure, PidValues } from '../project/types';
import type { PidStructure, PlantModel } from '../control/types';
import type { TuningScenarioContext } from './scenarios';
import type { CascadeDependencySnapshot } from './cascadeDependencies';
import type { TuningCommandFormat, TuningCommandPayload } from './commandContract';

export type TuningRoute = 'model' | 'feedback';
export type TuningMode = 'manual' | 'bounded-auto';
export type WriteConfirmationMode = 'parameter-channels' | 'acknowledgement' | 'manual';
export type ExperimentStatus =
  | 'draft'
  | 'ready'
  | 'awaiting-confirmation'
  | 'collecting'
  | 'paused'
  | 'completed'
  | 'stopped';

export type PidParameter = keyof PidValues;

export interface ParameterBounds {
  min: number;
  max: number;
}

export interface TuningChannelBindings {
  setpoint: string;
  feedback: string;
  output: string;
  parameters: Partial<Record<PidParameter, string>>;
}

export interface TuningGoal {
  mode: 'settle' | 'step-response' | 'track';
  maximumSteadyError: number | null;
  maximumOvershootPct: number | null;
  /** Reference-channel units; absent legacy values require explicit configuration. */
  stepSetpointTolerance?: number | null;
  maximumTrackingError: number | null;
  targetPhaseMarginDeg: number | null;
  targetCrossoverRadPerSec: number | null;
}

export interface TuningPlan {
  id: string;
  version: 1;
  name: string;
  project: string;
  description: string;
  prompt: string;
  route: TuningRoute;
  mode: TuningMode;
  loopId: string;
  structure: LoopStructure;
  controlDirection: 'direct' | 'reverse' | null;
  sampleTimeSeconds: number | null;
  commandTemplate: string;
  /** Omitted historical settings use the documented CRLF/text-escape default. */
  commandFormat?: TuningCommandFormat;
  baseline: {
    params: PidValues | null;
    source: 'unset' | 'manual' | 'parameter-channels';
    confirmed: boolean;
    stableBaseConfirmed: boolean;
  };
  bounds: Record<PidParameter, ParameterBounds | null>;
  maxParameterChangePercent: number | null;
  maximumTrials: number | null;
  evaluationWindowSeconds: number | null;
  maximumTelemetryAgeSeconds: number | null;
  maximumOutputMagnitude: number | null;
  channels: TuningChannelBindings;
  units: {
    setpoint: string;
    feedback: string;
    output: string;
    parameters: Partial<Record<PidParameter, string>>;
  };
  confirmation: {
    mode: WriteConfirmationMode;
    acknowledgementText: string;
    timeoutSeconds: number | null;
    parameterTolerance: number | null;
  };
  goal: TuningGoal;
  model: PlantModel | null;
  /** Declarative scenario context; it grants no device or code execution authority. */
  suite?: TuningScenarioContext;
  /** Reviewed upstream configuration identity; never grants device authority. */
  cascadeBinding?: CascadeDependencySnapshot;
}

export interface TuningMetrics {
  steadyError: number;
  peakError: number;
  rmsTrackingError: number;
  overshootPercent: number | null;
  maximumOutputMagnitude: number;
  sampleCount: number;
}

export interface ToolExecutionRecord {
  id: string;
  tool: 'pid-solver' | 'feedback-agent';
  executedAt: number;
  inputFingerprint: string;
  result: PidValues;
  summary: string;
  /** Exact plan used before an asynchronous tool request. */
  planSignature?: string;
  /** Bounded input snapshot for reproducible local review, without API credentials. */
  inputSnapshot?: Record<string, unknown>;
}

export interface TuningTrial {
  id: string;
  /** Channel session observed when this exact proposal was created. */
  sourceChannelGeneration?: number;
  createdAt: number;
  status: 'proposed' | 'queued' | 'sent' | 'confirmed' | 'evaluated' | 'rejected' | 'failed';
  before: PidValues;
  candidate: PidValues;
  command?: string;
  /** Exact reviewed wire bytes; historical records without it remain readable. */
  commandPayload?: TuningCommandPayload;
  confirmation?: string;
  confirmationMode?: WriteConfirmationMode;
  /** Driver write identity captured for this exact trial attempt. */
  writeRequestId?: string;
  /** Application protocol token embedded in the payload for device ACK correlation. */
  protocolRequestId?: string;
  writeSessionId?: string;
  writeEpoch?: number;
  writeStartedAt?: number;
  writeCompletedAt?: number;
  writeChannelGeneration?: number;
  /** Per-parameter channel revisions captured immediately before this write. */
  writeParameterRevisions?: Partial<Record<PidParameter, number>>;
  writeStartLogId?: number;
  acknowledgementLogId?: number;
  sampleWindowStart?: number;
  sampleWindowEnd?: number;
  metrics?: TuningMetrics;
  note: string;
  evidence?: ToolExecutionRecord;
  /** A proposal belongs to one exact configuration; edits require a fresh proposal. */
  planSignature?: string;
}

export interface TuningSession {
  id: string;
  /** Groups independently configured stages without transferring device authority. */
  scenarioGroupId?: string;
  formDraft?: {
    modelSource: 'physical' | 'transfer' | 'ai';
    numerator: string;
    denominator: string;
    delay: string;
    parameters: Record<PidParameter, string>;
  };
  plan: TuningPlan;
  status: ExperimentStatus;
  trials: TuningTrial[];
  bestVerified: PidValues | null;
  lastConfirmed: { params: PidValues; mode: WriteConfirmationMode; at: number } | null;
  startedAt: number | null;
  updatedAt: number;
  stopReason: string | null;
}

export interface TuningCapabilityPackage {
  schema: 'com.llm-serial.tuning-package';
  version: 1;
  id: string;
  title: string;
  author: string;
  description: string;
  compatibility: { app: string; features: string[] };
  skills: Array<{ id: string; title: string; instructions: string }>;
  tools: Array<'local.pid-solver' | 'ai.feedback-candidate'>;
  plan: TuningPlan;
}

export interface CandidateValidation {
  valid: boolean;
  errors: string[];
}

export interface FeedbackProposal {
  params: PidValues;
  rationale: string;
}

export interface PhysicalModelField {
  id: string;
  label: string;
  unit: string;
  required: true;
  min?: number;
  max?: number;
}

/** AI-produced equations remain a draft until inputs and assumptions are reviewed. */
export interface PlantModelDraft {
  status: 'draft';
  title: string;
  numerator: string[];
  denominator: string[];
  tau: string;
  physicalFields: PhysicalModelField[];
  assumptions: string[];
  explanation: string;
}

export type ControlStructure = LoopStructure | PidStructure;
