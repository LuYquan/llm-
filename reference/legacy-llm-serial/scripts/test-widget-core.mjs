import assert from 'node:assert';
import '../tests/debug-assistant.test.ts';
import '../tests/simulation-comparison.test.ts';
import '../tests/tuning-scenarios.test.ts';
import '../tests/bandwidth-policy.test.ts';
import '../tests/bode-precision.test.ts';
import '../tests/cascade-dependencies.test.ts';
import '../tests/scenario-cascade-model.test.ts';
import '../tests/tuning-confirmed-context.test.ts';
import '../tests/tuning-feedback-evidence.test.ts';
import '../tests/tuning-alignment.test.ts';
import '../tests/tuning-command-contract.test.ts';
import '../tests/tuning-protocol-capabilities.test.ts';
import '../tests/tuning-write-correlation.test.ts';
import '../tests/tuning-execution-lease.test.ts';
import '../tests/tuning-agent-config.test.ts';
import '../tests/synthetic-telemetry-clock.test.ts';
import {
  parseEscapeSequences,
  encodeNumberToHex,
  validateTemplate,
  renderTemplate,
} from '../src/core/widget/templateEngine.js';
import {
  formatPrecision,
  alignToStep,
  checkAndSanitizeNumeric,
} from '../src/core/widget/safetyGuard.js';
import { SendGate } from '../src/core/widget/sendGate.js';
import {
  validateWidgetConfig,
  migrateWidgetDashboard,
  createDefaultPreset,
} from '../src/core/widget/schema.js';
import {
  snap,
  clampToCanvas,
  normalizeSize,
  clientToCanvas,
} from '../src/utils/grid.js';
import { ChannelHub } from '../src/services/channelHub.js';
import {
  createDefaultVofaPreset,
  createNewWidget,
} from '../src/stores/widgetStore.js';
import { computeFftSpectrum, inspectFftInput } from '../src/core/analysis/fft.js';
import { runProtocolEngineTests } from '../tests/protocol-engine.test.ts';
import { runChannelStoreTests } from '../tests/channel-store.test.ts';
import { runStepFeaturesTests } from '../tests/step-features.test.ts';
import { runProjectModelTests } from '../tests/project-model.test.ts';
import { runSendGateTests } from '../tests/send-gate.test.ts';
import { runAnalysisWorkerTests } from '../tests/analysis-worker.test.ts';

console.log('--- 开始测试 VOFA+ 控件工作台核心纯函数与数据中枢 ---');

// 1. 模板引擎测试
console.log('1. 测试模板转义与渲染');
assert.strictEqual(parseEscapeSequences('SET:KP=1\\r\\n'), 'SET:KP=1\r\n');
assert.strictEqual(parseEscapeSequences('AA\\x01\\x55'), 'AA\x01\x55');

const textTpl = renderTemplate(
  {
    id: 'test_1',
    type: 'slider',
    title: 'Test',
    command_template: 'SET:KP={val}\\n',
    encoding: 'text',
    order: 0,
  },
  '12.34',
  12.34
);
assert.strictEqual(textTpl.payload, 'SET:KP=12.34\n');

// 2. HEX 编码测试
console.log('2. 测试 HEX 编码与多类型转换');
assert.strictEqual(encodeNumberToHex(255, 'u8'), 'FF');
assert.strictEqual(encodeNumberToHex(0x1234, 'u16le'), '34 12');
assert.strictEqual(encodeNumberToHex(0x1234, 'u16be'), '12 34');

const hexTpl = renderTemplate(
  {
    id: 'test_hex',
    type: 'slider',
    title: 'Hex Test',
    command_template: 'AA 01 {val} 55',
    encoding: 'hex',
    order: 0,
    hex_val_format: 'u16le',
  },
  '4660',
  0x1234
);
assert.strictEqual(hexTpl.payload, 'AA 01 34 12 55');

// 3. SafetyGuard 测试
console.log('3. 测试 SafetyGuard 限幅与精度');
assert.strictEqual(formatPrecision(0.1 + 0.2, 2), '0.3');
assert.strictEqual(formatPrecision(12.34567, 3), '12.346');
assert.strictEqual(alignToStep(12.33, 0, 0.1), 12.3);

const nanCheck = checkAndSanitizeNumeric(NaN, { min: 0, max: 100, step: 1, precision: 1 });
assert.strictEqual(nanCheck.ok, false);
assert.strictEqual(nanCheck.reason, 'nan');

const outCheck = checkAndSanitizeNumeric(150, { min: 0, max: 100, step: 1, precision: 1 });
assert.strictEqual(outCheck.ok, false);
assert.strictEqual(outCheck.reason, 'out_of_range');

const normalCheck = checkAndSanitizeNumeric(25.32, { min: 0, max: 100, step: 0.5, precision: 1 });
assert.strictEqual(normalCheck.ok, true);
assert.strictEqual(normalCheck.value, 25.5);
assert.strictEqual(normalCheck.formattedStr, '25.5');

