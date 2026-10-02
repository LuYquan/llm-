import { validateAndMigrateDashboard } from '../../core/widget/schema';
import type { ProtocolConfig } from '../../core/protocol/types';
import { validateProtocolConfig } from '../../core/protocol/types';
import type { SerialSettings } from '../transport/types';
import type { VofaDashboardState } from '../../types/widget';
import { validateProjectModel } from '../../core/project/ProjectModel';

export const WORKSPACE_DOCUMENT_FORMAT = 'llm-serial-workspace';
export const WORKSPACE_DOCUMENT_VERSION = 1;

export interface WorkspaceCommandDraft {
  id: string;
  name: string;
  command: string;
  isHex: boolean;
  danger: boolean;
}

export interface WorkspaceDocument {
  format: typeof WORKSPACE_DOCUMENT_FORMAT;
  version: typeof WORKSPACE_DOCUMENT_VERSION;
  createdAt: number;
  connection: {
    portName: string | null;
    baudRate: number;
    mode: 'serial' | 'mock';
    serialSettings: SerialSettings;
    protocolConfig: ProtocolConfig;
  };
  channelMapping: {
    target: string;
    actual: string;
    output: string;
  };
  commands: WorkspaceCommandDraft[];
  emergencyCommandDraft: string | null;
  ai: {
    provider: string;
    apiUrl: string;
    model: string;
    configured: boolean;
  };
  dashboard: VofaDashboardState;
  projectModel?: unknown;
  records?: { sessionIds: string[] };
  activation: {
    automaticWrites: false;
    commandsNeedReview: true;
    recordingDataIncluded: false;
  };
}

export interface WorkspaceBuildInput {
  portName: string | null;
  baudRate: number;
  mode: string;
  serialSettings: SerialSettings;
  protocolConfig: ProtocolConfig;
  channelMapping: WorkspaceDocument['channelMapping'];
  commands: Array<{ id: string; name: string; command: string; is_hex?: boolean; danger?: boolean }>;
  emergencyCommand?: string | null;
  aiConfig?: { provider?: string; api_url?: string; model?: string; api_key?: string; api_key_configured?: boolean };
  dashboard: VofaDashboardState;
  projectModel?: unknown;
  recordSessionIds?: string[];
}

export interface WorkspacePreview {
  ok: boolean;
  document?: WorkspaceDocument;
  errors: string[];
  warnings: string[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hasSecretKey(value: unknown, path = '$'): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const match = hasSecretKey(value[index], `${path}[${index}]`);
      if (match) return match;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (/^(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)$/i.test(key)) {
      return `${path}.${key}`;
    }
    const match = hasSecretKey(child, `${path}.${key}`);
    if (match) return match;
  }
  return null;
}

function normalizeCommands(commands: WorkspaceBuildInput['commands']): WorkspaceCommandDraft[] {
  return commands.slice(0, 256).map((command, index) => ({
    id: String(command.id || `draft-${index + 1}`).slice(0, 128),
    name: String(command.name || `命令草稿 ${index + 1}`).slice(0, 128),
    command: String(command.command || '').slice(0, 16_384),
    isHex: command.is_hex === true,
    danger: command.danger === true,
  }));
}

export function buildWorkspaceDocument(input: WorkspaceBuildInput): WorkspaceDocument {
  const mode: 'serial' | 'mock' = input.mode === 'mock' ? 'mock' : 'serial';
  return {
    format: WORKSPACE_DOCUMENT_FORMAT,
    version: WORKSPACE_DOCUMENT_VERSION,
    createdAt: Date.now(),
    connection: {
      portName: input.portName || null,
      baudRate: Number.isInteger(input.baudRate) ? input.baudRate : 115200,
      mode,
      serialSettings: clone(input.serialSettings),
      protocolConfig: clone(input.protocolConfig),
    },
    channelMapping: {
      target: String(input.channelMapping.target || 'setpoint'),
      actual: String(input.channelMapping.actual || 'actual'),
      output: String(input.channelMapping.output || 'output'),
    },
    commands: normalizeCommands(input.commands),
    emergencyCommandDraft: input.emergencyCommand?.trim() || null,
    ai: {
      provider: String(input.aiConfig?.provider || 'deepseek'),
      apiUrl: String(input.aiConfig?.api_url || ''),
      model: String(input.aiConfig?.model || ''),
      configured: Boolean(input.aiConfig?.api_key?.trim() || input.aiConfig?.api_key_configured),
    },
    dashboard: clone(input.dashboard),
    projectModel: input.projectModel === undefined ? undefined : clone(input.projectModel),
    records: input.recordSessionIds ? { sessionIds: input.recordSessionIds.slice(0, 10_000) } : undefined,
    activation: {
      automaticWrites: false,
      commandsNeedReview: true,
      recordingDataIncluded: false,
    },
  };
}

function validSerialSettings(settings: unknown): settings is SerialSettings {
  if (!settings || typeof settings !== 'object') return false;
  const candidate = settings as Record<string, unknown>;
  return [7, 8].includes(candidate.dataBits as number)
    && ['none', 'even', 'odd'].includes(candidate.parity as string)
    && [1, 2].includes(candidate.stopBits as number)
    && ['none', 'hardware'].includes(candidate.flowControl as string);
}

