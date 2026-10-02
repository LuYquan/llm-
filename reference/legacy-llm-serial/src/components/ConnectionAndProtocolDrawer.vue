<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { SerialPortInfo } from './TopBar.vue';
import type { SerialSettings } from '../services/transport/types';
import type { ChecksumType, CustomFrameDataType, ProtocolConfig, RawDataFormat } from '../core/protocol/types';
import { validateProtocolConfig } from '../core/protocol/types';

const props = defineProps<{
  isOpen: boolean;
  isRunning: boolean;
  connectionState: 'connected' | 'disconnected' | 'connecting' | 'reconnecting' | 'error';
  selectedPort: string;
  selectedBaud: string;
  serialSettings: SerialSettings;
  ports: SerialPortInfo[];
  isRefreshingPorts: boolean;
  canRequestPort?: boolean;
  canControlSignals?: boolean;
  dtrState?: boolean | null;
  rtsState?: boolean | null;
  currentProtocol?: string;
  protocolConfig?: ProtocolConfig;
  isApplyingProtocol?: boolean;
  rxBytes?: number | null;
  parsedSamples?: number;
  protocolErrors?: number;
  droppedBytes?: number;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'toggle-connect'): void;
  (e: 'change-port', port: string): void;
  (e: 'change-baud', baud: string): void;
  (e: 'change-serial-settings', settings: SerialSettings): void;
  (e: 'refresh-ports'): void;
  (e: 'request-port'): void;
  (e: 'apply-protocol', config: ProtocolConfig): void;
  (e: 'set-dtr', enabled: boolean): void;
  (e: 'set-rts', enabled: boolean): void;
  (e: 'set-break', enabled: boolean): void;
}>();

// 协议引擎列表 (对标 VOFA+ 官方协议)
function defaultProtocol(id: string): ProtocolConfig {
  if (id === 'justfloat') return { type: 'justfloat', channels: null };
  if (id === 'rawdata') return { type: 'rawdata', mode: 'display', format: 'u8', channels: 1 };
  if (id === 'custom') return {
    type: 'custom', header: [0xaa, 0x55], tail: [], channels: 2,
    dataType: 'i16le', checksum: 'crc16_ccitt', checksumByteOrder: 'big',
  };
  return { type: 'firewater' };
}

const pendingProtocol = ref<ProtocolConfig>(props.protocolConfig || defaultProtocol(props.currentProtocol || 'firewater'));
const selectedProtocol = ref<string>(pendingProtocol.value.type);
const customHeaderText = ref('AA 55');
const customTailText = ref('');
const protocolError = ref('');
const showProtoHelp = ref(false);

