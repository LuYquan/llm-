import assert from 'node:assert/strict';
import { ChannelStore } from '../src/core/channel/ChannelStore';
import { createProtocolEngine } from '../src/core/protocol/ProtocolEngine';
import type { ProtocolConfig } from '../src/core/protocol/types';
import { materializeTuningCommand } from '../src/core/tuning/commandContract';
import { createCandidateRecord, importCapabilityPlan, isTrialForPlan, packagePlan, validateCandidateInputs, validateCapabilityPackage, validatePlan, validatePlanShape } from '../src/core/tuning/engine';
import { validateTuningProtocolCapabilities } from '../src/core/tuning/protocolCapabilities';
import type { TuningCommandFormat } from '../src/core/tuning/commandContract';
import type { TuningCapabilityPackage, TuningPlan } from '../src/core/tuning/types';

function createPlan(): TuningPlan {
  return {
    id: 'protocol-plan', version: 1, name: '速度环', project: '电机台架', description: '', prompt: '',
    route: 'feedback', mode: 'manual', loopId: 'speed', structure: 'PI', controlDirection: 'direct',
    sampleTimeSeconds: 0.01, commandTemplate: 'PID,{request_id},{kp},{ki},{kd}',
    baseline: { params: { kp: 2, ki: 0.5, kd: 0 }, source: 'manual', confirmed: true, stableBaseConfirmed: false },
    bounds: { kp: { min: 0, max: 10 }, ki: { min: 0, max: 2 }, kd: null },
    maxParameterChangePercent: 20, maximumTrials: 5, evaluationWindowSeconds: 2,
    maximumTelemetryAgeSeconds: 0.5, maximumOutputMagnitude: 100,
    channels: { setpoint: '!0', feedback: '!1', output: '!2', parameters: {} },
    units: { setpoint: 'rpm', feedback: 'rpm', output: '%', parameters: { kp: '%/rpm', ki: '%/(rpm·s)' } },
    confirmation: { mode: 'manual', acknowledgementText: '', timeoutSeconds: null, parameterTolerance: null },
    goal: { mode: 'settle', maximumSteadyError: 0.1, maximumOvershootPct: null, maximumTrackingError: null, targetPhaseMarginDeg: null, targetCrossoverRadPerSec: null },
    model: null,
  };
}

const FIREWATER: ProtocolConfig = { type: 'firewater' };
const CANONICAL = ['!0', '!1', '!2', '!3', '!4', '!5'];
const numericProtocols: ProtocolConfig[] = [
  FIREWATER,
  { type: 'justfloat', channels: null },
  { type: 'justfloat', channels: 6 },
  { type: 'rawdata', mode: 'decode', format: 'f32le', channels: 6 },
  { type: 'custom', header: [0xaa], tail: [0x55], channels: 6, dataType: 'f32le', checksum: 'none', checksumByteOrder: 'little' },
];

