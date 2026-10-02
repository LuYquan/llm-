import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { AnalysisWorkerClient } from '../src/services/analysis/analysis-worker-client.ts';
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from '../src/services/analysis/analysis-worker-protocol.ts';
import type { IdentifyPlantOptions } from '../src/core/control/types.ts';
import { evalFopdtStep } from '../src/core/control/identifyPlant.ts';

export async function runAnalysisWorkerTests() {
  console.log('--- [AnalysisWorker] FFT/阶跃/仿真后台任务与取消回退测试 ---');
  const client = new AnalysisWorkerClient();

  const sampleRate = 1000;
  const timestamps = Float64Array.from({ length: 256 }, (_, index) => index / sampleRate);
  const values = Float64Array.from(timestamps, (time) => Math.sin(2 * Math.PI * 50 * time));
  const fft = client.runFft(timestamps, values, 256, {
    source: 'live', sessionId: 'session-analysis-1', epoch: 3, generation: 7, channelIds: ['actual'],
  });
  const fftResult = await fft.promise;
  assert.equal(fftResult.quality.valid, true);
  assert.ok(fftResult.result);
  assert.ok(Math.abs(fftResult.result.peakFreq - 50) <= 4);
  assert.equal(fftResult.provenance?.source, 'live');
  assert.equal(fftResult.provenance?.sessionId, 'session-analysis-1');
  assert.equal(fftResult.provenance?.epoch, 3);
  assert.equal(fftResult.provenance?.generation, 7);
  assert.deepEqual(fftResult.provenance?.channelIds, ['actual']);
  assert.equal(fftResult.provenance?.interval.start, 0);
  assert.equal(fftResult.provenance?.interval.end, 0.255);
  assert.equal(fftResult.result?.provenance?.algorithm.id, 'fft-spectrum');

  const stepTimes = Float64Array.from({ length: 256 }, (_, index) => index * 0.01);
  const stepValues = Float64Array.from(stepTimes, (time) => 10 * (1 - Math.exp(-time / 0.35)));
  const step = client.runStep(stepTimes, stepValues, 10, { stepTime: 0 }, {
    source: 'replay', sessionId: 'record-1', epoch: 2, generation: 8, channelIds: ['actual', 'setpoint'],
  });
  const stepResult = await step.promise;
  assert.equal(stepResult.quality.valid, true);
  assert.ok(stepResult.result);
  assert.equal(stepResult.result?.y_target, 10);
  assert.equal(stepResult.provenance?.source, 'replay');
  assert.equal(stepResult.provenance?.sessionId, 'record-1');
  assert.equal(stepResult.provenance?.algorithm.id, 'step-response');
  assert.equal(stepResult.result?.provenance?.sampleCount, 256);

  const identification = client.runIdentification(
    Array.from({ length: 200 }, (_, index) => index * 0.01),
    evalFopdtStep(Array.from({ length: 200 }, (_, index) => index * 0.01), 2.5, 0.35, 0.04, 0, 0, 1),
    { family: 'fopdt', mode: 'open_loop', stepTime: 0, stepAmplitude: 1 },
    { source: 'live', sessionId: 'session-id', epoch: 4, generation: 9, channelIds: ['output', 'feedback'] },
  );
  const identificationResult = await identification.promise;
  assert.equal(identificationResult.usable, true);
  assert.ok(identificationResult.r_squared >= 0.98);
  assert.equal(identificationResult.provenance?.source, 'live');
  assert.equal(identificationResult.provenance?.sessionId, 'session-id');
  assert.equal(identificationResult.provenance?.algorithm.id, 'plant-identification');

  const invalidTime = client.runIdentification([0, 0, ...Array.from({ length: 8 }, (_, i) => i + 1)], Array(10).fill(1), {
    family: 'fopdt', mode: 'open_loop', stepTime: 0, stepAmplitude: 1,
  });
  assert.equal((await invalidTime.promise).usable, false, '重复时间戳必须拒绝辨识');
  const mismatched = client.runIdentification([0, 1], [0], {
    family: 'fopdt', mode: 'open_loop', stepTime: 0, stepAmplitude: 1,
  });
  await assert.rejects(mismatched.promise, /时间和值数量不一致/);
  const missingStepAmplitude = client.runIdentification(
    Array.from({ length: 10 }, (_, i) => i),
    Array.from({ length: 10 }, (_, i) => i),
    { family: 'fopdt', mode: 'open_loop', stepTime: 0 } as unknown as IdentifyPlantOptions,
  );
  assert.match((await missingStepAmplitude.promise).message, /阶跃输入幅值/);
  const missingMode = client.runIdentification(
    Array.from({ length: 10 }, (_, i) => i),
    Array.from({ length: 10 }, (_, i) => i),
    { family: 'fopdt', stepTime: 0, stepAmplitude: 1 } as unknown as IdentifyPlantOptions,
  );
  assert.match((await missingMode.promise).message, /必须明确选择开环或闭环/);
  const closedLoopWithoutController = client.runIdentification(
    Array.from({ length: 10 }, (_, i) => i), Array.from({ length: 10 }, (_, i) => i),
    { family: 'fopdt', mode: 'closed_loop', stepTime: 0, stepAmplitude: 1 },
  );
  assert.match((await closedLoopWithoutController.promise).message, /缺少本次实验使用的 PID/);

  const simulation = client.runSimulation({
    plant: { family: 'fopdt', k: 1.8, t: 0.22, tau: 0.015 },
    pid: { kp: 1.5, ki: 0.5, kd: 0 },
    sampleTime: 0.001,
    simTime: 0.4,
    stepValue: 1,
    initialValue: 0,
  }, { source: 'simulation', generation: 10 });
  const simulationResult = await simulation.promise;
  assert.ok(simulationResult.times.length > 100);
  assert.equal(simulationResult.times.length, simulationResult.values.length);
  assert.equal(simulationResult.provenance?.source, 'simulation');
  assert.equal(simulationResult.provenance?.generation, 10);
  assert.equal(simulationResult.provenance?.algorithm.id, 'closed-loop-simulation');
  assert.equal(simulationResult.metrics?.provenance?.source, 'simulation');

  const cancelled = client.runSimulation({
    plant: { family: 'fopdt', k: 1, t: 0.1, tau: 0 },
    pid: { kp: 1, ki: 0, kd: 0 },
    sampleTime: 0.001,
    simTime: 1,
  });
  cancelled.cancel();
  await assert.rejects(cancelled.promise, /取消/);

  client.dispose();

  const workers: Array<{ worker: Worker; request: AnalysisWorkerRequest | null; terminated: boolean }> = [];
  const isolatedClient = new AnalysisWorkerClient({
    timeoutMs: 25,
    createWorker: () => {
      const state: { worker: Worker; request: AnalysisWorkerRequest | null; terminated: boolean } = {
        worker: null as unknown as Worker,
        request: null,
        terminated: false,
      };
      const worker = {
        onmessage: null as ((event: MessageEvent<AnalysisWorkerResponse>) => void) | null,
        onerror: null as ((event: ErrorEvent) => void) | null,
        postMessage: (request: AnalysisWorkerRequest) => { state.request = structuredClone(request); },
        terminate: () => { state.terminated = true; },
      } as unknown as Worker;
      state.worker = worker;
      workers.push(state);
      return worker;
    },
  });
  const firstWorkerJob = isolatedClient.runFft(timestamps, values, 256);
  const secondWorkerJob = isolatedClient.runFft(timestamps, values, 256);
  firstWorkerJob.cancel();
  await assert.rejects(firstWorkerJob.promise, /取消/);
  assert.equal(workers.length, 2);
  assert.equal(workers[0].terminated, true, '取消应终止该任务自己的 Worker');
  assert.equal(workers[1].terminated, false, '取消一个分析不得终止另一个任务的 Worker');
  await assert.rejects(secondWorkerJob.promise, /超过 25 ms/);
  assert.equal(workers[1].terminated, true, '超时应终止对应 Worker');

  const reactiveSimulation = reactive({
    plant: { family: 'fopdt' as const, k: 1.5, t: .22, tau: .015 },
    pid: { kp: 1.8, ki: 21, kd: 0 }, sampleTime: .001, outputLimits: [-100, 100] as [number, number],
  });
  assert.throws(() => structuredClone(reactiveSimulation), /clone/i, '真实结构化复制应拒绝 Vue Proxy');
  const proxySimulation = isolatedClient.runSimulation(reactiveSimulation);
  const snapshot = workers.at(-1)!.request;
  assert.equal(snapshot?.type, 'simulate');
  if (snapshot?.type !== 'simulate') throw new Error('没有收到仿真输入快照');
  assert.equal(snapshot.options.plant.k, 1.5);
  assert.deepEqual(snapshot.options.outputLimits, [-100, 100]);
  reactiveSimulation.plant.k = 9;
  reactiveSimulation.pid.kp = 50;
  assert.equal(snapshot.options.plant.k, 1.5, '运行中编辑不得改变本轮计算输入');
  assert.equal(snapshot.options.pid.kp, 1.8);
  workers.at(-1)!.worker.onmessage?.({ data: {
    type: 'simulate-result', id: proxySimulation.id,
    result: { times: [0, .1], values: [0, .5], references: [1, 1], controls: [1, 1], metrics: null, metrics_error: null },
  } } as MessageEvent<AnalysisWorkerResponse>);
  const proxyResult = await proxySimulation.promise;
  assert.equal((proxyResult.provenance?.parameters.plant as { k: number }).k, 1.5, '溯源必须保存本轮快照而非修改后的对象');

  const proxyIdentification = isolatedClient.runIdentification(stepTimes, stepValues, reactive({
    family: 'fopdt', mode: 'closed_loop', stepTime: 0, stepAmplitude: 10,
    controller: { kp: 1, ki: 0, kd: 0 }, sampleTime: .01,
  }) as IdentifyPlantOptions);
  assert.equal(workers.at(-1)!.request?.type, 'identify');
  proxyIdentification.cancel();
  await assert.rejects(proxyIdentification.promise, /取消/);
  const proxyStep = isolatedClient.runStep(stepTimes, stepValues, 10, reactive({ stepTime: 0, bandPercent: .02 }));
  assert.equal(workers.at(-1)!.request?.type, 'step');
  proxyStep.cancel();
  await assert.rejects(proxyStep.promise, /取消/);
  isolatedClient.dispose();

  const boundedFallback = new AnalysisWorkerClient({ maxSyncFallbackSamples: 32 });
  await assert.rejects(boundedFallback.runFft(timestamps, values, 256).promise, /同步回退上限/);
  boundedFallback.dispose();

  console.log('  ✓ FFT、阶跃、辨识和仿真回退有界；Worker 任务独立取消、超时终止且互不影响');
}
