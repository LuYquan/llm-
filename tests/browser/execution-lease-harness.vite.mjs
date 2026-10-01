import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

const models = new Map();
const modelState = model => { if (!models.has(model)) models.set(model, { requests: [], events: [], held: new Map(), nextMode: null }); return models.get(model); };
const record = (state, event, detail) => state.events.push({ at: Date.now(), event, detail });
const json = (response, status, body) => { response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store'); response.end(JSON.stringify(body)); };
const bodyJson = async request => { const chunks = []; let length = 0; for await (const chunk of request) { length += chunk.length; if (length > 65_536) throw new Error('64 KiB limit'); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); };
const fixtureModel = model => typeof model === 'string' && model.startsWith('execution-lease-') && model.length < 256;
const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), plugins: [vue(), {
  name: 'actual-app-execution-lease', configureServer(vite) { vite.middlewares.use(async (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1:5200');
    if (url.pathname === '/fixture-ai/history' && request.method === 'GET') {
      const model = url.searchParams.get('model'); if (!fixtureModel(model)) { json(response, 400, { error: 'Fixture model required' }); return; }
      const state = modelState(model); json(response, 200, { requests: state.requests, events: state.events, heldRequestIds: [...state.held.keys()], nextMode: state.nextMode }); return;
    }
    if (url.pathname === '/fixture-ai/control') {
      if (request.method !== 'POST') { json(response, 405, { error: 'POST required' }); return; }
      try {
        const body = await bodyJson(request); if (!fixtureModel(body.model)) throw new Error('Fixture model required'); const state = modelState(body.model);
        if (body.action === 'release-all') { record(state, 'control-release-all', { heldRequestIds: [...state.held.keys()] }); for (const release of [...state.held.values()]) release(); }
        else if (body.action === 'immediate-next' || body.action === 'hold-next') { state.nextMode = body.action === 'immediate-next' ? 'immediate' : 'hold'; record(state, 'control-next-mode', state.nextMode); }
        else throw new Error('Known synthetic control action required');
        json(response, 200, { heldRequestIds: [...state.held.keys()], nextMode: state.nextMode });
      } catch (reason) { json(response, 400, { error: String(reason) }); } return;
    }
    if (url.pathname !== '/fixture-ai/v1/chat/completions') { next(); return; }
    if (request.method !== 'POST') { json(response, 405, { error: 'POST required' }); return; }
    try {
      const body = await bodyJson(request); if (!fixtureModel(body.model)) throw new Error('Fixture model required');
      const offered = JSON.parse(body.messages?.find(value => value.role === 'user')?.content); const evidence = offered.evidence;
      if (evidence?.project !== '执行租约合成测试对象') throw new Error('Fixture project required');
      if (!evidence?.params || !evidence.measured || !evidence.telemetryWindow?.sessionId?.startsWith('web-session-')) throw new Error('Real current Web Serial window required');
      const state = modelState(body.model); const index = state.requests.length + 1;
      const entry = { index, receivedAt: Date.now(), offered, status: 'received', hold: state.nextMode === 'hold' || state.nextMode !== 'immediate' && index > 1 };
      state.nextMode = null; state.requests.push(entry); record(state, 'actual-request-received', { index, hold: entry.hold });
      response.once('close', () => { if (!response.writableEnded) { entry.status = 'client-disconnected'; record(state, 'actual-client-disconnected', { index }); } });
      const release = () => {
        state.held.delete(index);
        if (response.destroyed || response.writableEnded) { record(state, 'release-skipped-disconnected', { index }); return; }
        const factor = 1 + .05 * ((index - 1) % 3 + 1); entry.status = 'responded'; entry.respondedAt = Date.now();
        record(state, 'actual-response-sent', { index, factor });
        json(response, 200, { id: `execution-lease-response-${index}`, object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ canRecommend: true,
            params: { kp: evidence.params.kp * factor, ki: evidence.params.ki * factor, kd: 0 }, rationale: `本地合成候选 #${index}；仅验证请求 owner、互斥、取消及迟到响应。` }) }, finish_reason: 'stop' }] });
      };
      if (entry.hold) { entry.status = 'held'; state.held.set(index, release); record(state, 'actual-response-held', { index }); }
      else release();
    } catch (reason) { json(response, 400, { error: String(reason) }); }
  }); } }], clearScreen: false, server: { host: '127.0.0.1', port: 5200, strictPort: true, hmr: false, watch: { ignored: ['**/src-tauri/**','**/output/**','**/release/**','**/data/**','**/dist/**'] } } });
await server.listen();
console.log('Actual App execution lease fixture: http://127.0.0.1:5200/tests/browser/execution-lease-harness.html');
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
