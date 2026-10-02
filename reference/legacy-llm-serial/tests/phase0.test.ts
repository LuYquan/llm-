/**
 * Phase 0: 地基重构全量自动化验收测试入口
 */

import { register } from 'node:module';

// 注册 TypeScript 模块解析钩子
register(new URL('./ts-resolver.mjs', import.meta.url));

console.log('====================================================');
console.log('       Phase 0: 地基重构自动化回归与专项测试套件      ');
console.log('====================================================\n');

// 1. 协议引擎测试 (RawData / FireWater / JustFloat / CustomFrame)
const { runProtocolEngineTests } = await import('./protocol-engine.test.ts');
await runProtocolEngineTests();

// 2. ChannelStore 环形缓冲与 20通道×10kHz 高吞吐压力测试
const { runChannelStoreTests } = await import('./channel-store.test.ts');
await runChannelStoreTests();

// 3. 独立阶跃特征提取纯函数算法测试
const { runStepFeaturesTests } = await import('./step-features.test.ts');
await runStepFeaturesTests();

// 4. ProjectModel 环路拓扑配置与持久化测试
const { runProjectModelTests } = await import('./project-model.test.ts');
await runProjectModelTests();

console.log('====================================================');
console.log('🎉 Phase 0: 4 大核心底层重构任务测试 100% 全部通过！');
console.log('====================================================');
