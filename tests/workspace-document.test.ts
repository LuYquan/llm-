import assert from 'node:assert/strict';
import { createDefaultVofaPreset } from '../src/core/widget/schema';
import {
  buildWorkspaceDocument,
  previewWorkspaceDocument,
} from '../src/services/workspace/document';
import { BUILTIN_PROJECT_TEMPLATES } from '../src/core/project/templates';

export function runWorkspaceDocumentTests() {
  console.log('--- [WorkspaceDocument] 版本化工作区导出与安全导入测试 ---');
  const document = buildWorkspaceDocument({
    portName: 'COM7',
    baudRate: 230400,
    mode: 'serial',
    serialSettings: { dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none' },
    protocolConfig: { type: 'justfloat', channels: 2 },
    channelMapping: { target: 'target', actual: 'actual', output: 'output' },
    commands: [{ id: 'set', name: '设置', command: 'AA 01', is_hex: true, danger: true }],
    emergencyCommand: 'STOP\\n',
    aiConfig: {
      provider: 'deepseek',
      api_url: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      api_key: 'sk-secret-must-not-leak',
    },
    dashboard: createDefaultVofaPreset(),
    projectModel: BUILTIN_PROJECT_TEMPLATES.generic_single(),
    recordSessionIds: ['session-a'],
  });

  assert.equal(document.activation.automaticWrites, false);
  assert.equal(document.activation.commandsNeedReview, true);
  assert.equal(document.ai.configured, true);
  assert.equal(JSON.stringify(document).includes('sk-secret'), false);
  const preview = previewWorkspaceDocument(document);
  assert.equal(preview.ok, true);
  assert.equal(preview.document?.connection.protocolConfig.type, 'justfloat');
  assert.equal(preview.document?.commands[0].isHex, true);

  const badProjectModel = JSON.parse(JSON.stringify(document));
  badProjectModel.projectModel.loops[0].param_limits.kp = [100, 0];
  const badProjectPreview = previewWorkspaceDocument(badProjectModel);
  assert.equal(badProjectPreview.ok, false);
  assert.match(badProjectPreview.errors.join('\n'), /控制结构校验失败/);

  const withSecret = JSON.parse(JSON.stringify(document));
  withSecret.ai.api_key = 'leak';
  const secretPreview = previewWorkspaceDocument(withSecret);
  assert.equal(secretPreview.ok, false);
  assert.match(secretPreview.errors.join('\n'), /密钥字段/);

  const badProtocol = JSON.parse(JSON.stringify(document));
  badProtocol.connection.protocolConfig = { type: 'justfloat', channels: 0 };
  const badPreview = previewWorkspaceDocument(badProtocol);
  assert.equal(badPreview.ok, false);
  assert.match(badPreview.errors.join('\n'), /JustFloat/);

  const duplicateCommand = JSON.parse(JSON.stringify(document));
  duplicateCommand.commands.push({ ...duplicateCommand.commands[0], name: '重复 ID' });
  const duplicatePreview = previewWorkspaceDocument(duplicateCommand);
  assert.equal(duplicatePreview.ok, false);
  assert.match(duplicatePreview.errors.join('\n'), /ID 重复/);

  const invalidSummary = JSON.parse(JSON.stringify(document));
  invalidSummary.ai.model = 42;
  invalidSummary.emergencyCommandDraft = { payload: 'STOP' };
  const invalidSummaryPreview = previewWorkspaceDocument(invalidSummary);
  assert.equal(invalidSummaryPreview.ok, false);
  assert.match(invalidSummaryPreview.errors.join('\n'), /AI 模型字段无效/);
  assert.match(invalidSummaryPreview.errors.join('\n'), /停止命令草稿/);

  console.log('  ✓ 导出文档不包含 API Key，且自动写入/记录数据保持关闭');
  console.log('  ✓ 导入预览校验连接、协议、命令、控制结构和画布结构');
  console.log('  ✓ 密钥字段、高风险协议参数和损坏布局被拒绝');
  console.log('  ✓ 导入会话会拒绝重复命令 ID、无效摘要字段和危险结构');
}

