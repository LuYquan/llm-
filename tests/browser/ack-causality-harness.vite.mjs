import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
const histories = new Map();
const json = (response, status, body) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store'); response.end(JSON.stringify(body)); };
const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), plugins: [vue(), {
  name: 'actual-app-ack-causality', configureServer(vite) { vite.middlewares.use(async (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1:5198');
    if (url.pathname === '/fixture-ai/history' && request.method === 'GET') { json(response, 200, histories.get(url.searchParams.get('model')) ?? []); return; }
    if (url.pathname !== '/fixture-ai/v1/chat/completions') { next(); return; }
    if (request.method !== 'POST') { json(response, 405, { error: 'POST required' }); return; }
    try {
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 65_536) throw new Error('64 KiB limit'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof body.model !== 'string' || !body.model.startsWith('ack-causality-')) throw new Error('Fixture model required');
      const state = JSON.parse(body.messages?.find(value => value.role === 'user')?.content);
      const evidence = state.evidence;
      if (evidence?.project !== 'ACK 因果合成测试对象') throw new Error('Fixture project required');
      if (!evidence?.params || !evidence.measured || !evidence.telemetryWindow?.sessionId?.startsWith('web-session-')) throw new Error('Real current Web Serial window required');
      const history = histories.get(body.model) ?? []; history.push(state); histories.set(body.model, history);
      json(response, 200, { id: `ack-causality-response-${history.length}`, object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ canRecommend: true,
          params: { kp: evidence.params.kp * 1.1, ki: evidence.params.ki * 1.1, kd: 0 }, rationale: '本地合成响应；仅用于验证真实 App 的 ACK 接收顺序。' }) }, finish_reason: 'stop' }] });
    } catch (reason) { json(response, 400, { error: String(reason) }); }
  }); } }], clearScreen: false, server: { host: '127.0.0.1', port: 5198, strictPort: true, hmr: false, watch: { ignored: ['**/src-tauri/**','**/output/**','**/release/**','**/data/**','**/dist/**'] } } });
await server.listen();
console.log('Actual App ACK causality fixture: http://127.0.0.1:5198/tests/browser/ack-causality-harness.html');
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
