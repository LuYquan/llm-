import { computeFftSpectrum, inspectFftInput, type FftInputQuality, type FftResult } from '../../core/analysis/fft';
import { extract_step_features, inspectStepInput } from '../../core/analysis/extractStepFeatures';
import type { StepAnalysisOptions, StepResponseMetrics } from '../../core/analysis/types';
import { identifyPlant } from '../../core/control/identifyPlant';
import type { IdentifyPlantOptions, IdentifyPlantResult, SimulateClosedLoopOptions, SimulateClosedLoopResult } from '../../core/control/types';
import { simulateClosedLoop } from '../../core/control/simulateClosedLoop';
import {
  ANALYSIS_ALGORITHMS,
  attachAnalysisProvenance,
  makeAnalysisProvenance,
  type AnalysisContext,
  type AnalysisProvenance,
} from '../../core/analysis/provenance';
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-worker-protocol';
import { persistAnalysisProvenance } from './analysis-history';

export interface CancellableAnalysis<T> {
  id: number;
  promise: Promise<T>;
  cancel(): void;
}

type PendingJob = {
  worker: Worker;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

export type AnalysisWorkerFactory = (url: URL, options: WorkerOptions) => Worker;

export interface AnalysisWorkerClientOptions {
  createWorker?: AnalysisWorkerFactory;
  timeoutMs?: number;
  maxSamples?: number;
  maxSyncFallbackSamples?: number;
  maxSimulationSteps?: number;
}

interface ResolvedAnalysisWorkerClientOptions {
  timeoutMs: number;
  maxSamples: number;
  maxSyncFallbackSamples: number;
  maxSimulationSteps: number;
}

export interface FftAnalysisResult {
  quality: FftInputQuality;
  result: FftResult | null;
  provenance?: AnalysisProvenance;
}

export interface StepAnalysisResult {
  quality: ReturnType<typeof inspectStepInput>;
  result: StepResponseMetrics | null;
  provenance?: AnalysisProvenance;
}

let nextClientId = 1;
const DEFAULT_OPTIONS = {
  timeoutMs: 30_000,
  maxSamples: 100_000,
  maxSyncFallbackSamples: 10_000,
  maxSimulationSteps: 500_000,
} as const;

// Vue proxies cannot cross postMessage. Snapshot the small option DTOs before
// dispatch, preserving NaN/Infinity for the numerical validators to reject.
// Do not JSON-roundtrip them: that would silently turn invalid numbers into null.
function snapshotAnalysisOptions<T>(options: T): T {
  const ancestors = new WeakSet<object>();
  function copy(value: unknown, depth: number): unknown {
    if (typeof value === 'function') throw new Error('分析参数不能包含函数');
    if (value === null || typeof value !== 'object') return value;
    if (depth > 16 || ancestors.has(value)) throw new Error('分析参数结构过深或包含循环引用');
    ancestors.add(value);
    const result = Array.isArray(value)
      ? value.map(item => copy(item, depth + 1))
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item, depth + 1)]));
    ancestors.delete(value);
    return result;
  }
  return copy(options, 0) as T;
}

/**
 * Runs expensive analysis off the Vue render thread when module Workers are
 * available, while preserving a deterministic synchronous fallback for test
 * hosts and restricted embedded WebViews.
 */
export class AnalysisWorkerClient {
  private readonly workerFactory: AnalysisWorkerFactory | null;
  private readonly options: ResolvedAnalysisWorkerClientOptions;
  private pending = new Map<number, PendingJob>();
  private disposed = false;

  constructor(options: AnalysisWorkerClientOptions = {}) {
    this.options = {
      timeoutMs: options.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs,
      maxSamples: options.maxSamples ?? DEFAULT_OPTIONS.maxSamples,
      maxSyncFallbackSamples: options.maxSyncFallbackSamples ?? DEFAULT_OPTIONS.maxSyncFallbackSamples,
      maxSimulationSteps: options.maxSimulationSteps ?? DEFAULT_OPTIONS.maxSimulationSteps,
    };
    this.workerFactory = options.createWorker ?? (typeof Worker === 'undefined'
      ? null
      : (url, options) => new Worker(url, options));
  }

  runFft(
    timestamps: ArrayLike<number>,
    values: ArrayLike<number>,
    maxPoints = 1024,
    context?: AnalysisContext,
  ): CancellableAnalysis<FftAnalysisResult> {
    const requestId = nextClientId++;
    if (timestamps.length !== values.length) return this.rejected(requestId, 'FFT 时间和值数量不一致');
    if (timestamps.length > this.options.maxSamples) return this.rejected(requestId, `FFT 样本超过上限 ${this.options.maxSamples}`);
    const request: AnalysisWorkerRequest = {
      type: 'fft',
      id: requestId,
      timestamps: Array.from(timestamps),
      values: Array.from(values),
      maxPoints,
    };
    const job = !this.workerFactory || this.disposed
      ? this.runFallback<FftAnalysisResult>(request)
      : this.dispatch<FftAnalysisResult>(request);
    return this.decorate(job, (value) => {
      const provenance = makeAnalysisProvenance(
        context,
        ANALYSIS_ALGORITHMS.fft,
        { maxPoints },
        request.timestamps,
        value.quality.pointCount,
      );
      value.provenance = provenance;
      if (value.result) attachAnalysisProvenance(value.result, provenance);
      return value;
    });
  }

