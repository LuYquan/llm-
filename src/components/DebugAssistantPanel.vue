<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { requestChatCompletion, prepareLogEvidence, fetchAvailableModels, PROVIDER_DEFAULTS, type AiConfig } from '../services/ai';
import { globalChannelStore } from '../core/channel/ChannelStore';
import { DEBUG_ASSISTANT_PROMPT, parseAssistantReply, summarizeChannel, commandDraftBytes, validateAssistantAction, type AssistantAction, type AssistantReply } from '../core/assistant/debugAssistant';
import type { ProtocolConfig } from '../core/protocol/types';

const props = defineProps<{
  open: boolean; embedded?: boolean; config: AiConfig; logs: { text: string }[]; channels: string[];
  contextLabel: string; protocol: ProtocolConfig;
  configurationVersion: string;
  saveConfig: (config: AiConfig, clearStoredKey?: boolean) => Promise<AiConfig>;
  applyAction: (action: AssistantAction) => Promise<string>;
}>();
const emit = defineEmits<{ (event: 'close'): void }>();
const task = ref('');
const selectedLog = ref('');
const includeRecent = ref(false);
const selectedChannels = ref<string[]>([]);
const reply = ref<AssistantReply | null>(null);
const status = ref('');
const busy = ref(false);
const applying = ref(false);
const applied = ref<number[]>([]);
const showSettings = ref(false);
const settingsBusy = ref(false);
const clearStoredKey = ref(false);
const settingsStatus = ref('');
const models = ref<string[]>([]);
const edit = ref<AiConfig>({ ...props.config, api_key: '' });
let controller: AbortController | null = null;
let requestId = 0;
const replyContext = ref('');
const sentEvidence = ref('');
const observedContext = ref('');
let contextTimer: ReturnType<typeof setInterval> | undefined;

function contextKey() {
  return JSON.stringify([globalChannelStore.getSessionContext(), globalChannelStore.getGeneration(), props.contextLabel,
    props.configurationVersion,
    props.protocol, props.config.provider, props.config.api_url, props.config.model, props.config.api_key_configured, props.config.api_key]);
}
function cancel() { requestId++; controller?.abort(); controller = null; busy.value = false; }
watch(() => props.open, (open) => {
  if (contextTimer) clearInterval(contextTimer);
  contextTimer = undefined;
  if (open) {
    observedContext.value = contextKey();
    contextTimer = setInterval(() => {
      const current = contextKey();
      if (current !== observedContext.value && busy.value) { cancel(); status.value = '会话或配置已变化，请重新审阅证据后分析。'; }
      observedContext.value = current;
    }, 300);
  } else cancel();
}, { immediate: true });
onUnmounted(() => { cancel(); if (contextTimer) clearInterval(contextTimer); });
const stale = computed(() => Boolean(reply.value && replyContext.value !== observedContext.value));