export function previewWorkspaceDocument(raw: unknown): WorkspacePreview {
  const errors: string[] = [];
  const warnings: string[] = [];
  const secretPath = hasSecretKey(raw);
  if (secretPath) errors.push(`工作区文件包含禁止导入的密钥字段：${secretPath}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['工作区文件必须是 JSON 对象'], warnings };
  }
  const value = raw as Record<string, any>;
  if (value.format !== WORKSPACE_DOCUMENT_FORMAT) errors.push('文件格式不是 LLM 串口工作区');
  if (value.version !== WORKSPACE_DOCUMENT_VERSION) errors.push(`不支持的工作区版本：${String(value.version)}`);
  if (!Number.isFinite(value.createdAt) || value.createdAt <= 0) errors.push('创建时间必须是正的有限时间戳');
  const connection = value.connection;
  if (!connection || typeof connection !== 'object') {
    errors.push('缺少连接配置');
  } else {
    if (!Number.isInteger(connection.baudRate) || connection.baudRate < 50 || connection.baudRate > 4_000_000) {
      errors.push('波特率必须是 50 到 4,000,000 之间的整数');
    }
    if (connection.mode !== 'serial' && connection.mode !== 'mock') errors.push('连接模式无效');
    if (connection.portName !== null && (typeof connection.portName !== 'string' || connection.portName.length > 256)) {
      errors.push('端口名称必须是有限长度字符串或 null');
    }
    if (!validSerialSettings(connection.serialSettings)) errors.push('串口参数不受支持');
    const protocolError = validateProtocolConfig(connection.protocolConfig);
    if (protocolError) errors.push(protocolError);
  }

  const mapping = value.channelMapping;
  if (!mapping || typeof mapping !== 'object' || !['target', 'actual', 'output'].every((key) => typeof mapping[key] === 'string' && mapping[key].length <= 128)) {
    errors.push('通道绑定必须包含有限长度的 target、actual、output 字符串');
  }

  if (!Array.isArray(value.commands) || value.commands.length > 256) {
    errors.push('命令草稿数量必须在 0 到 256 之间');
  } else {
    const commandIds = new Set<string>();
    value.commands.forEach((command: any, index: number) => {
      if (!command || typeof command !== 'object') errors.push(`命令草稿 ${index + 1} 不是对象`);
      else if (typeof command.id !== 'string' || typeof command.name !== 'string' || typeof command.command !== 'string') errors.push(`命令草稿 ${index + 1} 字段无效`);
      else if (command.id.length > 128 || command.name.length > 128 || command.command.length > 16_384) errors.push(`命令草稿 ${index + 1} 超过长度限制`);
      else if (commandIds.has(command.id)) errors.push(`命令草稿 ${index + 1} 的 ID 重复：${command.id}`);
      else if (typeof command.isHex !== 'boolean' || typeof command.danger !== 'boolean') errors.push(`命令草稿 ${index + 1} 的编码或危险标记无效`);
      else commandIds.add(command.id);
    });
  }

  if (value.emergencyCommandDraft !== null
    && (typeof value.emergencyCommandDraft !== 'string' || value.emergencyCommandDraft.length > 16_384)) {
    errors.push('停止命令草稿必须是有限长度字符串或 null');
  }

  if (!value.ai || typeof value.ai !== 'object' || Array.isArray(value.ai)) {
    errors.push('AI 配置摘要缺失');
  } else {
    if (typeof value.ai.provider !== 'string' || value.ai.provider.length > 64) errors.push('AI 服务商字段无效');
    if (typeof value.ai.apiUrl !== 'string' || value.ai.apiUrl.length > 2048) errors.push('AI 地址字段无效');
    if (typeof value.ai.model !== 'string' || value.ai.model.length > 256) errors.push('AI 模型字段无效');
    if (typeof value.ai.configured !== 'boolean') errors.push('AI 已配置标记无效');
  }

  if (value.records !== undefined && value.records !== null) {
    if (!value.records || typeof value.records !== 'object' || !Array.isArray(value.records.sessionIds) || value.records.sessionIds.length > 10_000) {
      errors.push('记录会话引用必须是最多 10,000 项的数组');
    } else if (value.records.sessionIds.some((id: unknown) => typeof id !== 'string' || id.length === 0 || id.length > 256)) {
      errors.push('记录会话引用包含无效 ID');
    }
  }

  if (value.projectModel !== undefined && value.projectModel !== null) {
    const projectCheck = validateProjectModel(value.projectModel);
    if (!projectCheck.valid) {
      errors.push(`控制结构校验失败：${projectCheck.errors.slice(0, 6).join('；')}`);
    }
  }

  if (!value.dashboard) errors.push('缺少画布布局');
  const dashboardResult = value.dashboard ? validateAndMigrateDashboard(value.dashboard) : { ok: false, error: '缺少画布布局' };
  if (!dashboardResult.ok || !dashboardResult.data) errors.push(dashboardResult.error || '画布布局校验失败');

  if (value.activation?.automaticWrites !== false) warnings.push('导入文件未声明自动写入关闭，系统仍会强制关闭自动写入。');
  if (value.activation?.commandsNeedReview !== true) warnings.push('命令草稿未声明复核状态，导入后仍保持草稿。');
  if (value.ai?.configured === true) warnings.push('AI 仅保留已配置标记，API Key 不在工作区文件中。');
  if (value.records?.sessionIds?.length) warnings.push('记录只保存会话引用，不包含原始数据；目标设备上不存在的会话不会被导入。');

  if (errors.length > 0 || !dashboardResult.data) return { ok: false, errors, warnings };
  const document = clone(value) as WorkspaceDocument;
  document.dashboard = dashboardResult.data;
  document.activation = {
    automaticWrites: false,
    commandsNeedReview: true,
    recordingDataIncluded: false,
  };
  document.commands = document.commands.map((command) => ({
    id: command.id,
    name: command.name,
    command: command.command,
    isHex: Boolean(command.isHex),
    danger: Boolean(command.danger),
  }));
  return { ok: true, document, errors, warnings };
}

