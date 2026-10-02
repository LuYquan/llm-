<script setup lang="ts">
import { ref, watch } from 'vue';
import type { CanvasWidgetInstance } from '../../types/widget';
import { globalChannelStore } from '../../core/channel/ChannelStore';
import VariableBindingSelector from './VariableBindingSelector.vue';
import { normalizeChannelId } from '../../utils/channelHelpers';

const props = defineProps<{
  isOpen: boolean;
  widget: CanvasWidgetInstance | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'save', updated: CanvasWidgetInstance): void;
}>();

// 复制一份本地临时配置进行修改
const localWidget = ref<CanvasWidgetInstance | null>(null);
const errorMessage = ref('');

// 实时可用通道列表
const availableChannels = ref<string[]>([]);

watch(
  () => [props.isOpen, props.widget],
  () => {
    if (props.isOpen && props.widget) {
      const clonedWidget = JSON.parse(JSON.stringify(props.widget)) as CanvasWidgetInstance;
      localWidget.value = clonedWidget;
      if (['button', 'slider', 'knob'].includes(clonedWidget.type)) {
        const control = clonedWidget.config as { enabled?: boolean };
        // Existing user-authored controls predate the explicit enable flag;
        // preserve their behavior while new unbound controls stay disabled.
        if (control.enabled === undefined) control.enabled = true;
      }
      errorMessage.value = '';
      availableChannels.value = globalChannelStore.listChannels();
    } else {
      localWidget.value = null;
    }
  },
  { immediate: true }
);

// 预设 Claude 人文温润工程调色板
const PRESET_COLORS = ['#DA7756', '#7AA89B', '#759CB5', '#E59E38', '#9D6CF0', '#E06D85', '#5EA880', '#4F85A6'];

// Chart 曲线操作
function addSeries() {
  if (!localWidget.value || localWidget.value.type !== 'chart') return;
  const cfg = localWidget.value.config;
  if (!Array.isArray(cfg.series)) {
    cfg.series = [];
  }
  if (cfg.series.length >= 8) {
    errorMessage.value = '单图表最多支持 8 条曲线';
    return;
  }
  const nextColor = PRESET_COLORS[cfg.series.length % PRESET_COLORS.length];
  const usedChannels = new Set(cfg.series.map((s: any) => normalizeChannelId(s.channel)));
  let nextChannel = `!${cfg.series.length}`;
  for (let i = 0; i < 8; i++) {
    const candidate = `!${i}`;
    if (!usedChannels.has(candidate)) {
      nextChannel = candidate;
      break;
    }
  }
  cfg.series.push({
    channel: nextChannel,
    color: nextColor,
    visible: true,
  });
}

function removeSeries(idx: number) {
  if (!localWidget.value || localWidget.value.type !== 'chart') return;
  const cfg = localWidget.value.config;
  if (cfg.series.length <= 1) {
    errorMessage.value = '图表至少需要保留 1 条曲线';
    return;
  }
  cfg.series.splice(idx, 1);
}

