import { invoke, isTauri } from '@tauri-apps/api/core';
import type { AnalysisProvenance } from '../../core/analysis/provenance';

const HISTORY_KEY = 'llm_serial_analysis_history_v1';
const MAX_HISTORY_ENTRIES = 256;
const MAX_HISTORY_BYTES = 256 * 1024;

export interface AnalysisHistoryEntry extends AnalysisProvenance {
  recordedAtMs: number;
}

function readHistory(): AnalysisHistoryEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const sources = new Set(['live', 'replay', 'simulation', 'manual', 'unknown']);
    return parsed.filter((entry): entry is AnalysisHistoryEntry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const value = entry as Record<string, unknown>;
      const interval = value.interval;
      const algorithm = value.algorithm;
      const channels = value.channelIds;
      const parameters = value.parameters;
      if (!sources.has(String(value.source)) || !Array.isArray(channels)
        || channels.some((channel) => typeof channel !== 'string')
        || !Number.isFinite(value.sampleCount) || Number(value.sampleCount) < 0
        || !Number.isFinite(value.recordedAtMs)
        || !interval || typeof interval !== 'object' || Array.isArray(interval)
        || !algorithm || typeof algorithm !== 'object' || Array.isArray(algorithm)
        || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return false;
      const intervalValue = interval as Record<string, unknown>;
      const algorithmValue = algorithm as Record<string, unknown>;
      const validTime = (time: unknown) => time === null || Number.isFinite(time);
      return typeof algorithmValue.id === 'string'
        && typeof algorithmValue.version === 'string'
        && validTime(intervalValue.start)
        && validTime(intervalValue.end);
    });
  } catch {
    return [];
  }
}

function persistBrowserHistory(provenance: AnalysisProvenance): void {
  if (typeof localStorage === 'undefined') return;
  const entry: AnalysisHistoryEntry = {
    ...provenance,
    recordedAtMs: Date.now(),
  };
  const next = [...readHistory(), entry].slice(-MAX_HISTORY_ENTRIES);
  const serialized = JSON.stringify(next);
  if (serialized.length > MAX_HISTORY_BYTES) {
    // Keep the newest entries while bounding browser storage. Provenance is
    // evidence metadata; it must never make the analysis result unavailable.
    let bounded = next;
    while (bounded.length > 1 && JSON.stringify(bounded).length > MAX_HISTORY_BYTES) {
      bounded = bounded.slice(1);
    }
    localStorage.setItem(HISTORY_KEY, JSON.stringify(bounded));
    return;
  }
  localStorage.setItem(HISTORY_KEY, serialized);
}

function notifyHistoryUpdated(): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(new CustomEvent('llm-serial-analysis-history-updated'));
  } catch {
    // Older embedded WebViews may not expose CustomEvent; persistence still succeeds.
  }
}

/**
 * Persist analysis provenance locally and, when running in Tauri, append the
 * same structured payload to the active recording's events.jsonl. A missing
 * active recording is expected for live unrecorded analysis and is ignored;
 * recording failures are logged without invalidating the already computed
 * result.
 */
export async function persistAnalysisProvenance(provenance: AnalysisProvenance): Promise<void> {
  try {
    persistBrowserHistory(provenance);
    notifyHistoryUpdated();
  } catch (error) {
    console.warn('[analysis-history] 浏览器分析历史保存失败:', error);
  }

  if (typeof window === 'undefined' || !isTauri()) return;
  try {
    await invoke('append_analysis_event', { provenance });
  } catch (error) {
    console.warn('[analysis-history] 桌面记录未能追加分析溯源:', error);
  }
}

export function loadAnalysisHistory(): AnalysisHistoryEntry[] {
  return readHistory();
}

export function clearAnalysisHistory(): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {}
  }
}