function syncCustomFields(config: ProtocolConfig) {
  if (config.type !== 'custom') return;
  customHeaderText.value = config.header.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  customTailText.value = config.tail.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

watch(() => [props.isOpen, props.protocolConfig] as const, ([isOpen, config]) => {
  if (isOpen && config) {
    pendingProtocol.value = JSON.parse(JSON.stringify(config)) as ProtocolConfig;
    selectedProtocol.value = config.type;
    syncCustomFields(config);
    protocolError.value = '';
  }
});

const protocolList = [
  {
    id: 'firewater',
    name: 'FireWater',
    badge: '推荐',
    summary: 'CSV 数值行或命名 Teleplot，与 UTF-8 日志共用串口',
    codeSample: '// CSV 列 ID：setpoint、actual、output\nprintf("%f,%f,%f\\n", target, actual, output);\n\n// 或使用命名 Teleplot：>变量名:数值\\n\nprintf(">target:%f\\n>actual:%f\\n>output:%f\\n", target, actual, output);',
    helpNotes: [
      'CSV 默认前三列为 setpoint / actual / output，含义和单位仍由固件定义；单变量可用命名 Teleplot。',
      '# 开头的行是日志，不是 CSV 表头。不要用 #target,actual,output 声明通道名。',
      '每行用 LF 或 CRLF 结束，发送有限数值。选择 CSV 或 Teleplot 的一种数值布局，再绑定当前环的目标、反馈和输出。',
    ],
  },
  {
    id: 'justfloat',
    name: 'JustFloat',
    badge: '高速',
    summary: '小端 IEEE-754 单精度浮点序列 + 00 00 80 7F 尾帧；通道数可指定或自动识别',
    codeSample: '发送：float32 小端通道值... + 00 00 80 7F',
    helpNotes: [
      '通道依次为 ch0、ch1…，请核对顺序、通道数和原始单位。主机接收时间不是设备采样时钟。',
      '不要混入 ASCII 日志或 ACK。调参可用独立参数通道回传，或逐轮人工核对；文本 ACK 仅支持 FireWater。',
    ],
  },
  {
    id: 'rawdata',
    name: 'RawData',
    badge: '透传',
    summary: '默认只显示原始字节；启用数值解码后按指定类型与通道数组帧',
    codeSample: '原始显示：按实际固件格式发送字节\n数值解码：核对数值类型 + 通道数，再应用配置',
    helpNotes: [
      '只显示原始字节时不产生数值通道，不能直接用于波形或调参反馈。',
      '解码模式按连续固定宽度帧分组；需知道固件布局。此路径不解析文本 ACK。',
    ],
  },
  {
    id: 'custom',
    name: 'CustomFrame',
    badge: '工业',
    summary: '固定帧头 + 固定长度负载 + 可选校验 + 可选帧尾',
    codeSample: '[Header] [Payload] [Checksum?] [Tail?]；校验范围为负载字节',
    helpNotes: [
      '按固件核对帧头、固定负载长度、数值类型、校验和帧尾；不会自动识别变长字段或单位。',
      '数值帧不解析文本 ACK。调参确认使用独立参数通道回传，或逐轮人工核对。',
    ],
  },
];

const appliedProtocol = computed(() => props.protocolConfig?.type || props.currentProtocol || 'firewater');
const hasPendingProtocolChanges = computed(() =>
  JSON.stringify(pendingProtocol.value) !== JSON.stringify(props.protocolConfig || defaultProtocol(props.currentProtocol || 'firewater'))
);

// 串口参数
const baudRates = ['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600', '1500000', '2000000', 'custom'];
const isCustomBaud = ref(false);
const customBaudValue = ref('115200');

function updateSerialSettings(patch: Partial<SerialSettings>) {
  emit('change-serial-settings', { ...props.serialSettings, ...patch });
}

// Break 是按住有效、松开立即清除的瞬时操作。
const breakActive = ref(false);

function handleProtocolSelect(id: string) {
  selectedProtocol.value = id;
  pendingProtocol.value = defaultProtocol(id);
  syncCustomFields(pendingProtocol.value);
  protocolError.value = '';
}

function setJustFloatChannels(raw: string) {
  if (pendingProtocol.value.type !== 'justfloat') return;
  const value = raw.trim() ? Number(raw) : null;
  pendingProtocol.value = { type: 'justfloat', channels: value };
}

function setRawDataField(field: 'mode' | 'format' | 'channels', raw: string) {
  if (pendingProtocol.value.type !== 'rawdata') return;
  pendingProtocol.value = {
    ...pendingProtocol.value,
    ...(field === 'mode' ? { mode: raw as 'display' | 'decode' } : {}),
    ...(field === 'format' ? { format: raw as RawDataFormat } : {}),
    ...(field === 'channels' ? { channels: Number(raw) } : {}),
  };
}

function setCustomField(field: 'channels' | 'dataType' | 'checksum' | 'checksumByteOrder', raw: string) {
  if (pendingProtocol.value.type !== 'custom') return;
  pendingProtocol.value = {
    ...pendingProtocol.value,
    ...(field === 'channels' ? { channels: Number(raw) } : {}),
    ...(field === 'dataType' ? { dataType: raw as CustomFrameDataType } : {}),
    ...(field === 'checksum' ? { checksum: raw as ChecksumType } : {}),
    ...(field === 'checksumByteOrder' ? { checksumByteOrder: raw as 'little' | 'big' } : {}),
  };
}

function parseHexBytes(text: string, allowEmpty = false): number[] {
  const normalized = text.trim().replace(/0x/gi, '').replace(/[,:;]/g, ' ');
  if (!normalized && allowEmpty) return [];
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (!parts.length || parts.some((part) => !/^[\da-f]{2}$/i.test(part))) {
    throw new Error('请输入空格分隔的完整 HEX 字节，例如 AA 55 0D 0A');
  }
  return parts.map((part) => Number.parseInt(part, 16));
}

function applyProtocolSelection() {
  try {
    let config = pendingProtocol.value;
    if (config.type === 'custom') {
      config = { ...config, header: parseHexBytes(customHeaderText.value), tail: parseHexBytes(customTailText.value, true) };
    }
    const error = validateProtocolConfig(config);
    if (error) throw new Error(error);
    emit('apply-protocol', config);
    protocolError.value = '';
  } catch (error) {
    protocolError.value = error instanceof Error ? error.message : String(error);
  }
}

function handleBaudChange(val: string) {
  if (val === 'custom') {
    isCustomBaud.value = true;
    emit('change-baud', customBaudValue.value);
  } else {
    isCustomBaud.value = false;
    emit('change-baud', val);
  }
}

function handleCustomBaudBlur() {
  if (customBaudValue.value.trim()) {
    emit('change-baud', customBaudValue.value.trim());
  }
}

function setBreak(enabled: boolean) {
  if (breakActive.value === enabled) return;
  breakActive.value = enabled;
  emit('set-break', enabled);
}

function startBreak(event: PointerEvent) {
  (event.currentTarget as HTMLButtonElement | null)?.setPointerCapture?.(event.pointerId);
  setBreak(true);
}

function endBreak(event?: PointerEvent) {
  setBreak(false);
  const target = event?.currentTarget as HTMLButtonElement | null;
  if (event && target?.hasPointerCapture?.(event.pointerId)) {
    target.releasePointerCapture(event.pointerId);
  }
}

watch(() => [props.isOpen, props.isRunning] as const, ([isOpen, isRunning]) => {
  if (!isOpen || !isRunning) setBreak(false);
});

onBeforeUnmount(() => setBreak(false));
</script>

<template>
  <aside v-if="props.isOpen" class="connection-protocol-drawer">
    <header class="drawer-header">
      <div class="header-title">
        <svg class="w-4 h-4 text-emerald-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
          <polyline points="15 3 21 3 21 9"></polyline>
          <line x1="10" y1="14" x2="21" y2="3"></line>
        </svg>
        <span>协议与接口连接</span>
      </div>
      <button type="button" class="btn-close" aria-label="关闭连接与协议设置" @click="emit('close')">✕</button>
    </header>

    <div class="drawer-body custom-scrollbar">
      <!-- 1. 数据引擎选择 (Data Engine) -->
      <section class="drawer-section">
        <div class="section-title-row">
          <span class="section-title">数据引擎 (Protocol Engine)</span>
          <button type="button" class="btn-help-proto" :aria-expanded="showProtoHelp" aria-controls="protocol-help" aria-label="查看协议接入说明" @click="showProtoHelp = !showProtoHelp" title="查看协议说明与固件发送示例">
            ?
          </button>
        </div>

        <div class="protocol-grid">
          <button
            v-for="p in protocolList"
            :key="p.id"
            class="proto-card-btn"
            :class="{ active: selectedProtocol === p.id }"
            :aria-pressed="selectedProtocol === p.id"
            @click="handleProtocolSelect(p.id)"
          >
            <div class="proto-top">
              <span class="proto-name font-bold">{{ p.name }}</span>
              <span class="proto-badge">{{ p.badge }}</span>
            </div>
            <p class="proto-summary">{{ p.summary }}</p>
          </button>
        </div>

        <!-- 协议代码范例浮动卡片 -->
        <div v-if="showProtoHelp" id="protocol-help" class="proto-help-card">
          <div class="help-header">
            <span>下位机发送范例 ({{ selectedProtocol }})</span>
            <button type="button" class="btn-mini-close" aria-label="关闭协议接入说明" @click="showProtoHelp = false">✕</button>
          </div>
          <pre class="help-code"><code>{{ protocolList.find((p) => p.id === selectedProtocol)?.codeSample }}</code></pre>
          <p v-for="note in protocolList.find((p) => p.id === selectedProtocol)?.helpNotes" :key="note" class="protocol-hint">{{ note }}</p>
          <p class="protocol-hint">完整接入步骤见 README 中的「下位机接入与场景反馈指南」。示例仅说明格式，不是设备控制值或安全参数。</p>
        </div>

        <p v-if="!props.isRunning" class="protocol-hint">没有设备也可打开「AI 辅助 → 场景调参」，选择「物理模型计算」做离线模型练习；设备通道和写入设置在实机阶段核对。</p>

        <p class="protocol-hint" role="status">
          当前应用：{{ protocolList.find((p) => p.id === appliedProtocol)?.name || appliedProtocol }}。
          {{ hasPendingProtocolChanges ? '下方是未应用草稿，点击按钮后才会改变实时解析。' : '解析配置已同步。' }}
        </p>

        <div v-if="pendingProtocol.type === 'justfloat'" class="protocol-settings">
          <label class="form-row">
            <span class="form-label">通道数（留空自动识别）:</span>
            <input class="form-select" type="number" min="1" max="64" :value="pendingProtocol.channels ?? ''" @input="setJustFloatChannels(($event.target as HTMLInputElement).value)" />
          </label>
        </div>

        <div v-else-if="pendingProtocol.type === 'rawdata'" class="protocol-settings">
          <label class="form-row">
            <span class="form-label">处理方式:</span>
            <select class="form-select" :value="pendingProtocol.mode" @change="setRawDataField('mode', ($event.target as HTMLSelectElement).value)">
              <option value="display">只显示原始字节</option>
              <option value="decode">解码为波形</option>
            </select>
          </label>
          <label class="form-row">
            <span class="form-label">数值类型:</span>
            <select class="form-select" :value="pendingProtocol.format" @change="setRawDataField('format', ($event.target as HTMLSelectElement).value)">
              <option v-for="format in ['u8','i8','u16le','u16be','i16le','i16be','u32le','u32be','i32le','i32be','f32le','f32be','f64le','f64be']" :key="format" :value="format">{{ format }}</option>
            </select>
          </label>
          <label v-if="pendingProtocol.mode === 'decode'" class="form-row">
            <span class="form-label">通道数:</span>
            <input class="form-select" type="number" min="1" max="64" :value="pendingProtocol.channels" @input="setRawDataField('channels', ($event.target as HTMLInputElement).value)" />
          </label>
          <p class="protocol-hint">RawData 解码按连续固定宽度帧分组；主机接收时间只表示块到达时间，不代表设备采样时钟。</p>
        </div>

        <div v-else-if="pendingProtocol.type === 'custom'" class="protocol-settings">
          <label class="form-row">
            <span class="form-label">帧头 HEX:</span>
            <input v-model="customHeaderText" class="form-select font-mono" placeholder="AA 55" />
          </label>
          <label class="form-row">
            <span class="form-label">帧尾 HEX（可空）:</span>
            <input v-model="customTailText" class="form-select font-mono" placeholder="例如 0D 0A" />
          </label>
          <label class="form-row">
            <span class="form-label">通道数:</span>
            <input class="form-select" type="number" min="1" max="64" :value="pendingProtocol.channels" @input="setCustomField('channels', ($event.target as HTMLInputElement).value)" />
          </label>
          <label class="form-row">
            <span class="form-label">负载数值类型:</span>
            <select class="form-select" :value="pendingProtocol.dataType" @change="setCustomField('dataType', ($event.target as HTMLSelectElement).value)">
              <option v-for="format in ['u8','i8','u16le','u16be','i16le','i16be','u32le','u32be','i32le','i32be','f32le','f32be','f64le','f64be']" :key="format" :value="format">{{ format }}</option>
            </select>
          </label>
          <label class="form-row">
            <span class="form-label">校验（仅负载字节）:</span>
            <select class="form-select" :value="pendingProtocol.checksum" @change="setCustomField('checksum', ($event.target as HTMLSelectElement).value)">
              <option value="none">无</option>
              <option value="sum8">Sum8</option>
              <option value="xor8">XOR8</option>
              <option value="crc16_modbus">CRC-16/MODBUS</option>
              <option value="crc16_ccitt">CRC-16/CCITT（初值 0）</option>
            </select>
          </label>
          <label v-if="pendingProtocol.checksum === 'crc16_modbus' || pendingProtocol.checksum === 'crc16_ccitt'" class="form-row">
            <span class="form-label">校验字节序:</span>
            <select class="form-select" :value="pendingProtocol.checksumByteOrder" @change="setCustomField('checksumByteOrder', ($event.target as HTMLSelectElement).value)">
              <option value="little">Little-endian</option>
              <option value="big">Big-endian</option>
            </select>
          </label>
          <p class="protocol-hint">当前为固定长度负载，不支持变长 Len 字段；校验覆盖负载，不包含帧头或帧尾。</p>
        </div>

        <p v-if="protocolError" class="protocol-error" role="alert">{{ protocolError }}</p>
        <button class="btn-apply-protocol" :disabled="props.isApplyingProtocol" :aria-busy="props.isApplyingProtocol || undefined" @click="applyProtocolSelection">
          {{ props.isApplyingProtocol ? '正在应用…' : '应用到实时解析' }}
        </button>
      </section>

      <section class="drawer-section protocol-diagnostics" aria-labelledby="protocol-diagnostics-title">
        <div class="section-title-row">
          <span id="protocol-diagnostics-title" class="section-title">实时解析诊断</span>
          <span class="diagnostic-state" :class="{ active: props.isRunning }">{{ props.isRunning ? '监听中' : '未连接' }}</span>
        </div>
        <dl class="diagnostic-grid">
          <div><dt>原始 RX 字节</dt><dd>{{ props.rxBytes === null || props.rxBytes === undefined ? '—' : props.rxBytes.toLocaleString() }}</dd></div>
          <div><dt>有效样本</dt><dd>{{ (props.parsedSamples ?? 0).toLocaleString() }}</dd></div>
          <div><dt>协议错误</dt><dd :class="{ 'diagnostic-danger': (props.protocolErrors ?? 0) > 0 }">{{ (props.protocolErrors ?? 0).toLocaleString() }}</dd></div>
          <div><dt>丢弃字节</dt><dd :class="{ 'diagnostic-danger': (props.droppedBytes ?? 0) > 0 }">{{ (props.droppedBytes ?? 0).toLocaleString() }}</dd></div>
        </dl>
        <p class="protocol-hint">原始字节、解析样本、协议错误和重同步丢弃分别统计；有效样本为 0 时不能据此判断设备没有发送。</p>
      </section>

      <!-- 2. 数据接口 (Physical Interface) -->
      <section class="drawer-section">
        <div class="section-title-row">
          <span class="section-title">数据接口</span>
        </div>
        <p class="protocol-hint">当前版本支持串口与独立演示数据源；网络传输尚未接通。</p>
      </section>

      <!-- 3. 串口详细硬件参数设置 -->
      <section class="drawer-section">
        <div class="section-title-row">
          <span class="section-title">串口参数配置</span>
        </div>

        <!-- 端口号 -->
        <div class="form-row">
          <div class="form-label-box">
            <span class="form-label">端口号:</span>
            <button
              class="btn-refresh-port"
              :class="{ spinning: props.isRefreshingPorts }"
              :disabled="props.isRunning || props.isRefreshingPorts"
              @click="emit('refresh-ports')"
              title="刷新扫描本地 COM 口"
            >
              🔄
            </button>
          </div>
          <select
            class="form-select"
            :value="props.selectedPort"
            :disabled="props.isRunning"
            @change="(e) => emit('change-port', (e.target as HTMLSelectElement).value)"
          >
            <option v-if="props.ports.length === 0 && !props.selectedPort" value="" disabled>未检测到串口</option>
            <option
              v-for="p in props.ports"
              :key="p.port_name"
              :value="p.port_name"
            >
              {{ p.port_name }} {{ p.description ? `(${p.description})` : '' }}
            </option>
          </select>
        </div>

        <!-- WebSerial 授权按钮 -->
        <div v-if="props.canRequestPort" class="form-row-full">
          <button class="btn-webserial" :disabled="props.isRunning" @click="emit('request-port')">
            + 授权外部 Web 串口设备
          </button>
        </div>

        <!-- 波特率 (支持任意非标波特率输入) -->
        <div class="form-row">
          <span class="form-label">波特率:</span>
          <div class="baud-select-wrap">
            <select
              class="form-select"
              :value="isCustomBaud ? 'custom' : props.selectedBaud"
              :disabled="props.isRunning"
              @change="(e) => handleBaudChange((e.target as HTMLSelectElement).value)"
            >
              <option v-for="b in baudRates" :key="b" :value="b">
                {{ b === 'custom' ? '自定义波特率...' : `${b} bps` }}
              </option>
            </select>
            <input
              v-if="isCustomBaud"
              v-model="customBaudValue"
              type="number"
              class="custom-baud-input font-mono"
              placeholder="输入非标波特率"
              :disabled="props.isRunning"
              @blur="handleCustomBaudBlur"
              @keydown.enter="handleCustomBaudBlur"
            />
          </div>
        </div>

        <!-- 高级通信参数：数据位、校验位、停止位、流控 -->
        <div class="grid-2col">
          <div class="col-item">
            <span class="col-label">数据位:</span>
            <select :value="props.serialSettings.dataBits" class="form-select mini" :disabled="props.isRunning" @change="(e) => updateSerialSettings({ dataBits: Number((e.target as HTMLSelectElement).value) as SerialSettings['dataBits'] })">
              <option :value="8">8</option>
              <option :value="7">7</option>
            </select>
          </div>
          <div class="col-item">
            <span class="col-label">校验位:</span>
            <select :value="props.serialSettings.parity" class="form-select mini" :disabled="props.isRunning" @change="(e) => updateSerialSettings({ parity: (e.target as HTMLSelectElement).value as SerialSettings['parity'] })">
              <option value="none">None (无)</option>
              <option value="odd">Odd (奇)</option>
              <option value="even">Even (偶)</option>
            </select>
          </div>
          <div class="col-item">
            <span class="col-label">停止位:</span>
            <select :value="props.serialSettings.stopBits" class="form-select mini" :disabled="props.isRunning" @change="(e) => updateSerialSettings({ stopBits: Number((e.target as HTMLSelectElement).value) as SerialSettings['stopBits'] })">
              <option :value="1">1</option>
              <option :value="2">2</option>
            </select>
          </div>
          <div class="col-item">
            <span class="col-label">硬件流控:</span>
            <select :value="props.serialSettings.flowControl" class="form-select mini" :disabled="props.isRunning" @change="(e) => updateSerialSettings({ flowControl: (e.target as HTMLSelectElement).value as SerialSettings['flowControl'] })">
              <option value="none">None</option>
              <option value="hardware">RTS/CTS 硬件流控</option>
            </select>
          </div>
        </div>

        <!-- 物理串口控制信号 (DTR / RTS / Break) -->
        <div class="pins-control-box">
          <span class="pins-label">物理控制信号（有效/无效）</span>
          <p v-if="!props.canControlSignals" class="pins-unavailable" role="status">
            当前桌面原生串口驱动尚未接入物理信号控制；这些按钮已禁用，不会模拟成功状态。
          </p>
          <div class="pins-button-group signal-levels">
            <button
              class="pin-btn"
              :class="{ active: props.dtrState === true }"
              :disabled="!props.isRunning || !props.canControlSignals"
              @click="emit('set-dtr', true)"
              title="将 DTR 控制信号设为有效；可能触发设备复位或 ISP 模式"
            >
              DTR 有效
            </button>
            <button
              class="pin-btn"
              :class="{ active: props.dtrState === false }"
              :disabled="!props.isRunning || !props.canControlSignals"
              @click="emit('set-dtr', false)"
              title="将 DTR 控制信号设为无效"
            >
              DTR 无效
            </button>
            <button
              class="pin-btn"
              :class="{ active: props.rtsState === true }"
              :disabled="!props.isRunning || !props.canControlSignals"
              @click="emit('set-rts', true)"
              title="将 RTS 控制信号设为有效"
            >
              RTS 有效
            </button>
            <button
              class="pin-btn"
              :class="{ active: props.rtsState === false }"
              :disabled="!props.isRunning || !props.canControlSignals"
              @click="emit('set-rts', false)"
              title="将 RTS 控制信号设为无效"
            >
              RTS 无效
            </button>
          </div>
          <div class="pins-button-group">
            <button
              class="pin-btn btn-break"
              :class="{ active: breakActive }"
              :disabled="!props.isRunning || !props.canControlSignals"
              :aria-pressed="breakActive"
              @pointerdown.prevent="startBreak"
              @pointerup="endBreak"
              @pointercancel="endBreak"
              @lostpointercapture="setBreak(false)"
              @keydown.enter.prevent="setBreak(true)"
              @keyup.enter.prevent="setBreak(false)"
              @keydown.space.prevent="setBreak(true)"
              @keyup.space.prevent="setBreak(false)"
              @blur="setBreak(false)"
              title="按住时发送 Break 信号，松开或失焦时立即清除"
            >
              {{ breakActive ? 'Break 有效（松开清除）' : '按住发送 Break' }}
            </button>
          </div>
        </div>
      </section>

      <!-- 4. 打开 / 关闭物理连接总控大按钮 -->
      <section class="drawer-section section-action">
        <button
          class="btn-connection-master"
          :class="{
            'is-connected': props.connectionState === 'connected',
            'is-disconnected': props.connectionState === 'disconnected',
            'is-busy': props.connectionState === 'connecting' || props.connectionState === 'reconnecting',
          }"
          :disabled="props.connectionState === 'connecting'"
          @click="emit('toggle-connect')"
        >
          <span class="state-dot"></span>
          <span class="state-label">
            <template v-if="props.connectionState === 'connected'">已连接 (点击断开)</template>
            <template v-else-if="props.connectionState === 'connecting'">正在连接串口...</template>
            <template v-else>打开物理设备连接</template>
          </span>
        </button>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.connection-protocol-drawer {
  position: absolute;
  top: 0;
  left: 44px;
  bottom: 0;
  width: 320px;
  background: var(--bg-surface, #272623);
  border-right: 1px solid var(--border-subtle, #383633);
  display: flex;
  flex-direction: column;
  z-index: 40;
  box-shadow: var(--card-shadow, 10px 0 30px rgba(0, 0, 0, 0.3));
  user-select: none;
  transition: background-color 0.25s ease, border-color 0.25s ease;
}

.protocol-settings {
  display: grid;
  gap: 8px;
  padding: 12px;
  margin-top: 10px;
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 8px;
  background: var(--bg-elevated, #2F2E2A);
}

.protocol-settings .form-row {
  display: grid;
  grid-template-columns: minmax(108px, 0.8fr) minmax(0, 1.2fr);
  align-items: center;
  gap: 8px;
}

.protocol-hint {
  color: var(--text-muted, #9E9C94);
  font-size: 11px;
  line-height: 1.5;
}

.protocol-diagnostics {
  background: var(--bg-elevated, #2F2E2A);
}

.diagnostic-state {
  color: var(--text-muted, #9E9C94);
  font-size: 10px;
}

.diagnostic-state.active {
  color: #7AA89B;
}

.diagnostic-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
}

.diagnostic-grid > div {
  padding: 8px;
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  background: var(--bg-surface, #272623);
}

.diagnostic-grid dt {
  color: var(--text-muted, #9E9C94);
  font-size: 10px;
}

.diagnostic-grid dd {
  margin-top: 4px;
  color: var(--text-main, #ECEAE4);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}

.diagnostic-grid dd.diagnostic-danger {
  color: #E06D85;
}

.protocol-error {
  margin-top: 8px;
  color: #E06D85;
  font-size: 12px;
}

.btn-apply-protocol {
  width: 100%;
  margin-top: 10px;
  padding: 9px 12px;
  border: 1px solid var(--accent-terracotta, #DA7756);
  border-radius: 7px;
  color: #ffffff;
  background: var(--accent-terracotta, #DA7756);
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-apply-protocol:hover:not(:disabled) {
  background: var(--accent-terracotta-hover, #E58565);
  border-color: var(--accent-terracotta-hover, #E58565);
}

.btn-apply-protocol:disabled {
  cursor: wait;
  opacity: 0.6;
}

.drawer-header {
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  background: var(--bg-elevated, #2F2E2A);
  border-bottom: 1px solid var(--border-subtle, #383633);
}

.header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
}

.btn-close {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
  font-size: 14px;
  border-radius: 4px;
  padding: 2px 6px;
  transition: all 0.15s;
}

.btn-close:hover {
  background: var(--bg-surface, #272623);
  color: var(--text-main, #ECEAE4);
}

.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.drawer-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted, #9E9C94);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.btn-help-proto {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--accent-terracotta, #DA7756);
  font-size: 10px;
  font-weight: bold;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: all 0.15s;
}

.btn-help-proto:hover {
  background: var(--accent-terracotta, #DA7756);
  color: #ffffff;
}

.protocol-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.proto-card-btn {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  padding: 8px;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
}

.proto-card-btn:hover {
  background: var(--bg-surface, #272623);
  border-color: var(--accent-terracotta, #DA7756);
}

.proto-card-btn.active {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
  border-color: var(--accent-terracotta, #DA7756);
  box-shadow: 0 0 10px var(--accent-terracotta-soft, rgba(218, 119, 86, 0.2));
}

.proto-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.proto-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
}

.proto-badge {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.18));
  color: var(--accent-terracotta, #DA7756);
  font-weight: 500;
}

.proto-summary {
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
  margin: 0;
  line-height: 1.3;
}

.proto-help-card {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  padding: 8px;
}

.help-header {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--accent-terracotta, #DA7756);
  margin-bottom: 4px;
}

.btn-mini-close {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  cursor: pointer;
  font-size: 10px;
}

.btn-mini-close:hover {
  color: var(--text-main, #ECEAE4);
}

.help-code {
  margin: 0;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  color: var(--text-main, #ECEAE4);
  background: var(--bg-surface, #272623);
  padding: 4px 6px;
  border-radius: 4px;
  white-space: pre-wrap;
}

/* 接口切片行 */
.interface-toggle-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
}

.interface-pill {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  color: var(--text-muted, #9E9C94);
  font-size: 10px;
  padding: 5px 2px;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s ease;
}

.interface-pill:hover,
.interface-pill.active {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
  color: var(--accent-terracotta, #DA7756);
  border-color: var(--accent-terracotta, #DA7756);
}

/* 表单行 */
.form-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.form-label-box {
  display: flex;
  align-items: center;
  gap: 4px;
}

.form-label {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
}

.btn-refresh-port {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 10px;
  padding: 0;
  color: var(--text-muted, #9E9C94);
}

.btn-refresh-port:hover {
  color: var(--accent-terracotta, #DA7756);
}

.btn-refresh-port.spinning {
  animation: spin 1s infinite linear;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.form-select {
  flex: 1;
  max-width: 200px;
  height: 26px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  color: var(--text-main, #ECEAE4);
  font-size: 11px;
  padding: 0 6px;
  outline: none;
  cursor: pointer;
}

.form-select:focus {
  border-color: var(--accent-terracotta, #DA7756);
}

.form-select.mini {
  max-width: 100%;
}

.baud-select-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.custom-baud-input {
  height: 22px;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--accent-terracotta, #DA7756);
  border-radius: 4px;
  color: var(--accent-terracotta, #DA7756);
  font-size: 11px;
  padding: 0 6px;
  outline: none;
}

.btn-webserial {
  width: 100%;
  background: var(--bg-elevated, #2F2E2A);
  border: 1px dashed var(--accent-terracotta, #DA7756);
  color: var(--accent-terracotta, #DA7756);
  font-size: 11px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-webserial:hover {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
}

.grid-2col {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.col-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.col-label {
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
}

/* 引脚点动控制 */
.pins-control-box {
  background: var(--bg-elevated, #2F2E2A);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 6px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pins-label {
  font-size: 10px;
  color: var(--text-muted, #9E9C94);
}

.pins-button-group {
  display: flex;
  gap: 6px;
}

.pins-button-group.signal-levels {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.pins-unavailable {
  color: #E59E38;
  font-size: 9px;
  line-height: 1.45;
}

.pin-btn {
  flex: 1;
  height: 24px;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  color: var(--text-main, #ECEAE4);
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.pin-btn:hover:not(:disabled) {
  background: var(--bg-elevated, #2F2E2A);
  color: var(--accent-terracotta, #DA7756);
  border-color: var(--accent-terracotta, #DA7756);
}

.pin-btn.active {
  background: var(--accent-terracotta, #DA7756);
  color: #ffffff;
  border-color: var(--accent-terracotta, #DA7756);
}

.pin-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-break {
  color: #E59E38;
}

/* 连接主控制按钮 */
.section-action {
  margin-top: 8px;
}

.btn-connection-master {
  width: 100%;
  height: 36px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-connection-master.is-disconnected {
  background: var(--accent-terracotta, #DA7756);
  border: 1px solid var(--accent-terracotta, #DA7756);
  color: #ffffff;
}

.btn-connection-master.is-disconnected:hover {
  background: var(--accent-terracotta-hover, #E58565);
  border-color: var(--accent-terracotta-hover, #E58565);
}

.btn-connection-master.is-connected {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid #ef4444;
  color: #fca5a5;
}

.btn-connection-master.is-connected:hover {
  background: rgba(239, 68, 68, 0.3);
}

.state-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}
</style>
