import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const histories = new Map();
const sendJson = (response, status, value) => {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(value));
};

const server = await createServer({
  configFile: false, root, plugins: [vue(), {
    name: 'synthetic-tuning-ai',
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1:5191');
        if (url.pathname === '/fixture-ai/history' && request.method === 'GET') {
          sendJson(response, 200, histories.get(url.searchParams.get('model')) ?? []);
          return;
        }
        if (url.pathname !== '/fixture-ai/v1/chat/completions') { next(); return; }
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'POST required' }); return; }
        try {
          const chunks = [];
          let length = 0;
          for await (const chunk of request) {
            length += chunk.length;
            if (length > 65_536) throw new Error('synthetic request exceeds 64 KiB');
            chunks.push(chunk);
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof body.model !== 'string' || !body.model.startsWith('fixture-')) throw new Error('synthetic model required');
          const user = body.messages?.find(message => message.role === 'user')?.content;
          const state = JSON.parse(user);
          if (body.model.startsWith('fixture-model-stop-reenter-')) {
            const history = histories.get(body.model) ?? [];
            history.push(state); histories.set(body.model, history);
            if (typeof state.description !== 'string') throw new Error('Synthetic model description required');
            sendJson(response, 200, { choices: [{ message: { content: JSON.stringify({ canModel: true,
              title: `合成模型草稿 ${history.length}`, numerator: ['1'], denominator: ['1', '1'], tau: '0', physicalFields: [],
              assumptions: ['合成本地响应，只验证取消与操作身份。'], explanation: '合成输入输出关系，未验证设备。' }) } }] });
            return;
          }
          const evidence = state.evidence;
          if (!evidence?.params || !evidence.measured || !evidence.telemetryWindow?.sessionId?.startsWith('fixture-')) {
            throw new Error('current synthetic telemetry evidence required');
          }
          const history = histories.get(body.model) ?? [];
          history.push(state);
          histories.set(body.model, history);
          const params = { kp: evidence.params.kp * 1.1, ki: evidence.params.ki * 1.1, kd: 0 };
          sendJson(response, 200, {
            id: `fixture-response-${history.length}`, object: 'chat.completion', model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({
              canRecommend: true, params,
              rationale: `合成候选 ${history.length}：仅引用 ${evidence.telemetryWindow.source} 的当前参数和 ${evidence.measured.sampleCount} 点遥测；不代表硬件验证。`,
            }) }, finish_reason: 'stop' }],
          });
        } catch (error) { sendJson(response, 400, { error: String(error) }); }
      });
    },
  }], clearScreen: false,
  server: { host: '127.0.0.1', port: 5191, strictPort: true, hmr: false,
    watch: { ignored: ['**/src-tauri/**', '**/output/**', '**/release/**', '**/data/**', '**/dist/**'] } },
});
await server.listen();
console.log('Synthetic Vue tuning fixture: http://127.0.0.1:5191/tests/browser/tuning-harness.html');
console.log('Local strict-schema AI response only; no native serial or hardware acceptance.');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
