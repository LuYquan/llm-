import assert from 'node:assert/strict';
import { AssistantEvidenceGuard, createFrozenSelection, selectionMatchesContext, selectionUploadEvidence, type CreateFrozenSelectionInput } from '../src/core/assistant/evidenceSelection';
import { assistantEvidenceSelection, assistantEvidenceSelectionRevision, clearEvidenceSelection, publishEvidenceSelection } from '../src/core/assistant/evidenceSelectionStore';

const base = (times: number[] = [1, 2, 3], values: number[] = [10, 20, 30]): CreateFrozenSelectionInput => ({
  context: { sessionId: 'evidence-session', epoch: 4, generation: 7, timeSource: 'unknown', source: 'live' },
  range: { from: 1, to: 3 }, sourceWidget: { id: 'chart-1', title: '调试波形' },
  channels: [{ canonicalId: '0', snapshot: { timestamps: new Float64Array(times), values: new Float64Array(values), count: times.length }, metadata: { name: '角速度', unit: 'rad/s', unitSource: 'user' } }],
});

{
  const input = base([0, 1, 2, 3, 4], [999, 10, NaN, 30, 888]);
  const frozen = createFrozenSelection(input);
  const ch = frozen.channels[0];
  assert.equal(ch.canonicalId, '0'); assert.equal(ch.label, '角速度 · 0'); assert.equal(ch.unit, 'rad/s'); assert.equal(ch.unitSource, 'user');
  assert.deepEqual(ch.counts, { selected: 3, valid: 2, rejectedNonFiniteValues: 1, retained: 2, omittedForLimit: 0 });
  assert.deepEqual(ch.samples, { timestamps: [1, 3], values: [10, 30] });
  assert.deepEqual(ch.summary, { scope: 'all-finite-samples-in-selected-cache', count: 2, from: 1, to: 3, min: 10, max: 30, mean: 20, last: 30 });
  input.channels[0].snapshot.values[1] = 123456;
  input.context.source = 'demo'; input.range.from = -99; input.channels[0].metadata!.unit = 'V';
  assert.equal(ch.samples.values[0], 10, 'original cache mutation cannot change frozen evidence');
  assert.equal(frozen.context.source, 'live'); assert.equal(frozen.range.from, 1); assert.equal(ch.unit, 'rad/s');
  assert.ok(Object.isFrozen(frozen)); assert.ok(Object.isFrozen(ch.samples.values));
  assert.ok([frozen.context, frozen.range, frozen.sourceWidget, frozen.channels, ch, ch.counts, ch.summary, ch.samples, ch.samples.timestamps].every(Object.isFrozen), 'all retained nested data is immutable');
  assert.throws(() => (ch.samples.values as number[]).push(42));
  assert.equal(selectionUploadEvidence(frozen, false), undefined, 'default opt-out has neither summaries nor raw arrays in the upload');
  assert.equal(selectionUploadEvidence(null, true), undefined);
  assert.equal(selectionUploadEvidence(frozen, true), frozen, 'explicit consent uses the same frozen payload');
  const restored = JSON.parse(JSON.stringify(frozen));
  assert.deepEqual(restored.channels[0].samples.values, [10, 30], 'JSON preview/upload retains raw finite numbers');
}
{
  const times = Array.from({ length: 1_000 }, (_, i) => i / 7); // deliberately not integer sample time
  const values = times.map((_, i) => i);
  const input = base(times, values); input.range = { from: 0, to: 1000 };
  const provisional = createFrozenSelection(input);
  const retainedIndices = new Set(provisional.channels[0].samples.values);
  const spike = values.findIndex(i => i > 0 && !retainedIndices.has(i));
  input.channels[0].snapshot.values[spike] = 50_000;
  const ch = createFrozenSelection(input).channels[0];
  assert.equal(ch.counts.selected, 1000); assert.equal(ch.counts.retained, 256); assert.equal(ch.counts.omittedForLimit, 744);
  assert.equal(ch.samples.timestamps[0], 0); assert.equal(ch.samples.timestamps[255], 999 / 7);
  assert.equal(ch.samples.values[255], 999); assert.equal(ch.samples.values.includes(50_000), false);
  assert.equal(ch.summary.max, 50_000, 'summary covers the full selected cache, including a point omitted from bounded upload');
  assert.equal(ch.sampling, 'uniform-original-indices-including-ends');
  ch.samples.timestamps.forEach((t, i) => assert.equal(input.channels[0].snapshot.timestamps[Math.round(i * 999 / 255)], t));
}
{
  const input = base([1, 1, 3], [-2, 4, 8]);
  assert.deepEqual(createFrozenSelection(input).channels[0].samples.values, [-2, 4, 8], 'same timestamp originals are retained without resampling or display scaling');
  input.channels[0].metadata = { name: '显示别名', unit: 'V' };
  assert.equal(createFrozenSelection(input).channels[0].unit, undefined, 'unattributed unit does not masquerade as firmware metadata');
  input.context.source = 'demo';
  assert.equal(createFrozenSelection(input).context.source, 'demo');
}
{
  const input = base();
  Object.assign(input.context, { uncheckedExtra: { mutable: true } });
  Object.assign(input.range, { uncheckedExtra: { mutable: true } });
  const selected = createFrozenSelection(input);
  assert.equal('uncheckedExtra' in selected.context, false, 'unknown nested context data is not retained as falsely immutable');
  assert.equal('uncheckedExtra' in selected.range, false);
  const extremes = base([1, 2, 3], [Number.MAX_VALUE, -Number.MAX_VALUE, 0]);
  assert.ok(Number.isFinite(createFrozenSelection(extremes).channels[0].summary.mean), 'finite opposite extremes do not overflow the full-range mean');
}
for (const input of [base([1, NaN, 3]), base([1, Infinity, 3]), base([1, 3, 2]), base([1, 2, 3], [NaN, Infinity, -Infinity])]) {
  assert.throws(() => createFrozenSelection(input), /时间无效|没有可用/);
}
{
  const input = base(); input.range.to = Infinity; assert.throws(() => createFrozenSelection(input), /时间范围/);
  input.range.to = 0; assert.throws(() => createFrozenSelection(input), /时间范围/);
  const countMismatch = base(); countMismatch.channels[0].snapshot.count = 2; assert.throws(() => createFrozenSelection(countMismatch), /长度无效/);
  const duplicated = base(); duplicated.channels.push({ ...duplicated.channels[0] }); assert.throws(() => createFrozenSelection(duplicated), /canonical/);
  const excess = base(); excess.channels = Array.from({ length: 9 }, (_, i) => ({ ...excess.channels[0], canonicalId: `${i}` })); assert.throws(() => createFrozenSelection(excess), /1–8/);
  const maxChannels = base(); maxChannels.channels = Array.from({ length: 8 }, (_, i) => ({ ...maxChannels.channels[0], canonicalId: `${i}` }));
  assert.equal(createFrozenSelection(maxChannels).channels.length, 8, 'exact channel limit remains usable');
  const excessiveInput = base(Array.from({ length: 50_001 }, (_, i) => i), Array(50_001).fill(1));
  assert.throws(() => createFrozenSelection(excessiveInput), /长度无效/, 'bounded upload also rejects an unbounded cache input');
  const hiddenId = base(); hiddenId.channels[0].canonicalId = '1\u202e2'; assert.throws(() => createFrozenSelection(hiddenId), /通道 ID/);
  const invalidGeneration = base(); invalidGeneration.context.generation = -1; assert.throws(() => createFrozenSelection(invalidGeneration), /会话身份/);
}
{
  const selected = createFrozenSelection(base());
  assert.equal(selectionMatchesContext(selected, { sessionId: 'evidence-session', epoch: 4, generation: 7 }), true);
  for (const different of [{ sessionId: 'other', epoch: 4, generation: 7 }, { sessionId: 'evidence-session', epoch: 5, generation: 7 }, { sessionId: 'evidence-session', epoch: 4, generation: 8 }]) assert.equal(selectionMatchesContext(selected, different), false);
  const revision = assistantEvidenceSelectionRevision.value;
  publishEvidenceSelection(selected);
  assert.equal(assistantEvidenceSelectionRevision.value, revision + 1);
  assert.equal(assistantEvidenceSelection.value!.channels[0].samples.values[0], 10);
  clearEvidenceSelection(); assert.equal(assistantEvidenceSelection.value, null);
  assert.equal(assistantEvidenceSelectionRevision.value, revision + 2);
}
{
  const guard = new AssistantEvidenceGuard();
  const key = 'session/epoch/generation/protocol/config/selection/options';
  const token = guard.capture(key);
  assert.equal(guard.accepts(token, key), true, 'additional live samples do not change the identity key of frozen history');
  assert.equal(guard.accepts(token, `${key}/changed-selection`), false);
  assert.equal(guard.accepts(token, `${key}/changed-options`), false);
  guard.cancel(); assert.equal(guard.accepts(token, key), false, 'cancel invalidates a prior reply even when its evidence key is unchanged');
  const delayed = guard.capture(key);
  let complete: (() => void) | undefined;
  const lateReply = new Promise<void>(resolve => { complete = resolve; }).then(() => guard.accepts(delayed, key));
  guard.cancel(); complete!();
  assert.equal(await lateReply, false, 'a response which arrives after cancellation is rejected');
}
console.log('✓ assistant selection evidence: immutable original values, bounded opt-in payload, full-range summaries, invalid samples, source identity and stale/cancelled replies');
