<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{
  isOpen: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'change-protocol', protocol: string): void;
}>();

const selectedProtocol = ref<'firewater' | 'justfloat' | 'rawdata' | 'custom'>('firewater');

const protocolList = [
  {
    id: 'firewater',
    name: 'FireWater (文本 CSV / Teleplot)',
    icon: '🔥',
    tag: '默认推荐',
    desc: 'VOFA+ 官方经典文本协议。支持行文本逗号分隔 CSV (如 1.2,3.4,-5.6) 以及 Teleplot 键值格式 (>speed:100)。兼容性最好，易于人眼阅读。',
  },
  {
    id: 'justfloat',
    name: 'JustFloat (小端浮点尾帧)',
    icon: '⚡',
    tag: '高频首选',
    desc: 'VOFA+ 官方极速二进制协议。每帧为小端 IEEE-754 float32 连续流，以 4 字节尾帧 00 00 80 7F (NaN) 封包。高吞吐低 CPU 占用。',
  },
  {
    id: 'rawdata',
    name: 'RawData (原始连续数据块)',
    icon: '📦',
    tag: '纯数据流',
    desc: '直接按 u8 / i16le / f32le 连续多通道截断拆包。适合特定定长二进制传输。',
  },
  {
    id: 'custom',
    name: 'CustomFrame (自定义帧头校验)',
    icon: '🛠️',
    tag: '工业封包',
    desc: '帧头 0xAA 0x55 + 多通道负载 + Sum8 / CRC16-CCITT 校验。防乱码强抗干扰。',
  },
];

function selectProtocol(id: any) {
  selectedProtocol.value = id;
  emit('change-protocol', id);
}
</script>

<template>
  <aside v-if="props.isOpen" class="protocol-drawer">
    <header class="drawer-header">
      <div class="header-title">
        <svg class="w-4 h-4 text-amber-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
        </svg>
        <span>通信协议引擎</span>
      </div>
      <button class="btn-close" @click="emit('close')">✕</button>
    </header>

    <div class="drawer-body">
      <div class="protocol-cards">
        <div
          v-for="p in protocolList"
          :key="p.id"
          class="protocol-card"
          :class="{ active: selectedProtocol === p.id }"
          @click="selectProtocol(p.id)"
        >
          <div class="card-head">
            <span class="p-icon">{{ p.icon }}</span>
            <div class="p-name-col">
              <span class="p-name">{{ p.name }}</span>
              <span class="p-tag">{{ p.tag }}</span>
            </div>
            <span v-if="selectedProtocol === p.id" class="check-mark">✓</span>
          </div>
          <p class="p-desc">{{ p.desc }}</p>
        </div>
      </div>

      <div class="protocol-tip">
        <span class="tip-title">💡 自动嗅探自适应：</span>
        <span class="tip-text">
          系统底层 Rust 管线已内置智能协议嗅探器，可自动分流纯文本日志与波形数据，绝不阻塞硬件流。
        </span>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.protocol-drawer {
  position: absolute;
  top: 0;
  left: 44px;
  bottom: 0;
  width: 310px;
  background: var(--bg-surface);
  border-right: 1px solid var(--border-subtle);
  box-shadow: 4px 0 24px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  z-index: 40;
  user-select: none;
  animation: slideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slideIn {
  from {
    transform: translateX(-12px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.drawer-header {
  height: 44px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-base);
}

.header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
  white-space: nowrap;
}

.header-title svg {
  width: 16px;
  height: 16px;
  min-width: 16px;
  min-height: 16px;
  flex-shrink: 0;
}

.btn-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px 6px;
  font-size: 14px;
  border-radius: 4px;
}

.btn-close:hover {
  background: var(--bg-elevated);
  color: var(--text-main);
}

.drawer-body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.protocol-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.protocol-card {
  padding: 10px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}

.protocol-card:hover {
  background: var(--bg-surface);
  border-color: var(--accent-terracotta);
}

.protocol-card.active {
  background: rgba(218, 119, 86, 0.1);
  border-color: var(--accent-terracotta);
  box-shadow: 0 0 12px rgba(218, 119, 86, 0.2);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.p-icon {
  font-size: 16px;
}

.p-name-col {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.p-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-main);
}

.p-tag {
  font-size: 10px;
  color: var(--accent-terracotta);
}

.check-mark {
  color: var(--accent-terracotta);
  font-weight: bold;
}

.p-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
  margin: 0;
}

.protocol-tip {
  padding: 10px;
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  font-size: 11px;
}

.tip-title {
  color: #fbbf24;
  font-weight: 600;
}

.tip-text {
  color: var(--text-muted);
  line-height: 1.4;
}
</style>