  runSimulation(options: SimulateClosedLoopOptions, context?: AnalysisContext): CancellableAnalysis<SimulateClosedLoopResult> {
    const requestId = nextClientId++;
    const simTime = options.simTime ?? 1.5;
    if (!Number.isFinite(options.sampleTime) || options.sampleTime <= 0
      || !Number.isFinite(simTime) || simTime <= 0) {
      return this.rejected(requestId, '仿真采样周期和时长必须是正的有限数值');
    }
    if (Math.ceil(simTime / options.sampleTime) > this.options.maxSimulationSteps) {
      return this.rejected(requestId, `仿真步数超过上限 ${this.options.maxSimulationSteps}`);
    }
    const { shouldCancel: _ignored, ...inputOptions } = options;
    let serializableOptions: typeof inputOptions;
    try { serializableOptions = snapshotAnalysisOptions(inputOptions); }
    catch (error) { return this.rejected(requestId, error instanceof Error ? error.message : String(error)); }
    const request: AnalysisWorkerRequest = {
      type: 'simulate',
      id: requestId,
      options: serializableOptions,
    };
    const job = !this.workerFactory || this.disposed
      ? this.runFallback<SimulateClosedLoopResult>(request, options.shouldCancel)
      : this.dispatch<SimulateClosedLoopResult>(request);
    return this.decorate(job, (value) => {
      const provenance = makeAnalysisProvenance(
        { ...context, source: 'simulation' },
        ANALYSIS_ALGORITHMS.simulation,
        { ...serializableOptions },
        value.times,
        value.times.length,
      );
      value.provenance = provenance;
      if (value.metrics) attachAnalysisProvenance(value.metrics, provenance);
      return value;
    });
  }

  runStep(
    times: ArrayLike<number>,
    actual: ArrayLike<number>,
    target: ArrayLike<number> | number,
    options: StepAnalysisOptions = {},
    context?: AnalysisContext,
  ): CancellableAnalysis<StepAnalysisResult> {
    const requestId = nextClientId++;
    const targetLength = typeof target === 'number' ? 0 : target.length;
    if (Math.max(times.length, actual.length, targetLength) > this.options.maxSamples) {
      return this.rejected(requestId, `阶跃分析样本超过上限 ${this.options.maxSamples}`);
    }
    const request: AnalysisWorkerRequest = {
      type: 'step',
      id: requestId,
      times: Array.from(times),
      actual: Array.from(actual),
      target: typeof target === 'number' ? target : Array.from(target),
      options: snapshotAnalysisOptions(options),
    };
    const job = !this.workerFactory || this.disposed
      ? this.runFallback<StepAnalysisResult>(request)
      : this.dispatch<StepAnalysisResult>(request);
    return this.decorate(job, (value) => {
      const provenance = makeAnalysisProvenance(
        context,
        ANALYSIS_ALGORITHMS.step,
        { ...request.options, target: typeof target === 'number' ? target : { kind: 'channel-array', count: target.length } },
        request.times,
        times.length,
      );
      value.provenance = provenance;
      if (value.result) attachAnalysisProvenance(value.result, provenance);
      return value;
    });
  }