// 校验与保存
function handleSave() {
  if (!localWidget.value) return;
  errorMessage.value = '';

  const w = localWidget.value;
  if (!w.title || !w.title.trim()) {
    errorMessage.value = '控件标题不能为空';
    return;
  }

  // 针对不同类型的具体校验
  if (w.type === 'gauge') {
    if (w.config.min >= w.config.max) {
      errorMessage.value = '量程下限 (min) 必须小于上限 (max)';
      return;
    }
    if (w.config.redline_ratio < 0 || w.config.redline_ratio > 1) {
      errorMessage.value = '红线比例必须在 0.0 ~ 1.0 之间';
      return;
    }
  } else if (w.type === 'slider' || w.type === 'knob') {
    if (w.config.min >= w.config.max) {
      errorMessage.value = '最小值 (min) 必须小于最大值 (max)';
      return;
    }
    if (w.config.step <= 0) {
      errorMessage.value = '步长 (step) 必须大于 0';
      return;
    }
    const tpl = w.config.command_template || '';
    if (w.config.enabled !== false && !tpl.includes('{val}') && !tpl.includes('{value}')) {
      errorMessage.value = '指令模板中必须包含 {val} 或 {value} 占位符';
      return;
    }
  } else if (w.type === 'button') {
    if (w.config.enabled !== false && !w.config.command_template?.trim() && w.config.mode !== 'jog') {
      errorMessage.value = '下发指令内容不能为空';
      return;
    }
    if (w.config.enabled !== false && w.config.mode === 'jog' && !w.config.press_command?.trim() && !w.config.command_template?.trim()) {
      errorMessage.value = '启用点动控件时必须配置按下指令';
      return;
    }
    if (w.config.encoding === 'hex') {
      const tokens = w.config.command_template.trim().split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        if (!/^[0-9A-Fa-f]{2}$/.test(token)) {
          errorMessage.value = `HEX 模式下每个字节必须为两位十六进制 (如 AA 01)，非法字节: "${token}"`;
          return;
        }
      }
    }
  } else if (w.type === 'chart') {
    if (w.config.series.length === 0) {
      errorMessage.value = '请至少添加一条数据通道曲线';
      return;
    }
    if (w.config.y_mode === 'manual' && w.config.y_min >= w.config.y_max) {
      errorMessage.value = '手动 Y 轴模式下，下限必须小于上限';
      return;
    }
  }

  emit('save', localWidget.value);
  emit('close');
}
</script>

