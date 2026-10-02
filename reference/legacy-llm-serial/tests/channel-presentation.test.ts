import assert from 'node:assert/strict';
import { CHANNEL_UNIT_MAX_LENGTH, normalizeChannelUnitMetadata, presentChannel } from '../src/core/channel/channelPresentation';
import { createDefaultVofaPreset, validateAndMigrateDashboard } from '../src/core/widget/schema';
import { useWidgetStore } from '../src/stores/widgetStore';
import { ChannelStore, globalChannelStore } from '../src/core/channel/ChannelStore';
import type { ChannelMeta } from '../src/types/widget';

export function runChannelPresentationTests(): void {
  let checked = 0;
  const check = (run: () => void) => { run(); checked += 1; };
  const meta: ChannelMeta = { id: 'speed', name: '转速', color: '#DA7756', visible: true, scale: 1, yOffset: 0, xOffset: 0, decimal: 6 };
  const dashboard = (channel: unknown) => ({ ...createDefaultVofaPreset(), channels: { speed: channel } });

  check(() => assert.deepEqual(normalizeChannelUnitMetadata({}), {}));
  check(() => assert.deepEqual(normalizeChannelUnitMetadata({ unit: ' rpm ', unitSource: 'user' }), { unit: 'rpm', unitSource: 'user' }));
  check(() => assert.deepEqual(normalizeChannelUnitMetadata({ unit: undefined, unitSource: undefined }), {}));
  for (const unit of [null, 1, {}, [], '', '   ', 'x'.repeat(CHANNEL_UNIT_MAX_LENGTH + 1), '😀'.repeat(13)]) {
    check(() => assert.throws(() => normalizeChannelUnitMetadata({ unit, unitSource: 'user' })));
  }
  for (const control of [0, 9, 10, 13, 0x7f, 0x200b, 0x202e, 0x2028, 0x2029]) {
    check(() => assert.throws(() => normalizeChannelUnitMetadata({ unit: `m${String.fromCodePoint(control)}/s`, unitSource: 'user' })));
  }
  check(() => assert.throws(() => normalizeChannelUnitMetadata({ unit: 'rpm' })));
  check(() => assert.throws(() => normalizeChannelUnitMetadata({ unitSource: 'user' })));
  for (const unitSource of ['firmware', '', null, true]) {
    check(() => assert.throws(() => normalizeChannelUnitMetadata({ unit: 'rpm', unitSource })));
  }
  check(() => {
    const accessor = Object.defineProperty({}, 'unit', { enumerable: true, get: () => { throw new Error('must not execute'); } });
    assert.throws(() => normalizeChannelUnitMetadata(accessor), /普通数据字段/);
  });

  check(() => {
    assert.deepEqual(presentChannel('speed', { name: '转速', unit: 'rpm', unitSource: 'user' }),
      { id: 'speed', label: '转速 · speed', alias: '转速', unit: 'rpm', unitSource: 'user' });
    assert.deepEqual(presentChannel('speed', { name: 'speed' }), { id: 'speed', label: 'speed' });
    assert.deepEqual(presentChannel('!0'), { id: '!0', label: '!0' });
  });
  check(() => {
    assert.deepEqual(presentChannel('speed', { name: '转速', unit: 'rpm', unitSource: 'firmware' }), { id: 'speed', label: '转速 · speed', alias: '转速' });
    assert.deepEqual(presentChannel('speed', { name: 'bad\nlabel' }), { id: 'speed', label: 'speed' });
    assert.deepEqual(presentChannel('speed', { name: 'x'.repeat(129) }), { id: 'speed', label: 'speed' });
  });
  check(() => {
    const source = Object.freeze({ name: '转速', unit: 'rpm', unitSource: 'user', scale: 100, yOffset: -2 });
    const samples = new ChannelStore(16);
    samples.push('speed', 1, 12.5);
    const before = samples.snapshot('speed');
    presentChannel('speed', source);
    assert.deepEqual(samples.snapshot('speed'), before);
    assert.equal(source.scale, 100);
  });

  check(() => {
    const legacy = validateAndMigrateDashboard(dashboard(meta));
    assert.equal(legacy.ok, true);
    assert.ok(!Object.hasOwn(legacy.data!.channels!.speed, 'unit'));
    assert.ok(!Object.hasOwn(legacy.data!.channels!.speed, 'unitSource'));
  });
  check(() => {
    const channel = { ...meta, unit: ' rpm ', unitSource: 'user' };
    const input = dashboard(channel);
    const imported = validateAndMigrateDashboard(JSON.parse(JSON.stringify(input)));
    assert.equal(imported.ok, true);
    assert.equal(imported.data!.channels!.speed.unit, 'rpm');
    assert.equal(imported.data!.channels!.speed.unitSource, 'user');
    assert.equal(channel.unit, ' rpm ');
  });
  check(() => {
    for (const invalid of [{ unit: 123, unitSource: 'user' }, { unit: 'rpm' }, { unitSource: 'user' },
      { unit: 'm\ns', unitSource: 'user' }, { unit: 'x'.repeat(25), unitSource: 'user' }, { unit: 'rpm', unitSource: 'firmware' }]) {
      const imported = validateAndMigrateDashboard(dashboard({ ...meta, ...invalid }));
      assert.equal(imported.ok, false);
      assert.match(imported.error!, /原始单位/);
    }
    assert.equal(validateAndMigrateDashboard(dashboard(null)).ok, false);
    assert.equal(validateAndMigrateDashboard({ ...createDefaultVofaPreset(), channels: [] }).ok, false);
  });

  // All storage below is synthetic and scoped to the test; no user storage is read.
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = useWidgetStore();
  const previousDashboard = store.dashboardState.value;
  const values = new Map<string, string>();
  let save: (() => void) | null = null;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: (callback: () => void) => { save = callback; return 0; } } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  try {
    store.dashboardState.value = createDefaultVofaPreset();
    check(() => {
      const before = globalChannelStore.snapshot('!0');
      store.updateChannelMeta('!0', { unit: 'rpm', unitSource: 'user', scale: 100, yOffset: -5 });
      assert.deepEqual(globalChannelStore.snapshot('!0'), before);
      assert.equal(store.getChannelMeta('!0').unit, 'rpm');
      assert.equal(store.getChannelMeta('!0').unitSource, 'user');
      save!();
      const serialized = JSON.parse(values.get('llm-serial.vofa-dashboard.v2')!);
      assert.equal(serialized.channels['!0'].unit, 'rpm');
      assert.equal(serialized.channels['!0'].unitSource, 'user');
      const loaded = store.loadDashboard();
      assert.equal(loaded.channels!['!0'].unit, 'rpm');
    });
    check(() => {
      const before = JSON.stringify(store.getChannelMeta('!0'));
      assert.throws(() => store.updateChannelMeta('!0', { unit: 'm\ns', unitSource: 'user', scale: 500 }));
      assert.equal(JSON.stringify(store.getChannelMeta('!0')), before);
      assert.throws(() => store.updateChannelMeta('!0', { id: 'speed' }));
      assert.equal(JSON.stringify(store.getChannelMeta('!0')), before);
    });
    check(() => {
      const before = store.exportDashboardJson();
      save = null;
      assert.throws(() => store.updateChannelMeta('previously-unseen', { unit: 'm\ns', unitSource: 'user' }));
      assert.equal(store.exportDashboardJson(), before);
      assert.equal(save, null);
      assert.throws(() => store.updateChannelMeta('previously-unseen', { id: 'different' }));
      assert.equal(store.exportDashboardJson(), before);
      assert.equal(save, null);
    });
    check(() => {
      assert.throws(() => store.updateChannelMeta('!0', { unit: undefined }));
      assert.equal(store.getChannelMeta('!0').unit, 'rpm');
      store.updateChannelMeta('!0', { unit: undefined, unitSource: undefined });
      assert.ok(!Object.hasOwn(store.getChannelMeta('!0'), 'unit'));
      assert.ok(!Object.hasOwn(store.getChannelMeta('!0'), 'unitSource'));
      save!();
      const serialized = JSON.parse(values.get('llm-serial.vofa-dashboard.v2')!);
      assert.ok(!Object.hasOwn(serialized.channels['!0'], 'unit'));
      assert.ok(!Object.hasOwn(serialized.channels['!0'], 'unitSource'));
    });
    check(() => {
      const before = store.exportDashboardJson();
      const failed = store.importDashboardJson(JSON.stringify(dashboard({ ...meta, unitSource: 'user' })));
      assert.equal(failed.ok, false);
      assert.equal(store.exportDashboardJson(), before);
      assert.equal(store.importDashboardJson(JSON.stringify(dashboard(meta))).ok, true);
      assert.equal(store.getChannelMeta('speed').unit, undefined);
    });
  } finally {
    store.dashboardState.value = previousDashboard;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete (globalThis as { window?: unknown }).window;
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  console.log(`通道原始单位、别名显示与导入/持久化检查：${checked} 项通过。`);
}