  runIdentification(
    times: ArrayLike<number>,
    values: ArrayLike<number>,
    options: IdentifyPlantOptions,
    context?: AnalysisContext,
  ): CancellableAnalysis<IdentifyPlantResult> {
    const requestId = nextClientId++;
    if (times.length !== values.length) return this.rejected(requestId, '系统辨识时间和值数量不一致');
    if (times.length > this.options.maxSamples) return this.rejected(requestId, `系统辨识样本超过上限 ${this.options.maxSamples}`);
    const { shouldCancel: _ignored, ...inputOptions } = options;
    let serializableOptions: typeof inputOptions;
    try { serializableOptions = snapshotAnalysisOptions(inputOptions); }
    catch (error) { return this.rejected(requestId, error instanceof Error ? error.message : String(error)); }
    const request: AnalysisWorkerRequest = {
      type: 'identify',
      id: requestId,
      times: Array.from(times),
      values: Array.from(values),
      options: serializableOptions,
    };
    const job = !this.workerFactory || this.disposed
      ? this.runFallback<IdentifyPlantResult>(request, options.shouldCancel)
      : this.dispatch<IdentifyPlantResult>(request);
    return this.decorate(job, (value) => {
      return attachAnalysisProvenance(value, makeAnalysisProvenance(
        context,
        ANALYSIS_ALGORITHMS.identify,
        serializableOptions,
        request.times,
        times.length,
      ));
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.worker.terminate();
      pending.reject(new Error('分析 Worker 已关闭'));
    }
    this.pending.clear();
  }

  private dispatch<T>(
    request: AnalysisWorkerRequest,
  ): CancellableAnalysis<T> {
    let worker: Worker;
    try {
      worker = this.workerFactory!(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      console.warn('[analysis-worker] 无法创建分析 Worker，回退到同步计算:', error);
      return this.runFallback<T>(request);
    }

    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(
        () => this.handleWorkerError(request.id, worker, `分析任务超过 ${this.options.timeoutMs} ms，已终止 Worker`),
        this.options.timeoutMs,
      );
      this.pending.set(request.id, {
        worker,
        timeout,
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        worker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => this.handleResponse(event.data, worker);
        worker.onerror = (event) => this.handleWorkerError(request.id, worker, event.message || '分析 Worker 发生错误');
        worker.postMessage(request);
      } catch (error) {
        this.pending.delete(request.id);
        clearTimeout(timeout);
        worker.terminate();
        reject(error);
      }
    });
    return {
      id: request.id,
      promise,
      cancel: () => {
        const pending = this.pending.get(request.id);
        if (!pending) return;
        this.pending.delete(request.id);
        clearTimeout(pending.timeout);
        pending.worker.terminate();
        pending.reject(new Error('分析任务已取消'));
      },
    };
  }

  private runFallback<T>(request: AnalysisWorkerRequest, externalShouldCancel?: () => boolean): CancellableAnalysis<T> {
    const sampleCount = request.type === 'fft'
      ? request.timestamps.length
      : request.type === 'identify'
        ? request.times.length
        : request.type === 'step'
          ? Math.max(request.times.length, request.actual.length, Array.isArray(request.target) ? request.target.length : 0)
          : 0;
    if (sampleCount > this.options.maxSyncFallbackSamples) {
      return this.rejected(request.id, `后台 Worker 不可用，样本超过同步回退上限 ${this.options.maxSyncFallbackSamples}`);
    }
    if (request.type === 'simulate' && Math.ceil((request.options.simTime ?? 1.5) / request.options.sampleTime) > this.options.maxSimulationSteps) {
      return this.rejected(request.id, `仿真步数超过上限 ${this.options.maxSimulationSteps}`);
    }
    let cancelled = false;
    const promise = Promise.resolve().then(() => {
      if (this.disposed) throw new Error('分析 Worker 已关闭');
      const shouldCancel = () => cancelled || Boolean(externalShouldCancel?.());
      if (shouldCancel()) throw new Error('分析任务已取消');
      let result: unknown;
      switch (request.type) {
        case 'fft': {
          const quality = inspectFftInput(request.timestamps, request.values, request.maxPoints);
          result = {
            quality,
            result: quality.valid ? computeFftSpectrum(request.timestamps, request.values, request.maxPoints) : null,
          } satisfies FftAnalysisResult;
          break;
        }
        case 'step': {
          const quality = inspectStepInput(request.times, request.actual, request.target, request.options);
          result = {
            quality,
            result: quality.valid
              ? extract_step_features(request.times, request.actual, request.target, request.options)
              : null,
          } satisfies StepAnalysisResult;
          break;
        }
        case 'identify':
          result = identifyPlant(request.times, request.values, { ...request.options, shouldCancel });
          break;
        case 'simulate':
          result = simulateClosedLoop({ ...request.options, shouldCancel });
          break;
      }
      return result as T;
    });
    return { id: request.id, promise, cancel: () => { cancelled = true; } };
  }

  private rejected<T>(id: number, message: string): CancellableAnalysis<T> {
    return { id, promise: Promise.reject(new Error(message)), cancel: () => undefined };
  }

  private decorate<T>(job: CancellableAnalysis<T>, decorateValue: (value: T) => T): CancellableAnalysis<T> {
    return {
      ...job,
      promise: job.promise.then(async (value) => {
        const decorated = decorateValue(value);
        const provenance = (decorated as { provenance?: AnalysisProvenance } | null)?.provenance;
        if (provenance) await persistAnalysisProvenance(provenance);
        return decorated;
      }),
    };
  }

  private handleWorkerError(id: number, worker: Worker, message: string): void {
    const pending = this.pending.get(id);
    if (!pending || pending.worker !== worker) return;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    worker.terminate();
    pending.reject(new Error(message));
  }

  private handleResponse(response: AnalysisWorkerResponse, worker: Worker): void {
    if (response.type === 'error') {
      const pending = this.pending.get(response.id);
      if (!pending || pending.worker !== worker) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timeout);
      worker.terminate();
      pending.reject(new Error(response.message));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending || pending.worker !== worker) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);
    worker.terminate();
    pending.resolve(response.type === 'fft-result' || response.type === 'step-result'
      ? { quality: response.quality, result: response.result }
      : response.result);
  }
}

export const analysisWorker = new AnalysisWorkerClient();