<template>
  <div class="modal-backdrop" v-if="isOpen && localWidget" @click.self="emit('close')">
    <div class="modal-dialog">
      <!-- 弹窗标题 -->
      <div class="modal-header">
        <div class="header-title">
          <span class="icon">⚙️</span>
          <span>配置控件：{{ localWidget.title }}</span>
          <span class="type-tag">{{ localWidget.type }}</span>
        </div>
        <button class="btn-close" @click="emit('close')">✕</button>
      </div>


      <!-- 弹窗表单主体 -->
      <div class="modal-body" v-if="localWidget">
        <!-- 通用设置 -->
        <div class="form-section">
          <div class="section-title">通用属性</div>
          <div class="form-row">
            <label class="form-label">控件标题</label>
            <input type="text" class="form-input" v-model="localWidget.title" />
          </div>
        </div>

        <!-- 1. 指针仪表盘表单 -->
        <div class="form-section" v-if="localWidget.type === 'gauge'">
          <div class="section-title">仪表盘属性</div>
          <div class="form-row">
            <label class="form-label">绑定通道</label>
            <VariableBindingSelector
              v-model="localWidget.config.channel"
              placeholder="请选择绑定通道"
            />
          </div>

          <div class="form-grid-2">
            <div class="form-row">
              <label class="form-label">量程下限 (Min)</label>
              <input type="number" step="any" class="form-input font-mono" v-model.number="localWidget.config.min" />
            </div>
            <div class="form-row">
              <label class="form-label">量程上限 (Max)</label>
              <input type="number" step="any" class="form-input font-mono" v-model.number="localWidget.config.max" />
            </div>
          </div>

          <div class="form-grid-3">
            <div class="form-row">
              <label class="form-label">物理单位</label>
              <input type="text" class="form-input" placeholder="如 rpm" v-model="localWidget.config.unit" />
            </div>
            <div class="form-row">
              <label class="form-label">读数精度</label>
              <input type="number" min="0" max="4" class="form-input font-mono" v-model.number="localWidget.config.precision" />
            </div>
            <div class="form-row">
              <label class="form-label">红线比例</label>
              <input type="number" min="0" max="1" step="0.05" class="form-input font-mono" v-model.number="localWidget.config.redline_ratio" />
            </div>
          </div>
        </div>

        <!-- 2. 实时波形曲线图表单 -->
        <div class="form-section" v-else-if="localWidget.type === 'chart'">
          <div class="section-title flex-between">
            <span>曲线通道列表 (最多 8 条)</span>
            <button class="btn-sm-action" @click="addSeries">+ 添加曲线</button>
          </div>

          <div class="series-list">
            <div
              class="series-item"
              v-for="(s, idx) in localWidget.config.series"
              :key="idx"
            >
              <input type="checkbox" v-model="s.visible" title="是否可见" />
              <div class="flex-1 min-w-0">
                <VariableBindingSelector
                  v-model="s.channel"
                  placeholder="选择通道"
                  size="sm"
                  :allow-clear="false"
                />
              </div>
              <input type="color" class="color-picker" v-model="s.color" title="选择曲线颜色" />
              <button class="btn-del-series" @click="removeSeries(idx)" title="删除曲线">✕</button>
            </div>
          </div>

          <div class="section-title" style="margin-top: 12px;">坐标轴与阶跃绑定</div>
          <div class="form-grid-2">
            <div class="form-row">
              <label class="form-label">时间窗口 (秒)</label>
              <input type="number" min="1" max="60" class="form-input font-mono" v-model.number="localWidget.config.time_window" />
            </div>
            <div class="form-row">
              <label class="form-label">Y 轴缩放模式</label>
              <select class="form-select" v-model="localWidget.config.y_mode">
                <option value="auto">自适应缩放 (Auto)</option>
                <option value="manual">手动固定量程 (Manual)</option>
              </select>
            </div>
          </div>

          <div class="form-grid-2" v-if="localWidget.config.y_mode === 'manual'">
            <div class="form-row">
              <label class="form-label">Y 轴下限 (y_min)</label>
              <input type="number" step="any" class="form-input font-mono" v-model.number="localWidget.config.y_min" />
            </div>
            <div class="form-row">
              <label class="form-label">Y 轴上限 (y_max)</label>
              <input type="number" step="any" class="form-input font-mono" v-model.number="localWidget.config.y_max" />
            </div>
          </div>

          <div class="form-grid-2" style="margin-top: 6px;">
            <div class="form-row">
              <label class="form-label">阶跃响应目标通道</label>
              <VariableBindingSelector
                v-model="localWidget.config.target_channel"
                placeholder="选择目标通道 (可选)"
              />
            </div>
            <div class="form-row">
              <label class="form-label">阶跃响应实际通道</label>
              <VariableBindingSelector
                v-model="localWidget.config.actual_channel"
                placeholder="选择实际响应通道 (可选)"
              />
            </div>
          </div>
        </div>

        <!-- 3. 动作按键表单 -->
        <div class="form-section" v-else-if="localWidget.type === 'button'">
          <div class="section-title">按键与下发指令</div>
          <div class="form-grid-2">
            <div class="form-row">
              <label class="form-label">按钮显示文字</label>
              <input type="text" class="form-input" v-model="localWidget.config.button_text" />
            </div>
            <div class="form-row">
              <label class="form-label">按键模式</label>
              <select class="form-select" v-model="localWidget.config.mode">
                <option value="click">常规点击触发 (Click)</option>
                <option value="jog">点动/寸动模式 (Jog 按下发/松手发)</option>
              </select>
            </div>
          </div>

          <div class="form-row">
            <label class="form-label">编码格式</label>
            <select class="form-select" v-model="localWidget.config.encoding">
              <option value="text">纯文本 (支持 \r \n \t \xHH 转义)</option>
              <option value="hex">HEX 十六进制 (如 AA 01 55)</option>
            </select>
          </div>

          <template v-if="localWidget.config.mode === 'jog'">
            <div class="form-row">
              <label class="form-label">按下指令 (Press Command)</label>
              <textarea
                rows="2"
                class="form-textarea font-mono"
                placeholder="如 JOG_START\n 或 AA 01"
                v-model="localWidget.config.press_command"
              ></textarea>
            </div>
            <div class="form-row">
              <label class="form-label">松开指令 (Release Command)</label>
              <textarea
                rows="2"
                class="form-textarea font-mono"
                placeholder="如 JOG_STOP\n 或 AA 00"
                v-model="localWidget.config.release_command"
              ></textarea>
            </div>
          </template>
          <template v-else>
            <div class="form-row">
              <label class="form-label">指令内容</label>
              <textarea
                rows="2"
                class="form-textarea font-mono"
                placeholder="如 CMD:RST\n 或 AA 55 01"
                v-model="localWidget.config.command_template"
              ></textarea>
            </div>
          </template>

          <div class="form-row checkbox-row">
            <label class="checkbox-label">
              <input type="checkbox" v-model="localWidget.config.enabled" />
              <span>允许下发到设备（仅在已连接、指令确认后启用）</span>
            </label>
          </div>

          <div class="form-row checkbox-row">
            <label class="checkbox-label">
              <input type="checkbox" v-model="localWidget.config.is_danger" />
              <span>标记为危险动作（点击后立即弹出二次确认，倒计时 1s 后才可执行）</span>
            </label>
          </div>
        </div>

        <!-- 4. 滑块调参器表单 -->
        <div class="form-section" v-else-if="localWidget.type === 'slider'">
          <div class="section-title">滑块参数与模板</div>
          <div class="form-row">
            <label class="form-label">指令模板 (支持 {val} 或 {value})</label>
            <input
              type="text"
              class="form-input font-mono"
              placeholder="如 SET_KP {val}\n"
              v-model="localWidget.config.command_template"
            />
          </div>

          <div class="form-row">
            <label class="form-label">反馈回显通道 (可选，实现 VOFA+ 闭环反馈)</label>
            <VariableBindingSelector
              v-model="localWidget.config.feedback_channel"
              placeholder="请选择反馈回显通道 (可选)"
            />
          </div>

          <div class="form-row checkbox-row">
            <label class="checkbox-label">
              <input type="checkbox" v-model="localWidget.config.enabled" />
              <span>允许下发到设备（默认关闭，先完成模板和边界审核）</span>
            </label>
          </div>

          <div class="form-grid-2">
            <div class="form-row">
              <label class="form-label">最小值 (Min)</label>
              <input type="number" step="any" class="form-input font-mono" v-model.number="localWidget.config.min" />
            </div>
            <div class="form-row">
              <label class="form-label">最大值 (Max)</label>
              <input type="number" step="any" class="form-input font-mono" v-model.number="localWidget.config.max" />
            </div>
          </div>

          <div class="form-grid-3">
            <div class="form-row">
              <label class="form-label">步长 (Step)</label>
              <input type="number" min="0.001" step="any" class="form-input font-mono" v-model.number="localWidget.config.step" />
            </div>
            <div class="form-row">
              <label class="form-label">读数精度</label>
              <input type="number" min="0" max="4" class="form-input font-mono" v-model.number="localWidget.config.precision" />
            </div>
            <div class="form-row">
              <label class="form-label">物理单位</label>
              <input type="text" class="form-input" placeholder="如 rpm" v-model="localWidget.config.unit" />
            </div>
          </div>

          <div class="form-grid-2">
            <div class="form-row">
              <label class="form-label">初始默认值</label>
              <input type="number" step="any" class="form-input font-mono" v-model.number="localWidget.config.default_value" />
            </div>
            <div class="form-row">
              <label class="form-label">下发策略</label>
              <select class="form-select" v-model="localWidget.config.send_mode">
                <option value="change">松手后下发 (推荐)</option>
                <option value="input">连续拖拽高频节流下发</option>
              </select>
            </div>
          </div>
        </div>

        <!-- 5. 数值框表单 -->
        <div class="form-section" v-else-if="localWidget.type === 'number'">
          <div class="section-title">数值显示属性</div>
          <div class="form-row">
            <label class="form-label">绑定通道</label>
            <VariableBindingSelector
              v-model="localWidget.config.channel"
              placeholder="请选择绑定通道"
            />
          </div>
          <div class="form-grid-3">
            <div class="form-row">
              <label class="form-label">前缀标签</label>
              <input type="text" class="form-input" v-model="localWidget.config.prefix" />
            </div>
            <div class="form-row">
              <label class="form-label">读数精度</label>
              <input type="number" min="0" max="6" class="form-input font-mono" v-model.number="localWidget.config.precision" />
            </div>
            <div class="form-row">
              <label class="form-label">单位</label>
              <input type="text" class="form-input" v-model="localWidget.config.unit" />
            </div>
          </div>
          <div class="form-grid-2">
            <div class="form-row">
              <label class="form-label">报警下限 (可选)</label>
              <input type="number" step="any" class="form-input font-mono" v-model.number="localWidget.config.min" />
            </div>
            <div class="form-row">
              <label class="form-label">报警上限 (可选)</label>
              <input type="number" step="any" class="form-input font-mono" v-model.number="localWidget.config.max" />
            </div>
          </div>
        </div>

        <!-- 6. LED 状态灯表单 -->
        <div class="form-section" v-else-if="localWidget.type === 'led'">
          <div class="section-title">指示灯属性</div>
          <div class="form-grid-2">
            <div class="form-row">
              <label class="form-label">绑定通道</label>
              <VariableBindingSelector
                v-model="localWidget.config.channel"
                placeholder="请选择绑定通道"
              />
            </div>
            <div class="form-row">
              <label class="form-label">显示标签</label>
              <input type="text" class="form-input" v-model="localWidget.config.label" />
            </div>
          </div>
          <div class="form-grid-2">
            <div class="form-row">
              <label class="form-label">指示灯模式</label>
              <select class="form-select" v-model="localWidget.config.condition_mode">
                <option value="two_state">二态开关模式 (Normal / Off)</option>
                <option value="three_zone">三色区间报警模式 (绿正常/黄预警/红报警)</option>
              </select>
            </div>
            <div class="form-row" v-if="localWidget.config.condition_mode !== 'three_zone'">
              <label class="form-label">点亮判据</label>
              <select class="form-select" v-model="localWidget.config.active_condition">
                <option value="positive">正数点亮 (v > 0)</option>
                <option value="non_zero">非零点亮 (v != 0)</option>
                <option value="threshold">达到门限阈值点亮</option>
              </select>
            </div>
          </div>
          <div class="form-grid-2" v-if="localWidget.config.condition_mode === 'three_zone'">
            <div class="form-row">
              <label class="form-label">预警门限 (Yellow Threshold)</label>
              <input type="number" step="any" class="form-input font-mono" v-model.number="localWidget.config.warning_threshold" />
            </div>
            <div class="form-row">
              <label class="form-label">报警门限 (Red Threshold)</label>
              <input type="number" step="any" class="form-input font-mono" v-model.number="localWidget.config.threshold" />
            </div>
          </div>
          <div class="form-row" v-else-if="localWidget.config.active_condition === 'threshold'">
            <label class="form-label">门限阈值</label>
            <input type="number" step="any" class="form-input font-mono" v-model.number="localWidget.config.threshold" />
          </div>
          <div class="form-grid-2">
            <div class="form-row">
              <label class="form-label">点亮/正常颜色</label>
              <input type="color" class="color-picker" v-model="localWidget.config.color_on" />
            </div>
            <div class="form-row">
              <label class="form-label">形状</label>
              <select class="form-select" v-model="localWidget.config.shape">
                <option value="circle">圆形</option>
                <option value="rect">矩形胶囊</option>
              </select>
            </div>
          </div>
        </div>

        <!-- 7. 旋钮调参器表单 -->
        <div class="form-section" v-else-if="localWidget.type === 'knob'">
          <div class="section-title">旋钮参数与模板</div>
          <div class="form-row">
            <label class="form-label">指令模板 (包含 {val})</label>
            <input type="text" class="form-input font-mono" placeholder="如 SET_SPD {val}\n" v-model="localWidget.config.command_template" />
          </div>
          <div class="form-row">
            <label class="form-label">反馈回显通道 (可选，实现 VOFA+ 闭环反馈)</label>
            <VariableBindingSelector
              v-model="localWidget.config.feedback_channel"
              placeholder="请选择反馈回显通道 (可选)"
            />
          </div>

          <div class="form-row checkbox-row">
            <label class="checkbox-label">
              <input type="checkbox" v-model="localWidget.config.enabled" />
              <span>允许下发到设备（默认关闭，先完成模板和边界审核）</span>
            </label>
          </div>
          <div class="form-grid-2">
            <div class="form-row">
              <label class="form-label">最小值 (Min)</label>
              <input type="number" step="any" class="form-input font-mono" v-model.number="localWidget.config.min" />
            </div>
            <div class="form-row">
              <label class="form-label">最大值 (Max)</label>
              <input type="number" step="any" class="form-input font-mono" v-model.number="localWidget.config.max" />
            </div>
          </div>
          <div class="form-grid-3">
            <div class="form-row">
              <label class="form-label">步长 (Step)</label>
              <input type="number" min="0.01" step="any" class="form-input font-mono" v-model.number="localWidget.config.step" />
            </div>
            <div class="form-row">
              <label class="form-label">单位</label>
              <input type="text" class="form-input" v-model="localWidget.config.unit" />
            </div>
            <div class="form-row">
              <label class="form-label">默认值</label>
              <input type="number" step="any" class="form-input font-mono" v-model.number="localWidget.config.default_value" />
            </div>
          </div>
        </div>

        <!-- 8. 统计卡片表单 -->
        <div class="form-section" v-else-if="localWidget.type === 'stat_card'">
          <div class="section-title">统计属性</div>
          <div class="form-row">
            <label class="form-label">绑定通道</label>
            <VariableBindingSelector
              v-model="localWidget.config.channel"
              placeholder="请选择绑定通道"
            />
          </div>
          <div class="form-row">
            <label class="form-label">统计时间窗口 (秒)</label>
            <input type="number" min="1" max="60" class="form-input font-mono" v-model.number="localWidget.config.time_window" />
          </div>
        </div>

        <!-- 9. 阶跃指标卡表单 -->
        <div class="form-section" v-else-if="localWidget.type === 'step_card'">
          <div class="section-title">阶跃分析通道绑定</div>
          <div class="form-grid-2">
            <div class="form-row">
              <label class="form-label">响应通道 (Actual)</label>
              <VariableBindingSelector
                v-model="localWidget.config.actual_channel"
                placeholder="请选择响应通道 (Actual)"
              />
            </div>
            <div class="form-row">
              <label class="form-label">目标通道 (Target)</label>
              <VariableBindingSelector
                v-model="localWidget.config.target_channel"
                placeholder="请选择目标通道 (Target)"
              />
            </div>
          </div>
          <div class="form-grid-2">
            <div class="form-row">
              <label class="form-label">时间窗口 (秒)</label>
              <input type="number" min="2" max="60" class="form-input font-mono" v-model.number="localWidget.config.time_window" />
            </div>
            <div class="form-row">
              <label class="form-label">误差带比例 (如 0.02 为 ±2%)</label>
              <input type="number" min="0.005" max="0.1" step="0.005" class="form-input font-mono" v-model.number="localWidget.config.band_percent" />
            </div>
          </div>
        </div>

        <!-- 10. 波特图分析仪表单 -->
        <div class="form-section" v-else-if="localWidget.type === 'bode'">
          <div class="section-title">波特图属性与环路绑定</div>
          <div class="form-row">
            <label class="form-label">绑定的控制环路 ID (留空默认使用当前激活环路)</label>
            <input type="text" class="form-input font-mono" v-model="localWidget.config.loop_id" placeholder="如 speed / current / position" />
          </div>
          <div class="form-grid-2">
            <div class="form-row">
              <label class="form-label">展示稳定性与相位裕度徽标</label>
              <select class="form-select" v-model="localWidget.config.show_stability_margins">
                <option :value="true">是 (显示 γ 和 ωc)</option>
                <option :value="false">否</option>
              </select>
            </div>
            <div class="form-row">
              <label class="form-label">展示 ZOH 延时相角损失曲线</label>
              <select class="form-select" v-model="localWidget.config.show_delay_loss">
                <option :value="true">是 (红虚线)</option>
                <option :value="false">否</option>
              </select>
            </div>
          </div>
          <div class="form-grid-2">
            <div class="form-row">
              <label class="form-label">频率下限 ω_min (rad/s)</label>
              <input type="number" step="0.1" min="0.01" class="form-input font-mono" v-model.number="localWidget.config.omega_min" />
            </div>
            <div class="form-row">
              <label class="form-label">频率上限 ω_max (rad/s)</label>
              <input type="number" step="10" min="10" class="form-input font-mono" v-model.number="localWidget.config.omega_max" />
            </div>
          </div>
        </div>

        <!-- 错误提示 -->
        <div class="error-banner" v-if="errorMessage">
          ⚠️ {{ errorMessage }}
        </div>
      </div>

      <!-- 弹窗底部操作栏 -->
      <div class="modal-footer">
        <button class="btn-modal-cancel" @click="emit('close')">取消</button>
        <button class="btn-modal-save" @click="handleSave">保存配置</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
}

