import type { FftInputQuality, FftResult } from '../../core/analysis/fft';
import type { StepAnalysisOptions, StepResponseMetrics } from '../../core/analysis/types';
import type { StepInputQuality } from '../../core/analysis/extractStepFeatures';
import type { IdentifyPlantOptions, IdentifyPlantResult, SimulateClosedLoopOptions, SimulateClosedLoopResult } from '../../core/control/types';

export type AnalysisWorkerRequest =
  | {
      type: 'fft';
      id: number;
      timestamps: number[];
      values: number[];
      maxPoints: number;
    }
  | {
      type: 'simulate';
      id: number;
      options: Omit<SimulateClosedLoopOptions, 'shouldCancel'>;
    }
  | {
      type: 'step';
      id: number;
      times: number[];
      actual: number[];
      target: number[] | number;
      options: StepAnalysisOptions;
    }
  | {
      type: 'identify';
      id: number;
      times: number[];
      values: number[];
      options: Omit<IdentifyPlantOptions, 'shouldCancel'>;
    };

export type AnalysisWorkerResponse =
  | {
      type: 'fft-result';
      id: number;
      quality: FftInputQuality;
      result: FftResult | null;
    }
  | {
      type: 'simulate-result';
      id: number;
      result: SimulateClosedLoopResult;
    }
  | {
      type: 'step-result';
      id: number;
      quality: StepInputQuality;
      result: StepResponseMetrics | null;
    }
  | {
      type: 'identify-result';
      id: number;
      result: IdentifyPlantResult;
    }
  | {
      type: 'error';
      id: number;
      message: string;
      cancelled?: boolean;
    };
