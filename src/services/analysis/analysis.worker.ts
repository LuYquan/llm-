import { computeFftSpectrum, inspectFftInput } from '../../core/analysis/fft';
import { extract_step_features, inspectStepInput } from '../../core/analysis/extractStepFeatures';
import { identifyPlant } from '../../core/control/identifyPlant';
import { simulateClosedLoop } from '../../core/control/simulateClosedLoop';
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-worker-protocol';

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<AnalysisWorkerRequest>) => void) | null;
  postMessage(message: AnalysisWorkerResponse): void;
};

function postError(id: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  workerScope.postMessage({
    type: 'error',
    id,
    message: message === 'ANALYSIS_CANCELLED' ? '分析任务已取消' : message,
  });
}

workerScope.onmessage = (event) => {
  const request = event.data;
  if (!request) return;
  try {
    if (request.type === 'fft') {
      const quality = inspectFftInput(request.timestamps, request.values, request.maxPoints);
      const result = quality.valid
        ? computeFftSpectrum(request.timestamps, request.values, request.maxPoints)
        : null;
      workerScope.postMessage({ type: 'fft-result', id: request.id, quality, result });
      return;
    }

    if (request.type === 'step') {
      const quality = inspectStepInput(request.times, request.actual, request.target, request.options);
      const result = quality.valid
        ? extract_step_features(request.times, request.actual, request.target, request.options)
        : null;
      workerScope.postMessage({ type: 'step-result', id: request.id, quality, result });
      return;
    }

    if (request.type === 'identify') {
      const result = identifyPlant(request.times, request.values, request.options);
      workerScope.postMessage({ type: 'identify-result', id: request.id, result });
      return;
    }

    const result = simulateClosedLoop(request.options);
    workerScope.postMessage({ type: 'simulate-result', id: request.id, result });
  } catch (error) {
    postError(request.id, error);
  }
};
