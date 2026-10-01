import assert from 'node:assert/strict';
import { ChannelStore } from '../src/core/channel/ChannelStore';
import { createDefaultVofaPreset } from '../src/core/widget/schema';
import { globalWidgetRegistry } from '../src/core/widget/registry';
import { formatSidebarValue, projectSidebarChannels, sidebarSampleStatus, widgetChannelBindings } from '../src/core/channel/sidebarProjection';
import type { ChannelMeta, StepCardConfig } from '../src/types/widget';

export function runSidebarProjectionTests(): void {
  let checked = 0;
  const check = (run: () => void) => { run(); checked++; };
  const source = new ChannelStore(16);
  source.initPresetChannels(8);
  const project = (bindings: string[] = []) => projectSidebarChannels(source, bindings);
  check(() => assert.deepEqual(project(), []));
  check(() => assert.deepEqual(widgetChannelBindings(createDefaultVofaPreset().tabs[0].widgets), []));
  check(() => assert.deepEqual(widgetChannelBindings([
    globalWidgetRegistry.createInstance('chart', 0, 0, undefined, { auto_bind: true, series: [{ channel: 'old-auto-series', color: '#DA7756', visible: true }] }),
  ]), []));
  check(() => {
    const before = source.listChannels();
    assert.deepEqual(project(['missing', 'missing']), [{ id: 'missing', hasSamples: false, value: null }]);
    assert.deepEqual(source.listChannels(), before);
    assert.equal(source.getBuffer('missing', false), undefined);
  });
  check(() => {
    let atDiscovery = -1;
    const unsubscribe = source.onChannelsChanged(() => { atDiscovery = project().length; });
    source.pushSeries(['actual'], [1, 2], [[0.5, 0]]);
    assert.equal(atDiscovery, 0); // Discovery precedes insertion; later projection sees the first and only batch.
    assert.deepEqual(project(), [{ id: 'actual', hasSamples: true, value: 0 }]);
    unsubscribe();
  });
  check(() => assert.equal(formatSidebarValue(project()[0].value), '0.000000'));
  for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
    check(() => assert.equal(formatSidebarValue(value), '—'));
  }
  check(() => {
    source.setAlias('response', 'actual');
    assert.deepEqual(project(['response', '!response', 'actual']), [{ id: 'actual', hasSamples: true, value: 0 }]);
    assert.equal(source.listChannels().filter((id) => id === 'actual').length, 1);
  });
  check(() => {
    source.push('actual', 3, NaN);
    assert.deepEqual(project(), [{ id: 'actual', hasSamples: true, value: null }]);
    assert.equal(sidebarSampleStatus(project()[0], true), '无有效显示值');
  });
  for (const value of [Infinity, -Infinity]) {
    check(() => { source.push('actual', 4, value); assert.equal(project()[0].value, null); });
  }
  check(() => {
    source.push('actual', 5, 2);
    const metadata: Record<string, ChannelMeta> = Object.freeze({ actual: Object.freeze({
      id: 'actual', name: 'response', color: '#DA7756', visible: true, scale: 10, yOffset: 100, xOffset: 0, decimal: 3,
    }) });
    const snapshot = source.snapshot('actual');
    assert.equal(projectSidebarChannels(source, ['response'], metadata)[0].value, 120);
    assert.deepEqual(source.snapshot('actual'), snapshot);
    assert.equal(source.latest('actual')!.v, 2);
    assert.equal(formatSidebarValue(120, 3), '120.000');
  });
  check(() => {
    source.clear('response');
    assert.deepEqual(project(), []);
    assert.deepEqual(project(['response']), [{ id: 'actual', hasSamples: false, value: null }]);
    assert.equal(sidebarSampleStatus(project(['response'])[0], false), '等待数据');
  });
  check(() => {
    source.push('actual', 1, 7);
    source.push('keep', 1, 3);
    source.clear('actual');
    assert.deepEqual(project().map((row) => row.id), ['keep']);
    source.push('actual', 1, 7);
    assert.equal(sidebarSampleStatus(project()[0], false), '已停止 · 缓存读数');
    assert.equal(sidebarSampleStatus(project()[0], true), '缓冲读数');
    source.clear();
    source.setSessionContext('new', 2);
    source.pushSeries(['new-channel'], [1], [[9]]);
    assert.deepEqual(project().map((row) => row.id), ['new-channel']);
    assert.deepEqual(project(['response']).at(-1), { id: 'actual', hasSamples: false, value: null });
  });
  check(() => {
    const widgets = ['gauge', 'number', 'led', 'stat_card'].map((type) =>
      globalWidgetRegistry.createInstance(type as 'gauge', 0, 0, undefined, { channel: 'same' }));
    assert.deepEqual(widgetChannelBindings(widgets), ['same']);
  });
  check(() => {
    const widgets = [
      globalWidgetRegistry.createInstance('chart', 0, 0, undefined, { series: [{ channel: 'curve', color: '#DA7756', visible: true }], actual_channel: 'not-a-series', target_channel: 'not-a-series-either' }),
      globalWidgetRegistry.createInstance('slider', 0, 0, undefined, { command_template: 'do not treat as channel', feedback_channel: 'feedback' }),
      globalWidgetRegistry.createInstance('knob', 0, 0, undefined, { feedback_channel: 'feedback' }),
      globalWidgetRegistry.createInstance('button', 0, 0, undefined, { command_template: 'command-only' }),
      globalWidgetRegistry.createInstance('bode', 0, 0, undefined, { loop_id: 'loop-only' }),
      globalWidgetRegistry.createInstance('step_card', 0, 0, undefined, { actual_channel: 'response', target_channel: 10 }),
    ];
    assert.deepEqual(widgetChannelBindings(widgets), ['curve', 'feedback', 'response']);
    widgets.at(-1)!.config = { ...widgets.at(-1)!.config, target_channel: 'target' } as typeof widgets[number]['config'];
    assert.deepEqual(widgetChannelBindings(widgets).at(-1), 'target');
  });
  check(() => {
    assert.equal(formatSidebarValue(1, -5), '1');
    assert.equal(formatSidebarValue(1, 20), '1.000000');
    assert.equal(formatSidebarValue(1, 1.2), '1.000000');
  });
  const finiteSource = new ChannelStore(8);
  finiteSource.push('raw', 1, 2);
  const meta = (partial: Partial<ChannelMeta> = {}): ChannelMeta => ({
    id: 'raw', name: 'raw', color: '#DA7756', visible: true,
    scale: 1, yOffset: 0, xOffset: 0, decimal: 6, ...partial,
  });
  for (const field of ['scale', 'yOffset'] as const) {
    for (const invalid of [null, '', '0', false, NaN, Infinity, -Infinity]) {
      check(() => {
        const metadata = { raw: meta({ [field]: invalid } as unknown as Partial<ChannelMeta>) };
        assert.equal(projectSidebarChannels(finiteSource, [], metadata)[0].value, null,
          `${field}=${String(invalid)} must not be coerced into a measured zero`);
        assert.equal(finiteSource.latest('raw')!.v, 2);
      });
    }
    check(() => {
      const metadata = { raw: meta({ [field]: undefined }) };
      assert.equal(projectSidebarChannels(finiteSource, [], metadata)[0].value, 2,
        'Missing display fields retain the non-mutating identity fallback');
    });
  }
  check(() => {
    assert.equal(projectSidebarChannels(finiteSource, [], { raw: meta({ scale: Number.MAX_VALUE }) })[0].value, null);
    assert.equal(projectSidebarChannels(finiteSource, [], { raw: meta({ scale: 0, yOffset: 0 }) })[0].value, 0);
    assert.equal(finiteSource.latest('raw')!.v, 2);
  });
  check(() => {
    const metadata = Object.create({ raw: meta({ scale: 10, yOffset: 100 }) }) as Record<string, ChannelMeta>;
    assert.equal(projectSidebarChannels(finiteSource, [], metadata)[0].value, 2,
      'Inherited metadata is not an authored display configuration');
    assert.equal(Object.keys(metadata).length, 0);
  });
  check(() => {
    const unusual = new ChannelStore(8);
    unusual.push('constructor', 1, 0);
    unusual.push('toString', 1, 3);
    const metadata = Object.freeze({});
    assert.deepEqual(projectSidebarChannels(unusual, [], metadata), [
      { id: 'constructor', hasSamples: true, value: 0 },
      { id: 'toString', hasSamples: true, value: 3 },
    ]);
    assert.deepEqual(metadata, {});
  });
  check(() => {
    const distinct = new ChannelStore(8);
    distinct.push('first', 1, 1);
    distinct.push('second', 1, 2);
    const metadata = Object.freeze({ first: Object.freeze(meta({ id: 'first', name: 'same' })), second: Object.freeze(meta({ id: 'second', name: 'same' })) });
    assert.deepEqual(projectSidebarChannels(distinct, ['first', 'second'], metadata).map(row => row.id), ['first', 'second']);
    distinct.setAlias('second', 'first');
    assert.deepEqual(projectSidebarChannels(distinct, ['first', 'second'], metadata).map(row => row.id), ['first', 'second'],
      'Exact existing buffer IDs must not merge through conflicting aliases');
  });
  check(() => {
    const zeroTarget = globalWidgetRegistry.createInstance('step_card', 0, 0, undefined, { actual_channel: 'raw', target_channel: 0 });
    assert.deepEqual(widgetChannelBindings([zeroTarget]), ['raw']);
    assert.equal((zeroTarget.config as StepCardConfig).target_channel, 0);
  });
  check(() => {
    assert.equal(formatSidebarValue(0, Infinity), '0.000000');
    assert.equal(formatSidebarValue(0, NaN), '0.000000');
    assert.equal(formatSidebarValue(-0, 0), '0');
  });
  check(() => {
    const malformed = globalWidgetRegistry.createInstance('chart', 0, 0, undefined, { auto_bind: false, series: null });
    assert.deepEqual(widgetChannelBindings([malformed]), [], 'Malformed imported series must not crash the sidebar projection');
  });
  check(() => {
    const partiallyValid = globalWidgetRegistry.createInstance('chart', 0, 0, undefined, {
      auto_bind: false, series: [null, { channel: 'valid-curve', color: '#DA7756', visible: true }],
    });
    assert.deepEqual(widgetChannelBindings([partiallyValid]), ['valid-curve'], 'An invalid entry must not hide the remaining valid binding');
  });
  console.log(`Sidebar projection: ${checked} behavior checks passed; no storage or transport writes.`);
}