// 4. VOFA+ 自由网格几何算法测试
console.log('4. 测试自由网格 snap / clamp / normalize / clientToCanvas 几何算法');
assert.strictEqual(snap(23, 20), 20);
assert.strictEqual(snap(31, 20), 40);
assert.strictEqual(snap(0, 20), 0);

const clamped = clampToCanvas(2350, 1550, 200, 100, 2400, 1600);
assert.strictEqual(clamped.x, 2200); // 2400 - 200
assert.strictEqual(clamped.y, 1500); // 1600 - 100

const norm = normalizeSize(150, 150, 240, 160, 20);
assert.strictEqual(norm.w, 240); // 不低于 min_w 且按 20px 吸附
assert.strictEqual(norm.h, 160);

const c2c = clientToCanvas(500, 300, { left: 100, top: 50 }, 50, 20, 120, 60, 20);
// rawX = 400, canvasX = 400 + 50 - 120 = 330 -> snap 340
assert.strictEqual(c2c.x, 340);
// rawY = 250, canvasY = 250 + 20 - 60 = 210 -> snap 220
assert.strictEqual(c2c.y, 220);

// 5. ChannelHub 环形缓冲与通道查询测试
console.log('5. 测试 ChannelHub 环形缓冲区');
const hub = new ChannelHub(100);
hub.pushBatch([
  { timestamp: 1000, values: { speed: 50, temp: 25.4 } },
  { timestamp: 1020, values: { speed: 55, temp: 25.6 } },
  { timestamp: 1040, values: { speed: 60 } },
]);

assert.ok(hub.listChannels().includes('speed'));
assert.ok(hub.listChannels().includes('temp'));
const latestSpeed = hub.latest('speed');
assert.strictEqual(latestSpeed?.v, 60);
assert.strictEqual(latestSpeed?.t, 1040);

const latestTemp = hub.latest('temp');
assert.strictEqual(latestTemp?.v, 25.6);

const rangeData = hub.range('speed', 1000, 1030);
assert.strictEqual(rangeData.t.length, 2);
assert.strictEqual(rangeData.v[0], 50);
assert.strictEqual(rangeData.v[1], 55);

// 6. VOFA+ 默认预设与控件生成测试
console.log('6. 测试 VOFA+ 默认预设与工厂方法');
const vofaPreset = createDefaultVofaPreset();
assert.strictEqual(vofaPreset.version, 2);
assert.strictEqual(vofaPreset.tabs.length, 1);
assert.strictEqual(vofaPreset.tabs[0].widgets.length, 1);
assert.strictEqual(vofaPreset.tabs[0].widgets[0].config.auto_bind, true);
assert.deepStrictEqual(vofaPreset.tabs[0].widgets[0].config.series, []);
assert.strictEqual(vofaPreset.locked, true);

const newGauge = createNewWidget('gauge', 53, 77);
assert.strictEqual(newGauge.type, 'gauge');
assert.strictEqual(newGauge.x, 60); // 53 -> 60 (grid 20)
assert.strictEqual(newGauge.y, 80); // 77 -> 80 (grid 20)
assert.strictEqual(newGauge.w, 240);
assert.strictEqual(newGauge.h, 240);

// 7. 测试 FFT 频谱计算引擎
console.log('7. 测试 FFT 频谱计算引擎与 50Hz 峰值辨识');
const fs = 1000;
const nPoints = 256;
const tArr = new Float64Array(nPoints);
const yArr = new Float64Array(nPoints);
for (let i = 0; i < nPoints; i++) {
  tArr[i] = i / fs;
  yArr[i] = 5.0 * Math.sin(2 * Math.PI * 50 * tArr[i]) + 2.0; // 50Hz 正弦波 + 2.0 直流分量
}
const fftRes = computeFftSpectrum(tArr, yArr, 256);
assert.ok(fftRes !== null);
assert.strictEqual(fftRes.sampleRate, 1000);
// 50Hz 应该在主频峰值处检测到 (误差允许范围在频域分辨率之内, 1000/256 ≈ 3.9Hz)
assert.ok(Math.abs(fftRes.peakFreq - 50) <= 4, `Expected ~50Hz, got ${fftRes.peakFreq}`);
assert.ok(fftRes.peakAmp > 4.0, `Expected amplitude > 4.0, got ${fftRes.peakAmp}`);
assert.equal(inspectFftInput(tArr, yArr, 256).valid, true);

const jitteredTimes = Float64Array.from(tArr);
jitteredTimes[128] += 0.0001;
assert.equal(inspectFftInput(jitteredTimes, yArr, 256).valid, false, 'FFT must reject timestamp jitter above the declared tolerance');
assert.equal(computeFftSpectrum(jitteredTimes, yArr, 256), null);

const duplicateTimes = Float64Array.from(tArr);
duplicateTimes[128] = duplicateTimes[127];
assert.match(inspectFftInput(duplicateTimes, yArr, 256).reason ?? '', /重复或逆序/);