function buildEvidence() {
  const logs = prepareLogEvidence(selectedLog.value, includeRecent.value ? props.logs.slice(-5).map(l => l.text) : []);
  const channels = selectedChannels.value.filter(id => props.channels.includes(id)).slice(0, 8).map(id => {
    const data = globalChannelStore.getRecent(id, 256);
    return summarizeChannel(id, data.timestamps, data.values);
  });
  return { context: props.contextLabel, protocol: props.protocol, selectedLog: logs.primary, recentLogs: logs.context,
    channelSummaries: channels, sampleScope: '每个通道最多最近 256 个显示缓冲样本的统计摘要；不上传原始数组，时间基础未在此验证' };
}
const evidencePreview = computed(() => { void props.logs.length; return JSON.stringify(buildEvidence(), null, 2); });
const prompts = ['帮我定位这段日志的问题，并列出排查步骤', '数据已收到但没有波形，帮我检查协议和绑定', '根据选中的通道生成简洁的显示控件建议'];
async function analyze() {
  if (!task.value.trim() || busy.value) return;
  cancel();
  const id = requestId;
  const key = contextKey();
  const evidence = buildEvidence();
  sentEvidence.value = JSON.stringify({ task: prepareLogEvidence(task.value, []).primary, evidence, requestedAt: new Date().toISOString(), model: props.config.model }, null, 2);
  const currentController = new AbortController(); controller = currentController;
  busy.value = true; status.value = ''; reply.value = null; applied.value = [];
  try {
    const raw = await requestChatCompletion(props.config, DEBUG_ASSISTANT_PROMPT,
      JSON.stringify({ task: prepareLogEvidence(task.value, []).primary, evidence }), { signal: currentController.signal, timeoutMs: 30_000, jsonMode: true });
    if (requestId !== id || key !== contextKey() || !props.open) return;
    reply.value = parseAssistantReply(raw, props.channels);
    replyContext.value = key; observedContext.value = key;
    status.value = '建议已生成，请核对依据后逐项应用。';
  } catch (error) {
    if (requestId === id) status.value = error instanceof Error ? error.message : String(error);
  } finally { if (requestId === id) { busy.value = false; controller = null; } }
}
async function apply(action: AssistantAction, index: number) {
  if (applying.value || applied.value.includes(index)) return;
  if (replyContext.value !== contextKey()) { observedContext.value = contextKey(); status.value = '建议依据已过期，请重新分析。'; return; }
  applying.value = true;
  try {
    const validated = validateAssistantAction(action, props.channels);
    status.value = await props.applyAction(validated);
    applied.value.push(index);
    observedContext.value = contextKey();
  } catch (error) { status.value = error instanceof Error ? error.message : String(error); }
  finally { applying.value = false; }
}
function actionPreview(action: AssistantAction) {
  if (action.type === 'command_draft') {
    const bytes = commandDraftBytes(action);
    return `${action.encoding.toUpperCase()} · ${bytes.length} B · ${action.lineEnding}\n${Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}`;
  }
  return JSON.stringify(action.type === 'protocol' ? action.config : { widget: action.widget, channels: action.channels, unit: action.unit }, null, 2);
}
function openSettings() { cancel(); clearStoredKey.value = false; edit.value = { ...props.config, api_key: '', api_key_configured: props.config.api_key_configured || Boolean(props.config.api_key) }; settingsStatus.value = ''; models.value = []; showSettings.value = true; }
function providerChanged() {
  clearStoredKey.value = false;
  const preset = PROVIDER_DEFAULTS[edit.value.provider];
  edit.value = { ...edit.value, api_url: preset?.url || '', model: '', api_key: '', api_key_configured: false };
  models.value = []; settingsStatus.value = '请选择模型；切换服务需重新配置密钥。';
}
async function saveSettings(loadModels = false) {
  settingsBusy.value = true; settingsStatus.value = '';
  try {
    if (!edit.value.api_url.trim()) throw new Error('请填写服务地址');
    const url = new URL(edit.value.api_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务地址无效或包含凭据/查询参数');
    if (!loadModels && !edit.value.model.trim()) throw new Error('请选择或填写模型名称');
    const config = await props.saveConfig({ ...edit.value }, clearStoredKey.value && !edit.value.api_key);
    clearStoredKey.value = false;
    edit.value = { ...config, api_key: '' };
    if (loadModels) { models.value = await fetchAvailableModels(config); settingsStatus.value = `读取到 ${models.value.length} 个模型，请选择后保存。`; }
    else { settingsStatus.value = '设置已保存。'; showSettings.value = false; status.value = 'AI 设置已保存。'; }
  } catch (error) { settingsStatus.value = error instanceof Error ? error.message : String(error); }
  finally { settingsBusy.value = false; }
}
function prefill(prompt: string, log?: string) {
  task.value = prompt; if (log !== undefined) selectedLog.value = log;
  status.value = '已选择证据。检查内容后点击“分析任务”。';
}
defineExpose({ prefill, openSettings });
</script>

<template>
  <aside v-if="open" class="debug-assistant" :class="{ embedded }" aria-label="AI 调试助手">
    <header v-if="!embedded" class="assistant-header"><div><h2>AI 调试助手</h2><p>{{ contextLabel }}</p></div><button type="button" aria-label="关闭 AI 助手" @click="emit('close')">关闭</button></header>
    <div class="assistant-scroll">
      <div class="provider-row"><span>{{ config.model || '尚未选择模型' }}</span><button type="button" @click="openSettings">AI 设置</button></div>
      <form v-if="showSettings" class="settings" @submit.prevent="saveSettings()">
        <h3>连接 AI 服务</h3>
        <label>服务<select v-model="edit.provider" aria-label="AI 服务" :disabled="settingsBusy" @change="providerChanged"><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option><option value="ollama">Ollama · 本机</option><option value="custom">兼容服务</option></select></label>
        <label>API Key <small>{{ edit.api_key_configured ? '已配置，留空保留' : edit.provider === 'ollama' ? '本机服务通常无需填写' : '服务商提供的密钥' }}</small><input v-model="edit.api_key" type="password" autocomplete="off" :disabled="settingsBusy" /></label>
        <button v-if="edit.api_key_configured" type="button" :disabled="settingsBusy" @click="edit.api_key = ''; edit.api_key_configured = false; clearStoredKey = true; settingsStatus = '保存后清除密钥。需要密钥的服务将暂停请求，直到重新配置密钥。'">清除已保存密钥</button>
        <label>模型<input v-model="edit.model" aria-label="AI 模型" list="assistant-models" placeholder="填写名称或从服务读取" :disabled="settingsBusy" /><datalist id="assistant-models"><option v-for="model in models" :key="model" :value="model" /></datalist></label>
        <details :open="edit.provider === 'custom'"><summary>服务地址</summary><label>API 地址<input v-model="edit.api_url" type="url" :disabled="settingsBusy" /></label></details>
        <p>桌面密钥使用系统保护存储；网页密钥仅用于当前会话。</p>
        <p v-if="settingsStatus" role="status">{{ settingsStatus }}</p>
        <div class="settings-actions"><button type="button" :disabled="settingsBusy" @click="saveSettings(true)">读取模型</button><button type="button" :disabled="settingsBusy" @click="showSettings = false">取消</button><button type="submit" class="primary" :disabled="settingsBusy">{{ settingsBusy ? '处理中…' : '保存' }}</button></div>
      </form>
      <template v-else>
        <div v-if="!reply" class="task-start"><h3>这次需要解决什么？</h3><p>选择相关日志或通道。助手会解释问题，并提出可审阅的下一步。</p><button v-for="prompt in prompts" :key="prompt" type="button" :disabled="busy" @click="task = prompt">{{ prompt }}</button></div>
        <label class="field">任务<textarea v-model="task" rows="3" maxlength="2048" placeholder="例如：日志里连续出现校验错误，应从哪里排查？" :disabled="busy" /></label>
        <details class="evidence" open><summary>选择证据</summary><label class="field">选中日志<textarea v-model="selectedLog" rows="2" maxlength="2048" placeholder="可从终端点击一行的 AI 按钮，或粘贴相关日志" :disabled="busy" /></label><label class="check"><input v-model="includeRecent" type="checkbox" :disabled="busy" />附加最近 5 条日志</label>
          <fieldset><legend>通道摘要 · 最多 8 个</legend><p v-if="!channels.length">当前没有已接收通道。</p><label v-for="channel in channels" :key="channel" class="check"><input v-model="selectedChannels" type="checkbox" :value="channel" :disabled="busy || (!selectedChannels.includes(channel) && selectedChannels.length >= 8)" />{{ channel }}</label></fieldset>
          <details><summary>查看发送内容</summary><pre>{{ evidencePreview }}</pre></details>
          <p class="scope-note">仅发送上述任务、协议配置和所选摘要。常见凭据会脱敏，请检查发送内容。不会自动上传完整日志或原始波形。</p>
        </details>
        <div class="run-actions"><button v-if="busy" type="button" @click="cancel(); status = '已取消分析。'">取消分析</button><button v-else type="button" class="primary" :disabled="!task.trim()" @click="analyze">分析任务</button></div>
        <p v-if="status" class="result-status" role="status">{{ status }}</p>
        <p v-if="stale" class="warning">会话或配置已变化，以下建议只能查看，请重新分析后应用。</p>
        <section v-if="reply" class="reply"><h3>分析与下一步</h3><details><summary>本轮发送依据</summary><pre>{{ sentEvidence }}</pre></details><div class="prose">{{ reply.explanation }}</div><ul v-if="reply.uncertainties.length"><li v-for="note in reply.uncertainties" :key="note">{{ note }}</li></ul>
          <article v-for="(action, index) in reply.actions" :key="index" class="proposal"><h4>{{ action.title }}</h4><pre>{{ actionPreview(action) }}</pre><p v-if="action.type === 'command_draft'" class="scope-note">仅填入发送草稿。最终字节和发送动作仍需在终端核对。</p><p v-if="action.type === 'protocol'" class="scope-note">确认后切换解析协议并清除旧解析残留。</p><button type="button" :disabled="stale || applying || applied.includes(index)" @click="apply(action, index)">{{ applied.includes(index) ? '已应用' : action.type === 'command_draft' ? '确认填入草稿' : action.type === 'display_widget' ? '确认添加显示控件' : '确认应用协议' }}</button></article>
          <p v-for="reason in reply.rejected" :key="reason" class="warning">已拦截建议：{{ reason }}</p>
        </section>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.debug-assistant { position:absolute; right:0; top:0; bottom:0; width:min(420px,100%); z-index:60; display:flex; flex-direction:column; color:var(--text-main); background:var(--bg-surface); border-left:1px solid var(--border-strong); box-shadow:-8px 0 24px #0002; font-size:13px; }
.debug-assistant.embedded { position:relative; inset:auto; width:100%; flex:1; min-height:0; border:0; box-shadow:none; }
.assistant-header { padding:16px; display:flex; justify-content:space-between; gap:12px; border-bottom:1px solid var(--border-subtle); }
h2 { font-size:16px; margin:0 0 5px; font-weight:600; } h3 { font-size:14px; margin:0 0 8px; } h4 { margin:0 0 8px; font-size:13px; }
p { margin:6px 0; color:var(--text-muted); line-height:1.6; } .assistant-header p { font-size:12px; margin:0; }
.assistant-scroll { flex:1; min-height:0; overflow:auto; padding:16px; display:flex; flex-direction:column; gap:16px; }
button,input,textarea,select { font:inherit; color:var(--text-main); border:1px solid var(--border-strong); border-radius:5px; background:var(--bg-base); } button { min-height:32px; padding:5px 10px; cursor:pointer; } button:hover:not(:disabled) { background:var(--bg-elevated); } button:disabled { opacity:.5; cursor:not-allowed; } .primary { background:var(--accent-action); color:#fff; border-color:transparent; }.primary:hover:not(:disabled) { background:var(--accent-terracotta); }
.provider-row,.run-actions,.settings-actions { display:flex; align-items:center; gap:8px; justify-content:space-between; } .provider-row span { overflow-wrap:anywhere; color:var(--text-muted); font-size:12px; }
.task-start button { display:block; text-align:left; width:100%; margin-top:8px; } .field,.settings label { display:flex; flex-direction:column; gap:6px; } input:not([type=checkbox]),select,textarea { width:100%; min-height:34px; padding:8px; box-sizing:border-box; } textarea { resize:vertical; line-height:1.6; }
summary { cursor:pointer; min-height:28px; line-height:28px; font-weight:550; } .evidence { border-top:1px solid var(--border-subtle); padding-top:8px; } .evidence .field { margin:8px 0; } .check { display:flex; align-items:center; gap:8px; padding:4px 0; overflow-wrap:anywhere; } input[type=checkbox] { accent-color:var(--accent-action); } fieldset { margin:12px 0; padding:8px 12px; border:1px solid var(--border-subtle); border-radius:5px; max-height:170px; overflow:auto; } legend { font-size:12px; color:var(--text-muted); }
pre { margin:8px 0; padding:10px; background:var(--bg-base); border:1px solid var(--border-subtle); font:11px/1.6 var(--font-mono); white-space:pre-wrap; overflow-wrap:anywhere; max-height:220px; overflow:auto; } .scope-note,small { font-size:12px; color:var(--text-muted); } .result-status { margin:0; } .prose { white-space:pre-wrap; line-height:1.75; overflow-wrap:anywhere; } .reply li { margin:6px 0; color:var(--text-muted); line-height:1.6; }.proposal { margin-top:16px; padding-top:12px; border-top:1px solid var(--border-subtle); }.warning { color:var(--accent-amber); }.settings { display:flex; flex-direction:column; gap:14px; }.settings small { font-weight:400; }
</style>