.modal-dialog {
  width: 540px;
  max-width: 90vw;
  max-height: 85vh;
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 12px;
  box-shadow: var(--card-shadow, 0 16px 36px rgba(0, 0, 0, 0.4));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  height: 44px;
  padding: 0 16px;
  background: var(--bg-elevated, #2F2E2A);
  border-bottom: 1px solid var(--border-subtle, #383633);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-main, #ECEAE4);
}

.type-tag {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
  color: var(--accent-terracotta, #DA7756);
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
}

.btn-close {
  background: transparent;
  border: none;
  color: var(--text-muted, #9E9C94);
  font-size: 14px;
  cursor: pointer;
}

.modal-body {
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-terracotta, #DA7756);
  border-left: 3px solid var(--accent-terracotta, #DA7756);
  padding-left: 6px;
}

.flex-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.form-label {
  font-size: 11px;
  color: var(--text-muted, #9E9C94);
}

.form-input,
.form-select,
.form-textarea {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  border-radius: 4px;
  padding: 6px 10px;
  color: var(--text-main, #ECEAE4);
  font-size: 12px;
  outline: none;
  box-sizing: border-box;
}

.form-input:focus,
.form-select:focus,
.form-textarea:focus {
  border-color: var(--accent-terracotta, #DA7756);
}

.form-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.form-grid-3 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 10px;
}

.series-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 160px;
  overflow-y: auto;
}

.series-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.color-picker {
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}

.btn-sm-action {
  background: var(--accent-terracotta-soft, rgba(218, 119, 86, 0.15));
  color: var(--accent-terracotta, #DA7756);
  border: 1px solid var(--accent-terracotta, #DA7756);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.btn-del-series {
  background: transparent;
  border: none;
  color: #94a3b8;
  cursor: pointer;
}

.btn-del-series:hover {
  color: #f87171;
}

.checkbox-row {
  flex-direction: row;
  align-items: center;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #e2e8f0;
  cursor: pointer;
}

.error-banner {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.4);
  color: #f87171;
  font-size: 12px;
  padding: 8px 12px;
  border-radius: 4px;
}

.modal-footer {
  padding: 10px 16px;
  background: var(--bg-elevated, #2F2E2A);
  border-top: 1px solid var(--border-subtle, #383633);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.btn-modal-cancel {
  background: var(--bg-surface, #272623);
  border: 1px solid var(--border-subtle, #383633);
  color: var(--text-muted, #9E9C94);
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-modal-cancel:hover {
  color: var(--text-main, #ECEAE4);
  background: var(--bg-elevated, #2F2E2A);
}

.btn-modal-save {
  background: var(--accent-terracotta, #DA7756);
  border: 1px solid var(--accent-terracotta, #DA7756);
  color: #fff;
  padding: 6px 16px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-modal-save:hover {
  background: var(--accent-terracotta-hover, #E58565);
  border-color: var(--accent-terracotta-hover, #E58565);
}
</style>