const missingValues = Float64Array.from(yArr);
missingValues[128] = NaN;
assert.match(inspectFftInput(tArr, missingValues, 256).reason ?? '', /缺失/);
assert.equal(inspectFftInput(tArr.subarray(0, 10), yArr.subarray(0, 10), 256).valid, false);

console.log('--- 所有 VOFA+ 控件工作台核心与数据中枢测试 100% 通过！ ---\n');

console.log('====================================================');
console.log('   Phase 0: 地基重构全量模块自动化测试套件执行中...   ');
console.log('====================================================\n');

await runProtocolEngineTests();
await runChannelStoreTests();
await runStepFeaturesTests();
await runProjectModelTests();
await runAnalysisWorkerTests();
const { runAnalysisHistoryTests } = await import('../tests/analysis-history.test.ts');
await runAnalysisHistoryTests();

const { runRecordingReplayTests } = await import('../tests/recording-replay.test.ts');
runRecordingReplayTests();
const { runRecordingReplayControllerTests } = await import('../tests/recording-replay-controller.test.ts');
await runRecordingReplayControllerTests();
const { runWorkspaceDocumentTests } = await import('../tests/workspace-document.test.ts');
runWorkspaceDocumentTests();
const { runWorkspaceTransactionTests } = await import('../tests/workspace-transaction.test.ts');
await runWorkspaceTransactionTests();

console.log('====================================================');
console.log('🎉 Phase 0: 4 大核心地基重构任务及现有核心测试 100% 全部通过！');
console.log('====================================================\n');

console.log('====================================================');
console.log('   Phase 1: 控件全融合与 VOFA+ 范式自动化测试套件...  ');
console.log('====================================================\n');

const { runPhase1WidgetTests } = await import('../tests/phase1-widgets.test.ts');
await runPhase1WidgetTests();

console.log('====================================================');
console.log('🎉 Phase 1: 控件全融合 (VOFA+ 范式彻底落地) 100% 全部通过！');
console.log('====================================================\n');

console.log('====================================================');
console.log('   Phase 2: Copilot 融入主终端自动化测试套件...       ');
console.log('====================================================\n');

const { runPhase2CopilotTests } = await import('../tests/phase2-copilot.test.ts');
await runPhase2CopilotTests();

console.log('====================================================');
console.log('🎉 Phase 2: Copilot 融入主终端 4 大核心引擎 100% 全部通过！');
console.log('====================================================\n');

console.log('====================================================');
console.log('   Phase 3: 控制工具链与单环智能整定自动化测试套件... ');
console.log('====================================================\n');

const { runPhase3ControlToolsTests } = await import('../tests/phase3-control-tools.test.ts');
await runPhase3ControlToolsTests();

console.log('====================================================');
console.log('🎉 Phase 3: 控制工具链与单环智能整定 100% 全部通过！');
console.log('====================================================\n');

console.log('====================================================');
console.log('   Phase 4: 串级多环与模板自动化测试套件...           ');
console.log('====================================================\n');

const { runPhase4CascadeTests } = await import('../tests/phase4-cascade.test.ts');
await runPhase4CascadeTests();

console.log('====================================================');
console.log('🎉 Phase 4: 串级多环与模板自动化测试 100% 全部通过！');
console.log('====================================================\n');

console.log('====================================================');
console.log('   Phase 5: 系统加固与红队安全防线审计测试套件...     ');
console.log('====================================================\n');

const { runPhase5HardeningTests } = await import('../tests/phase5-hardening.test.ts');
await runPhase5HardeningTests();

console.log('====================================================');
console.log('🎉 Phase 5: 系统加固与红队安全防线审计 100% 全部通过！');
console.log('====================================================\n');

console.log('====================================================');
console.log('   VOFA+ 级联右键通道绑定与变量选择器测试套件...      ');
console.log('====================================================\n');

const { runVofaChannelBindingTests } = await import('../tests/vofa-channel-binding.test.ts');
await runVofaChannelBindingTests();

console.log('====================================================');
console.log('   界面与操作极简重构 (UI Streamlining) 测试套件...    ');
console.log('====================================================\n');

const { runUiStreamliningTests } = await import('../tests/ui-streamlining.test.ts');
await runUiStreamliningTests();
await runSendGateTests();
const { runChannelPresentationTests } = await import('../tests/channel-presentation.test.ts');
await runChannelPresentationTests();
const { runSidebarProjectionTests } = await import('../tests/sidebar-projection.test.ts');
runSidebarProjectionTests();
const { runPlotValuesTests } = await import('../tests/plot-values.test.ts');
runPlotValuesTests();
const { runChannelAliasPersistenceTests } = await import('../tests/channel-alias-persistence.test.ts');
await runChannelAliasPersistenceTests();
await import('../tests/assistant-evidence-selection.test.ts');

console.log('====================================================');
console.log('🎉 界面与操作极简重构 (UI Streamlining) 测试 100% 全部通过！');
console.log('====================================================\n');

console.log('====================================================');
console.log('当前控件、分析、通信和工作区自动化测试通过；原生、长期采集和硬件验收另行记录。');
console.log('====================================================\n');