export function runTuningProtocolCapabilityTests(): void {
  let checked = 0;
  const plan = createPlan();
  const check = (testPlan = plan, protocolConfig: ProtocolConfig | null = FIREWATER, canonicalChannelIds: readonly string[] = CANONICAL) =>
    validateTuningProtocolCapabilities({ plan: testPlan, protocolConfig, canonicalChannelIds });
  assert.deepEqual(validatePlan(plan), []);
  assert.deepEqual(validatePlanShape(plan), []);
  assert.deepEqual(check(), []);
  checked++;

  // Exact buffer IDs have priority over mutable display aliases in the real store.
  const store = new ChannelStore(10);
  for (const id of CANONICAL) store.getBuffer(id, true);
  store.setAlias('r', '!0');
  store.setAlias('y', '!1');
  store.setAlias('0', '!0');
  assert.equal(store.resolveChannelKey('r'), '!0');
  assert.deepEqual(check(plan, FIREWATER, store.listChannels()), []);
  const aliased = { ...plan, channels: { ...plan.channels, setpoint: 'r' } };
  assert.ok(check(aliased, FIREWATER, store.listChannels()).some(error => error.includes('真实通道 ID')));
  store.setAlias('r', '!1');
  store.setAlias('!0', '!2');
  assert.equal(store.resolveChannelKey('r'), '!1', 'a display alias can rebind to another buffer');
  assert.equal(store.resolveChannelKey('!0'), '!0', 'a literal canonical ID continues to identify its original buffer');
  assert.deepEqual(check(plan, FIREWATER, store.listChannels()), []);
  assert.ok(check(aliased, FIREWATER, store.listChannels()).length > 0);
  assert.ok(check({ ...plan, channels: { ...plan.channels, setpoint: '0' } }, FIREWATER, store.listChannels()).length > 0, 'prefix-equivalent aliases do not establish canonical identity');
  checked++;

  for (const key of ['setpoint', 'feedback', 'output'] as const) {
    for (const badId of ['', 'missing', ' !0', '0']) {
      assert.ok(check({ ...plan, channels: { ...plan.channels, [key]: badId } }).some(error => error.includes('真实通道 ID')), `${key}: ${JSON.stringify(badId)}`);
      checked++;
    }
  }
  for (const [left, right] of [['setpoint', 'feedback'], ['setpoint', 'output'], ['feedback', 'output']] as const) {
    assert.ok(check({ ...plan, channels: { ...plan.channels, [right]: plan.channels[left] } }).some(error => error.includes('重复绑定')), `${left}/${right}`);
    checked++;
  }
  const named = { ...plan, channels: { ...plan.channels, setpoint: '设定值', feedback: '速度', output: '驱动力' } };
  assert.deepEqual(check(named, FIREWATER, ['设定值', '速度', '驱动力']), [], 'canonical named channels are valid; IDs need not be numeric or start with !');
  assert.ok(check(named, FIREWATER, ['设定值', '速度', '驱动力', '驱动力']).length > 0, 'a corrupted duplicate inventory is rejected');
  assert.ok(check(plan, FIREWATER, []).length > 0);
  checked++;

  for (const protocol of numericProtocols) {
    assert.deepEqual(check(plan, protocol), [], `${protocol.type} supports numeric feedback with manual confirmation`);
    const ack: TuningPlan = { ...plan, confirmation: { ...plan.confirmation, mode: 'acknowledgement', acknowledgementText: 'APPLIED {request_id}', timeoutSeconds: 2 } };
    assert.equal(check(ack, protocol).some(error => error.includes('文本写入应答')), protocol.type !== 'firewater');
    const readback: TuningPlan = { ...plan, channels: { ...plan.channels, parameters: { kp: '!3', ki: '!4' } }, confirmation: { ...plan.confirmation, mode: 'parameter-channels', timeoutSeconds: 2, parameterTolerance: 1 } };
    assert.deepEqual(check(readback, protocol), [], `${protocol.type} permits parameter-channel readback`);
    checked++;
  }
  const display: ProtocolConfig = { type: 'rawdata', mode: 'display', format: 'f32le', channels: 6 };
  assert.ok(check(plan, display).some(error => error.includes('不产生数值遥测')));
  assert.ok(check(plan, null).some(error => error.includes('协议配置无效')));
  checked++;

  const invalidProtocols: unknown[] = [
    {}, { type: 'unknown' }, { type: 'justfloat', channels: 0 }, { type: 'justfloat', channels: 65 },
    { type: 'rawdata', mode: 'decode', format: 'unsupported', channels: 6 },
    { type: 'rawdata', mode: 'unknown', format: 'f32le', channels: 6 },
    { type: 'custom', header: [0xaa], tail: [], channels: 6, dataType: 'unknown', checksum: 'none', checksumByteOrder: 'little' },
    { type: 'custom', header: [], tail: [], channels: 6, dataType: 'f32le', checksum: 'none', checksumByteOrder: 'little' },
  ];
  for (const protocol of invalidProtocols) {
    assert.ok(check(plan, protocol as ProtocolConfig).length > 0, JSON.stringify(protocol));
    checked++;
  }

  for (const structure of ['P', 'PI', 'PD', 'PID'] as const) {
    const active = structure === 'P' ? ['kp'] : structure === 'PI' ? ['kp', 'ki'] : structure === 'PD' ? ['kp', 'kd'] : ['kp', 'ki', 'kd'];
    const readback: TuningPlan = {
      ...plan, structure, channels: { ...plan.channels, parameters: { kp: '!3', ki: '!4', kd: '!5' } },
      confirmation: { ...plan.confirmation, mode: 'parameter-channels', timeoutSeconds: 2, parameterTolerance: 1 },
    };
    assert.deepEqual(check(readback), []);
    for (const key of ['kp', 'ki', 'kd'] as const) {
      const missing = { ...readback, channels: { ...readback.channels, parameters: { ...readback.channels.parameters, [key]: 'alias-or-missing' } } };
      assert.equal(check(missing).length > 0, active.includes(key), `${structure} ${key} checks only active controller terms`);
      const sharedTelemetry = { ...readback, channels: { ...readback.channels, parameters: { ...readback.channels.parameters, [key]: '!0' } } };
      assert.equal(check(sharedTelemetry).some(error => error.includes('重复绑定')), active.includes(key), `${structure} ${key} must be independent of telemetry variables`);
      checked++;
    }
    if (active.length > 1) {
      const duplicateParameters = { ...readback, channels: { ...readback.channels, parameters: { kp: '!3', ki: '!3', kd: '!3' } } };
      assert.ok(check(duplicateParameters).some(error => error.includes('重复绑定')), `${structure} active parameters cannot share readback`);
      checked++;
    }
  }
  const channelsBaseline: TuningPlan = { ...plan, baseline: { ...plan.baseline, source: 'parameter-channels' }, channels: { ...plan.channels, parameters: { kp: '!3', ki: '!4' } } };
  assert.deepEqual(check(channelsBaseline), []);
  assert.ok(check({ ...channelsBaseline, channels: { ...plan.channels, parameters: { kp: '!3', ki: '!3' } } }).some(error => error.includes('重复绑定')), 'baseline parameter readback is checked even when write confirmation is manual');
  assert.deepEqual(check({ ...plan, channels: { ...plan.channels, parameters: { kp: 'old-alias', ki: 'old-alias' } } }), [], 'unused saved parameter aliases cannot create an execution dependency');
  checked++;

  // Parser evidence supports the protocol capability distinction, not hardware acceptance.
  const ackBytes = new TextEncoder().encode('APPLIED request-17\n');
  assert.equal(createProtocolEngine(FIREWATER).feed(ackBytes, 1).logs[0]?.text, 'APPLIED request-17');
  for (const protocol of numericProtocols.filter(config => config.type !== 'firewater')) {
    assert.deepEqual(createProtocolEngine(protocol).feed(ackBytes, 1).logs, [], `${protocol.type} does not parse text ACK logs`);
    checked++;
  }

  // Legacy plans omit format, retaining the shared encoder's documented default.
  for (const commandFormat of [undefined, { escapeText: true, lineEnding: 'crlf' }, { escapeText: false, lineEnding: 'none' }, { escapeText: true, lineEnding: 'lf' }, { escapeText: false, lineEnding: 'cr' }] as const) {
    const formatted: TuningPlan = commandFormat === undefined ? { ...plan } : { ...plan, commandFormat };
    assert.deepEqual(validatePlan(formatted), []);
    assert.deepEqual(validateCandidateInputs(formatted), []);
    assert.deepEqual(validatePlanShape(formatted), []);
    const modelPlan: TuningPlan = { ...formatted, route: 'model', model: { family: 'fopdt', k: 2, t: 1, tau: 0 }, goal: { ...plan.goal, targetCrossoverRadPerSec: 1, targetPhaseMarginDeg: 60 } };
    assert.deepEqual(validateCandidateInputs(modelPlan), []);
    const payload = materializeTuningCommand('PID,17,2,0.5,0', formatted.commandFormat);
    assert.deepEqual(payload.format, commandFormat ?? { escapeText: true, lineEnding: 'crlf' });
    checked++;
  }
  const extraFormat = { escapeText: true, lineEnding: 'crlf', encoding: 'hex' };
  const invalidFormats: unknown[] = [null, true, 'crlf', {}, [], { escapeText: true }, { lineEnding: 'crlf' }, { escapeText: 1, lineEnding: 'crlf' }, { escapeText: true, lineEnding: 'LF' }, { escapeText: false, lineEnding: 'auto' }, extraFormat, Object.create({ escapeText: true, lineEnding: 'crlf' })];
  for (const commandFormat of invalidFormats) {
    const invalid = { ...plan, commandFormat } as TuningPlan;
    assert.ok(validatePlan(invalid).some(error => error.includes('行尾格式')));
    assert.ok(validateCandidateInputs(invalid).some(error => error.includes('行尾格式')));
    assert.ok(validatePlanShape(invalid).some(error => error.includes('行尾格式')));
    const modelPlan: TuningPlan = { ...invalid, route: 'model', model: { family: 'fopdt', k: 2, t: 1, tau: 0 }, goal: { ...plan.goal, targetCrossoverRadPerSec: 1, targetPhaseMarginDeg: 60 } };
    assert.ok(validateCandidateInputs(modelPlan).some(error => error.includes('行尾格式')));
    assert.ok(validatePlan(modelPlan).some(error => error.includes('行尾格式')));
    checked++;
  }

  const format: TuningCommandFormat = { escapeText: false, lineEnding: 'lf' };
  const formatted: TuningPlan = { ...plan, commandFormat: format };
  const pkg = packagePlan(formatted) as TuningCapabilityPackage;
  assert.deepEqual(validateCapabilityPackage(pkg), []);
  assert.notEqual(pkg.plan.commandFormat, format);
  format.lineEnding = 'cr';
  assert.equal(pkg.plan.commandFormat?.lineEnding, 'lf', 'package export deep-copies format');
  const imported = importCapabilityPlan(pkg);
  assert.notEqual(imported.commandFormat, pkg.plan.commandFormat);
  assert.deepEqual(imported.commandFormat, { escapeText: false, lineEnding: 'lf' });
  pkg.plan.commandFormat!.escapeText = true;
  assert.equal(imported.commandFormat?.escapeText, false, 'package import deep-copies format');
  assert.equal(imported.baseline.confirmed, false, 'importing transport format grants no device attestation');
  const legacyPackage = packagePlan(plan) as TuningCapabilityPackage;
  assert.deepEqual(validateCapabilityPackage(legacyPackage), []);
  assert.equal(importCapabilityPlan(legacyPackage).commandFormat, undefined, 'legacy package import remains readable without inventing a saved format');
  const invalidPackage = { ...pkg, plan: { ...pkg.plan, commandFormat: extraFormat } };
  assert.ok(validateCapabilityPackage(invalidPackage).some(error => error.includes('行尾格式')));
  checked++;

  const trial = createCandidateRecord({ kp: 2.2, ki: 0.55, kd: 0 }, formatted, plan.baseline.params!, '候选');
  assert.equal(trial.commandPayload, undefined, 'core candidate history does not fabricate unreviewed bytes');
  assert.equal(isTrialForPlan(trial, { ...formatted, commandFormat: { ...formatted.commandFormat!, lineEnding: 'crlf' } }), false, 'changing encoding options invalidates old proposal scope');
  trial.command = 'PID,17,2.2,0.55,0';
  trial.commandPayload = materializeTuningCommand(trial.command, formatted.commandFormat);
  trial.writeParameterRevisions = { kp: 12, ki: 18 };
  assert.equal(trial.commandPayload.sourceText, trial.command);
  assert.equal(trial.writeParameterRevisions.ki, 18);
  checked++;

  console.log(`✓ 调参协议能力与计划命令格式测试通过（${checked} 项）：真实 ID、别名重绑定、独立变量、协议文本 ACK、格式兼容与套件复制。`);
}

runTuningProtocolCapabilityTests();
