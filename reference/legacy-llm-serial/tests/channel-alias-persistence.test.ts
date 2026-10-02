import assert from 'node:assert/strict';
import { ChannelStore, globalChannelStore, MAX_OWNED_ALIAS_DECLARATIONS } from '../src/core/channel/ChannelStore';
import { createDefaultVofaPreset, createNewWidget, useWidgetStore } from '../src/stores/widgetStore';
import type { ChannelMeta, ChartConfig, StepCardConfig } from '../src/types/widget';

export function runChannelAliasPersistenceTests(): void {
  let checked = 0;
  const check = (run: () => void) => { run(); checked++; };
  const metadata = (id: string, name: string): ChannelMeta => ({ id, name, color: '#7AA89B', visible: true, scale: 1, yOffset: 0, xOffset: 0, decimal: 3 });

  check(() => {
    const channels = new ChannelStore(16);
    const owner = Symbol('workspace');
    const before = channels.listChannels();
    const result = channels.replaceOwnedAliases(owner, [{ alias: '姿态角', targetId: 'actual' }]);
    assert.equal(result.conflicts.length, 0);
    assert.equal(channels.resolveChannelKey('姿态角'), 'actual');
    assert.equal(channels.resolveChannelKey('!姿态角'), 'actual');
    assert.equal(channels.getBuffer('姿态角', false), undefined);
    assert.deepEqual(channels.listChannels(), before, 'restoring waiting aliases must not allocate buffers');
    channels.push('actual', 1, 0.25);
    assert.equal(channels.getBuffer('姿态角', false), channels.getBuffer('actual', false));
    assert.equal(channels.latest('姿态角')?.v, 0.25);
  });

  check(() => {
    const channels = new ChannelStore(16);
    const owner = Symbol('workspace');
    channels.replaceOwnedAliases(owner, [{ alias: 'old-angle', targetId: 'actual' }]);
    channels.replaceOwnedAliases(owner, [{ alias: 'new-angle', targetId: 'actual' }]);
    assert.equal(channels.getOwnedAliasTarget(owner, 'old-angle'), null);
    assert.equal(channels.resolveChannelKey('old-angle'), 'old-angle');
    assert.equal(channels.resolveChannelKey('!old-angle'), '!old-angle');
    assert.equal(channels.resolveChannelKey('new-angle'), 'actual');
    channels.replaceOwnedAliases(owner, []);
    assert.equal(channels.resolveChannelKey('new-angle'), 'new-angle');
  });

  check(() => {
    const channels = new ChannelStore(16);
    const owner = Symbol('workspace');
    channels.push('raw-name', 1, 20);
    channels.push('actual', 1, 10);
    const before = channels.snapshot('raw-name');
    const result = channels.replaceOwnedAliases(owner, [{ alias: 'raw-name', targetId: 'actual' }]);
    assert.ok(result.conflicts.some(item => item.reason === 'raw-channel-conflict'));
    assert.equal(channels.resolveChannelKey('raw-name'), 'raw-name');
    assert.equal(channels.getOwnedAliasTarget(owner, '!raw-name'), null, 'alias pair must be rejected atomically');
    assert.deepEqual(channels.snapshot('raw-name'), before);
  });

  check(() => {
    const channels = new ChannelStore(16);
    const owner = Symbol('workspace');
    const otherOwner = Symbol('other');
    channels.replaceOwnedAliases(otherOwner, [{ alias: 'claimed', targetId: 'external' }]);
    channels.setAlias('unowned', 'external-two');
    const result = channels.replaceOwnedAliases(owner, [{ alias: 'claimed', targetId: 'actual' }, { alias: 'unowned', targetId: 'actual' }]);
    assert.equal(result.conflicts.filter(item => item.reason === 'alias-conflict').length, 2);
    channels.replaceOwnedAliases(owner, []);
    assert.equal(channels.resolveChannelKey('claimed'), 'external');
    assert.equal(channels.resolveChannelKey('unowned'), 'external-two');
  });

  check(() => {
    const channels = new ChannelStore(16);
    const owner = Symbol('workspace');
    const entries = [{ alias: 'shared', targetId: 'first' }, { alias: '!shared', targetId: 'second' }];
    const before = channels.replaceOwnedAliases(owner, entries);
    const after = channels.replaceOwnedAliases(owner, [...entries].reverse());
    assert.equal(before.conflicts.filter(item => item.reason === 'duplicate-alias').length, 2);
    assert.deepEqual(after, before, 'duplicate declarations must not depend on metadata insertion order');
    assert.equal(channels.resolveChannelKey('shared'), 'shared');
    assert.equal(channels.getBuffer('first', false), undefined);
    assert.equal(channels.getBuffer('second', false), undefined);
  });

  check(() => {
    const channels = new ChannelStore(16);
    const owner = Symbol('workspace');
    const result = channels.replaceOwnedAliases(owner, [{ alias: 'other-canonical', targetId: 'actual' }, { alias: 'other-label', targetId: 'other-canonical' }]);
    assert.ok(result.conflicts.some(item => item.alias === 'other-canonical' && item.reason === 'canonical-key-conflict'));
    assert.equal(channels.resolveChannelKey('other-canonical'), 'other-canonical');
    assert.equal(channels.resolveChannelKey('other-label'), 'other-canonical');
  });

  check(() => {
    const channels = new ChannelStore(16);
    const owner = Symbol('workspace');
    channels.initPresetChannels(1);
    channels.replaceOwnedAliases(owner, [{ alias: 'RPM', targetId: '!0' }]);
    assert.equal(channels.resolveChannelKey('0'), '!0');
    assert.equal(channels.resolveChannelKey('RPM'), '!0');
    const conflict = channels.replaceOwnedAliases(owner, [{ alias: '0', targetId: 'actual' }]);
    assert.ok(conflict.conflicts.length > 0);
    assert.equal(channels.resolveChannelKey('0'), '!0');
    assert.equal(channels.resolveChannelKey('!0'), '!0');
    channels.replaceOwnedAliases(owner, [{ alias: '!17', targetId: 'actual' }]);
    assert.equal(channels.resolveChannelKey('17'), 'actual');
    assert.equal(channels.resolveChannelKey('!17'), 'actual');
  });

  check(() => {
    const channels = new ChannelStore(16);
    const owner = Symbol('workspace');
    channels.replaceOwnedAliases(owner, [{ alias: 'waiting', targetId: 'actual' }]);
    // A real buffer with the exact requested identifier always wins a read.
    channels.replaceOwnedAliases(owner, []);
    channels.push('waiting', 1, 99);
    channels.replaceOwnedAliases(owner, [{ alias: 'waiting', targetId: 'actual' }]);
    assert.equal(channels.resolveChannelKey('waiting'), 'waiting');
    assert.equal(channels.latest('waiting')?.v, 99);
  });

  check(() => {
    const channels = new ChannelStore(16);
    const owner = Symbol('workspace');
    const result = channels.replaceOwnedAliases(owner, [
      { alias: 'bad\nname', targetId: 'actual' },
      { alias: 'bad\u200bname', targetId: 'actual' },
      { alias: 'x'.repeat(129), targetId: 'actual' },
      { alias: 'valid', targetId: 'actual' },
    ]);
    assert.equal(result.conflicts.filter(item => item.reason === 'invalid-alias').length, 3);
    assert.equal(channels.resolveChannelKey('valid'), 'actual');
    assert.deepEqual(channels.listChannels(), []);
    const declarations = Array.from({ length: MAX_OWNED_ALIAS_DECLARATIONS + 1 }, (_, index) => ({ alias: `label-${String(index).padStart(4, '0')}`, targetId: `channel-${String(index).padStart(4, '0')}` }));
    const limited = channels.replaceOwnedAliases(owner, declarations);
    assert.equal(limited.accepted.length, MAX_OWNED_ALIAS_DECLARATIONS);
    assert.equal(limited.conflicts.filter(item => item.reason === 'capacity').length, 1);
    assert.deepEqual(channels.listChannels(), []);
  });

  check(() => {
    const channels = new ChannelStore(16);
    const owner = Symbol('workspace');
    channels.replaceOwnedAliases(owner, [{ alias: 'claimed-later', targetId: 'actual' }]);
    channels.setAlias('claimed-later', 'external');
    channels.replaceOwnedAliases(owner, []);
    assert.equal(channels.resolveChannelKey('claimed-later'), 'external', 'workspace cleanup must not remove a later external registration');
    assert.equal(channels.resolveChannelKey('!claimed-later'), 'external');
  });

  const store = useWidgetStore();
  const previousDashboard = store.dashboardState.value;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  let save: (() => void) | null = null;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: (callback: () => void) => { save = callback; return 0; } } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  try {
    const raw = createDefaultVofaPreset();
    raw.channels = { 'alias-test-actual': metadata('alias-test-actual', 'alias-test-angle') };
    (raw.tabs[0].widgets[0].config as ChartConfig).series = [{ channel: 'alias-test-angle', color: '#7AA89B', visible: true }];
    values.set('llm-serial.vofa-dashboard.v2', JSON.stringify(raw));

    check(() => {
      const before = globalChannelStore.listChannels();
      store.loadDashboard();
      assert.equal(globalChannelStore.resolveChannelKey('alias-test-angle'), 'alias-test-actual');
      assert.deepEqual(globalChannelStore.listChannels(), before);
      assert.equal((store.dashboardState.value.tabs[0].widgets[0].config as ChartConfig).series[0].channel, 'alias-test-actual');
      assert.equal(store.channelAliasConflicts.value.length, 0);
      assert.equal(store.getChannelMeta('alias-test-actual').name, 'alias-test-angle');
    });
    check(() => {
      store.renameChannel('alias-test-actual', 'alias-test-new-angle');
      assert.equal(globalChannelStore.resolveChannelKey('alias-test-angle'), 'alias-test-angle');
      assert.equal(globalChannelStore.resolveChannelKey('alias-test-new-angle'), 'alias-test-actual');
      assert.equal((store.dashboardState.value.tabs[0].widgets[0].config as ChartConfig).series[0].channel, 'alias-test-actual');
      save!();
      store.resetToDefault();
      store.loadDashboard();
      assert.equal(globalChannelStore.resolveChannelKey('alias-test-new-angle'), 'alias-test-actual');
      assert.equal(store.getChannelMeta('alias-test-actual').name, 'alias-test-new-angle');
    });
    check(() => {
      const replacement = createDefaultVofaPreset();
      replacement.channels = { 'alias-test-next': metadata('alias-test-next', 'alias-test-next-label') };
      const imported = store.importDashboardJson(JSON.stringify(replacement));
      assert.equal(imported.ok, true);
      assert.equal(globalChannelStore.resolveChannelKey('alias-test-new-angle'), 'alias-test-new-angle');
      assert.equal(globalChannelStore.resolveChannelKey('alias-test-next-label'), 'alias-test-next');
      const before = store.exportDashboardJson();
      const failed = store.importDashboardJson('{broken');
      assert.equal(failed.ok, false);
      assert.equal(store.exportDashboardJson(), before);
      assert.equal(globalChannelStore.resolveChannelKey('alias-test-next-label'), 'alias-test-next');
    });
    check(() => {
      const bindings = createDefaultVofaPreset();
      bindings.channels = { 'alias-test-data': { ...metadata('misleading-id', 'alias-test-label'), unit: 'rad', unitSource: 'user' } };
      const chart = bindings.tabs[0].widgets[0];
      Object.assign(chart.config, { series: [{ channel: 'alias-test-label', color: '#7AA89B', visible: true }], actual_channel: 'alias-test-label', target_channel: 'unknown-label' });
      const gauge = createNewWidget('gauge', 0, 0);
      Object.assign(gauge.config, { channel: 'alias-test-label' });
      const slider = createNewWidget('slider', 0, 0);
      Object.assign(slider.config, { feedback_channel: 'alias-test-label', command_template: 'alias-test-label', unit: 'alias-test-label' });
      const step = createNewWidget('step_card', 0, 0);
      Object.assign(step.config, { actual_channel: 'alias-test-label', target_channel: 0 });
      const button = createNewWidget('button', 0, 0);
      Object.assign(button.config, { channel: 'alias-test-label', command_template: 'alias-test-label' });
      bindings.tabs[0].widgets.push(gauge, slider, step, button);
      assert.equal(store.importDashboardJson(JSON.stringify(bindings)).ok, true);
      const configs = store.dashboardState.value.tabs[0].widgets.map(widget => widget.config as unknown as Record<string, unknown>);
      assert.equal((configs[0] as unknown as ChartConfig).series[0].channel, 'alias-test-data');
      assert.equal(configs[0].actual_channel, 'alias-test-data');
      assert.equal(configs[0].target_channel, 'unknown-label', 'unregistered names cannot establish a canonical binding');
      assert.equal(configs[1].channel, 'alias-test-data');
      assert.equal(configs[2].feedback_channel, 'alias-test-data');
      assert.equal(configs[2].command_template, 'alias-test-label');
      assert.equal(configs[2].unit, 'alias-test-label');
      assert.equal(configs[3].actual_channel, 'alias-test-data');
      assert.equal((configs[3] as unknown as StepCardConfig).target_channel, 0, 'numeric targets remain numbers');
      assert.equal(configs[4].channel, 'alias-test-label', 'unrelated same-named fields on button config stay untouched');
      assert.equal(configs[4].command_template, 'alias-test-label');
      assert.equal(globalChannelStore.resolveChannelKey('alias-test-label'), 'alias-test-data', 'metadata map key supplies canonical identity, not meta.id');
      assert.equal(store.getChannelMeta('alias-test-data').id, 'alias-test-data', 'editing metadata must preserve the same key-derived identity');
      assert.equal(store.getChannelMeta('alias-test-data').unit, 'rad');
      store.updateChannelMeta('alias-test-data', { name: 'alias-test-changed' });
      assert.equal(globalChannelStore.resolveChannelKey('alias-test-label'), 'alias-test-label');
      assert.equal(globalChannelStore.resolveChannelKey('alias-test-changed'), 'alias-test-data');
    });
    check(() => {
      const prototypes = createDefaultVofaPreset();
      assert.equal(store.importDashboardJson(JSON.stringify(prototypes)).ok, true);
      const before = globalChannelStore.listChannels();
      for (const id of ['__proto__', 'constructor', 'toString']) {
        const meta = store.getChannelMeta(id);
        assert.equal(meta.id, id);
        assert.equal(typeof meta, 'object');
        assert.equal(Object.prototype.hasOwnProperty.call(store.dashboardState.value.channels, id), true);
        store.updateChannelMeta(id, { unit: 'rad', unitSource: 'user', name: `prototype-label-${id}` });
        assert.equal(store.getChannelMeta(id).unit, 'rad');
        assert.equal(globalChannelStore.resolveChannelKey(`prototype-label-${id}`), id);
      }
      assert.equal(Object.getPrototypeOf(store.dashboardState.value.channels!), Object.prototype);
      assert.deepEqual(globalChannelStore.listChannels(), before);
      save!();
      const serialized = JSON.parse(values.get('llm-serial.vofa-dashboard.v2')!);
      assert.equal(Object.prototype.hasOwnProperty.call(serialized.channels, '__proto__'), true);
      assert.equal(serialized.channels.__proto__.id, '__proto__');
      store.resetToDefault();
      store.loadDashboard();
      assert.equal(store.getChannelMeta('__proto__').unitSource, 'user');
      assert.equal(store.getChannelMeta('constructor').name, 'prototype-label-constructor');
      assert.equal(globalChannelStore.resolveChannelKey('prototype-label-toString'), 'toString');
      assert.equal(Object.getPrototypeOf(store.dashboardState.value.channels!), Object.prototype);
    });
    check(() => {
      const conflict = createDefaultVofaPreset();
      conflict.channels = { 'alias-test-one': metadata('alias-test-one', 'alias-test-duplicate'), 'alias-test-two': metadata('alias-test-two', 'alias-test-duplicate') };
      assert.equal(store.importDashboardJson(JSON.stringify(conflict)).ok, true);
      assert.equal(store.channelAliasConflicts.value.filter(item => item.reason === 'duplicate-alias').length, 2);
      assert.equal(globalChannelStore.resolveChannelKey('alias-test-duplicate'), 'alias-test-duplicate');
      assert.equal(store.getChannelMeta('alias-test-one').name, 'alias-test-duplicate', 'conflict does not erase display metadata');
      store.resetToDefault();
      assert.equal(store.channelAliasConflicts.value.length, 0);
    });
  } finally {
    values.set('llm-serial.vofa-dashboard.v2', JSON.stringify(previousDashboard));
    store.loadDashboard();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as { window?: unknown }).window;
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  console.log(`通道别名持久化、冲突和工作区恢复检查：${checked} 项通过。`);
}
