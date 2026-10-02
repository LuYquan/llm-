import { readonly, ref, shallowRef } from 'vue';
import type { EvidenceSelection } from './evidenceSelection';

const selection = shallowRef<EvidenceSelection | null>(null);
const revision = ref(0);
export const assistantEvidenceSelection = readonly(selection);
export const assistantEvidenceSelectionRevision = readonly(revision);

/** Publication only prepares local evidence; it grants no AI upload or device action. */
export function publishEvidenceSelection(value: EvidenceSelection): void {
  selection.value = value;
  revision.value++;
}
export function clearEvidenceSelection(): void {
  selection.value = null;
  revision.value++;
}
