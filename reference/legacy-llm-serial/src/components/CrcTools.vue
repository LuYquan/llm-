<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { parseInputBytes, calcModbusCrc16, calcCrc32, calcSum8, calcXor8 } from '../utils/crc';
import type { ChecksumResult } from '../types/ipc';
import { useSerialSession } from '../services/transport/session';

const emit = defineEmits<{
  (e: 'append-to-send', text: string): void;
}>();

const session = useSerialSession();

const inputData = ref('01 03 00 00 00 02');
const isHex = ref(true);

const computedBytes = computed(() => {
  return parseInputBytes(inputData.value, isHex.value);
});

const modbusCrc = computed(() => calcModbusCrc16(computedBytes.value));
const crc32Val = computed(() => calcCrc32(computedBytes.value));
const sum8Val = computed(() => calcSum8(computedBytes.value));
const xor8Val = computed(() => calcXor8(computedBytes.value));

const backendChecksum = ref<ChecksumResult | null>(null);

async function refreshBackendChecksum() {
  try {
    const res = await session.calculateChecksums(inputData.value, isHex.value);
    if (res) {
      backendChecksum.value = res;
      return;
    }
  } catch {}
  // 在 Web 环境下自适应采用前端纯 TS 校验计算
  backendChecksum.value = {
    crc16_modbus: modbusCrc.value.crc,
    crc16_modbus_hex_le: modbusCrc.value.hexLittleEndian,
    crc16_modbus_hex_be: modbusCrc.value.hexBigEndian,
    crc32: crc32Val.value.crc,
    crc32_hex: crc32Val.value.hex,
    sum8: sum8Val.value.sum,
    sum8_hex: sum8Val.value.hex,
    xor8: xor8Val.value.xor,
    xor8_hex: xor8Val.value.hex,
  };
}

watch([inputData, isHex], () => {
  refreshBackendChecksum();
});

onMounted(() => {
  refreshBackendChecksum();
});

const copiedIndex = ref<string | null>(null);

function copyText(key: string, text: string) {
  navigator.clipboard.writeText(text).then(() => {
    copiedIndex.value = key;
    setTimeout(() => {
      copiedIndex.value = null;
    }, 1500);
  });
}

function appendToSend(text: string) {
  emit('append-to-send', text);
}
</script>

<template>
  <div class="crc-tools-card">
    <div class="card-header">
      <div class="title-group">
        <span class="tool-icon">🛠️</span>
        <span class="card-title">硬件校验计算器</span>
      </div>
      <label class="opt-label">
        <input type="checkbox" v-model="isHex" />
        <span>HEX 输入</span>
      </label>
    </div>

    <div class="card-body">
      <div class="input-row">
        <input
          type="text"
          class="data-input font-mono"
          v-model="inputData"
          :placeholder="isHex ? '输入 HEX 字符串 (如 01 03 00 00 00 02)' : '输入文本...'"
        />
      </div>

      <div class="results-table font-mono">
        <!-- Modbus CRC16 -->
        <div class="result-row">
          <div class="name-col">
            <span class="algo-name">Modbus CRC16</span>
            <span class="algo-sub">(低位在前)</span>
          </div>
          <div class="val-col">{{ modbusCrc.hexLittleEndian }}</div>
          <div class="actions-col">
            <button class="btn-action" @click="copyText('crc16_le', modbusCrc.hexLittleEndian)">
              {{ copiedIndex === 'crc16_le' ? '已复制' : '复制' }}
            </button>
            <button class="btn-action btn-append" @click="appendToSend(modbusCrc.hexLittleEndian)">
              附加
            </button>
          </div>
        </div>

        <!-- CRC32 -->
        <div class="result-row">
          <div class="name-col">
            <span class="algo-name">CRC32</span>
            <span class="algo-sub">(IEEE 802.3)</span>
          </div>
          <div class="val-col">{{ crc32Val.hex }}</div>
          <div class="actions-col">
            <button class="btn-action" @click="copyText('crc32', crc32Val.hex)">
              {{ copiedIndex === 'crc32' ? '已复制' : '复制' }}
            </button>
            <button class="btn-action btn-append" @click="appendToSend(crc32Val.hex)">
              附加
            </button>
          </div>
        </div>

        <!-- 和校验 Sum8 -->
        <div class="result-row">
          <div class="name-col">
            <span class="algo-name">和校验 (Sum8)</span>
            <span class="algo-sub">(0xFF 取模)</span>
          </div>
          <div class="val-col">{{ sum8Val.hex }}</div>
          <div class="actions-col">
            <button class="btn-action" @click="copyText('sum8', sum8Val.hex)">
              {{ copiedIndex === 'sum8' ? '已复制' : '复制' }}
            </button>
            <button class="btn-action btn-append" @click="appendToSend(sum8Val.hex)">
              附加
            </button>
          </div>
        </div>

        <!-- 异或校验 XOR8 -->
        <div class="result-row">
          <div class="name-col">
            <span class="algo-name">异或校验 (XOR8)</span>
            <span class="algo-sub">(逐字节异或)</span>
          </div>
          <div class="val-col">{{ xor8Val.hex }}</div>
          <div class="actions-col">
            <button class="btn-action" @click="copyText('xor8', xor8Val.hex)">
              {{ copiedIndex === 'xor8' ? '已复制' : '复制' }}
            </button>
            <button class="btn-action btn-append" @click="appendToSend(xor8Val.hex)">
              附加
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.crc-tools-card {
  background-color: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.card-header {
  padding: 8px 12px;
  background-color: rgba(24, 34, 50, 0.6);
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.title-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tool-icon {
  font-size: 13px;
}

.card-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.opt-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
}

.card-body {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.data-input {
  width: 100%;
  background-color: rgba(11, 15, 23, 0.6);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 5px 8px;
  font-size: 11px;
  color: var(--text-primary);
  outline: none;
}

.data-input:focus {
  border-color: var(--accent-cyan);
}

.results-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.result-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px;
  background-color: rgba(11, 15, 23, 0.4);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  font-size: 11px;
}

.name-col {
  display: flex;
  flex-direction: column;
  min-width: 110px;
}

.algo-name {
  color: var(--text-primary);
  font-weight: 500;
}

.algo-sub {
  font-size: 9px;
  color: var(--text-muted);
}

.val-col {
  font-weight: 600;
  color: var(--accent-cyan);
  flex: 1;
  text-align: center;
}

.actions-col {
  display: flex;
  gap: 4px;
}

.btn-action {
  padding: 2px 6px;
  font-size: 10px;
  background-color: var(--bg-panel);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}

.btn-action:hover {
  background-color: var(--bg-card-hover);
  color: var(--text-primary);
}

.btn-append {
  border-color: rgba(14, 165, 233, 0.3);
  color: var(--accent-cyan);
}

.btn-append:hover {
  background-color: rgba(14, 165, 233, 0.15);
}

.font-mono {
  font-family: var(--font-mono);
}
</style>
