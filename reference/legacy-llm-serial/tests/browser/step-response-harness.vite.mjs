import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
const history = new Map();
const json = (response, status, value) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.end(JSON.stringify(value)); };
const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), plugins: [vue(), {
  name: 'local-step-fixture', configureServer(vite) { vite.middlewares.use(async (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1:5195');
    if (url.pathname === '/fixture-ai/history' && request.method === 'GET') { json(response, 200, history.get(url.searchParams.get('model')) ?? []); return; }
    if (url.pathname !== '/fixture-ai/v1/chat/completions') { next(); return; }
    try {
      if (request.method !== 'POST') throw new Error('POST required');
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 65_536) throw new Error('Fixture request exceeds 64 KiB'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof body.model !== 'string' || !body.model.startsWith('fixture-step-')) throw new Error('Synthetic model required');
      const state = JSON.parse(body.messages.find(message => message.role === 'user').content);
      if (!state.evidence?.telemetryWindow?.sessionId?.startsWith('step-fixture-')) throw new Error('Synthetic session required');
      const records = history.get(body.model) ?? []; records.push(state); history.set(body.model, records);
      json(response, 200, { choices: [{ message: { content: JSON.stringify({ canRecommend: true, params: { kp: 2.2, ki: .55, kd: 0 }, rationale: '本地合成候选，仅测试已验证窗口的请求与未下发状态。' }) } }] });
    } catch (error) { json(response, 400, { error: String(error) }); }
  }); },
}], clearScreen: false, server: { host: '127.0.0.1', port: 5195, strictPort: true, hmr: false, watch: { ignored: ['**/output/**', '**/release/**', '**/data/**', '**/src-tauri/**', '**/dist/**'] } } });
await server.listen();
console.log('Actual TuningWorkbench synthetic step fixture: http://127.0.0.1:5195/tests/browser/step-response-harness.html');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
