import { register } from 'node:module';

// 注册 TypeScript 模块解析钩子
register(new URL('./ts-resolver.mjs', import.meta.url));

// 1. 运行串口传输抽象层测试
const { runTransportTests } = await import('./transport-cases.ts');
await runTransportTests();

const { runCommandEncoderTests } = await import('./command-encoder.test.ts');
runCommandEncoderTests();

// 2. 运行 7 组黄金数据集纯 TS 流分流器比对测试 (阶段二 任务 2.2)
const { runStreamDemuxerTests } = await import('./stream-demuxer.test.ts');
await runStreamDemuxerTests();

// 3. 运行 WebSerial 驱动与状态机测试 (阶段二 任务 2.1 & 2.3)
const { runWebSerialTests } = await import('./webserial.test.ts');
await runWebSerialTests();

const { runWebReceiveOrderTests } = await import('./web-receive-order.test.ts');
await runWebReceiveOrderTests();

const { runBrowserRecordingTests } = await import('./browser-recording.test.ts');
await runBrowserRecordingTests();

// 4. 运行 AI 模型拉取与端点联动测试
const { runAiModelsTests } = await import('./ai-models.test.ts');
await runAiModelsTests();

// 5. 运行 Phase 0 地基重构测试 (ProtocolEngine / ChannelStore / StepAnalyzer / ProjectModel)
const { runProtocolEngineTests } = await import('./protocol-engine.test.ts');
await runProtocolEngineTests();

const { runChannelStoreTests } = await import('./channel-store.test.ts');
await runChannelStoreTests();

const { runStepFeaturesTests } = await import('./step-features.test.ts');
await runStepFeaturesTests();

const { runProjectModelTests } = await import('./project-model.test.ts');
await runProjectModelTests();

const { runChannelAlignmentTests } = await import('./channel-alignment.test.ts');
runChannelAlignmentTests();

const { runPipelineStatisticsTests } = await import('./pipeline-statistics.test.ts');
await runPipelineStatisticsTests();

console.log('🎉 所有前端传输层、流分流器黄金数据集、Web Serial 驱动、AI 模型及 Phase 0 地基测试 100% 全部通过！');

