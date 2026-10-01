import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// ROOT/PORT support a preserved source baseline at independent port 5203. The
// same three fixture files must be copied into that root's tests/browser folder.
const root = resolve(process.env.FIXTURE_ROOT ?? process.env.ROOT ?? fileURLToPath(new URL('../../', import.meta.url)));
const port = Number(process.env.FIXTURE_PORT ?? process.env.PORT ?? '5202');
if (![5202, 5203].includes(port)) throw new Error('Use isolated fixture port 5202 or baseline port 5203');
const origin = `http://127.0.0.1:${port}`;
const models = new Map();
const modelState = model => {
  if (!models.has(model)) models.set(model, { requests: [], events: [], held: new Map(), nextMode: null });
  return models.get(model);
};
const record = (state, event, detail) => state.events.push({ at: Date.now(), event, detail });
const json = (response, code, body) => {
  response.statusCode = code; response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store'); response.end(JSON.stringify(body));
};
const bodyJson = async request => {
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 65_536) throw new Error('64 KiB limit'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};
const fixtureModel = model => typeof model === 'string' && model.startsWith('background-delivery-') && model.length < 256;
const server = await createServer({
  configFile: false, root, plugins: [vue(), {
    name: 'actual-app-background-delivery', configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', origin);
        if (url.pathname === '/fixture-ai/history' && request.method === 'GET') {
          const model = url.searchParams.get('model');
          if (!fixtureModel(model)) { json(response, 400, { error: 'Fixture model required' }); return; }
          const state = modelState(model);
          json(response, 200, { requests: state.requests, events: state.events, heldRequestIds: [...state.held.keys()], nextMode: state.nextMode }); return;
        }
        if (url.pathname === '/fixture-ai/control') {
          if (request.method !== 'POST') { json(response, 405, { error: 'POST required' }); return; }
          try {
            const body = await bodyJson(request);
            if (!fixtureModel(body.model)) throw new Error('Fixture model required');
            const state = modelState(body.model);
            if (body.action === 'release-all') {
              record(state, 'control-release-all', { heldRequestIds: [...state.held.keys()] });
              for (const release of [...state.held.values()]) release();
            } else if (body.action === 'hold-next') { state.nextMode = 'hold'; record(state, 'control-next-mode', state.nextMode); }
            else throw new Error('Known synthetic control action required');
            json(response, 200, { heldRequestIds: [...state.held.keys()], nextMode: state.nextMode });
          } catch (reason) { json(response, 400, { error: String(reason) }); }
          return;
        }
        if (url.pathname !== '/fixture-ai/v1/chat/completions') { next(); return; }
        if (request.method !== 'POST') { json(response, 405, { error: 'POST required' }); return; }
        try {
          const body = await bodyJson(request);
          if (!fixtureModel(body.model)) throw new Error('Fixture model required');
          const offered = JSON.parse(body.messages?.find(value => value.role === 'user')?.content);
          const evidence = offered.evidence;
          if (evidence?.project !== '后台遥测合成测试对象') throw new Error('Fixture project required');
          if (!evidence?.params || !evidence.measured || !evidence.telemetryWindow?.sessionId?.startsWith('web-session-')) {
            throw new Error('Real current Web Serial window required');
          }
          const state = modelState(body.model);
          const index = state.requests.length + 1;
          const entry = { index, receivedAt: Date.now(), offered, status: 'received', hold: state.nextMode === 'hold' };
          state.nextMode = null; state.requests.push(entry);
          record(state, 'actual-request-received', { index, hold: entry.hold });
          response.once('close', () => {
            if (!response.writableEnded) { entry.status = 'client-disconnected'; record(state, 'actual-client-disconnected', { index }); }
          });
          const release = () => {
            state.held.delete(index);
            if (response.destroyed || response.writableEnded) { record(state, 'release-skipped-disconnected', { index }); return; }
            const factor = 1.05;
            entry.status = 'responded'; entry.respondedAt = Date.now();
            record(state, 'actual-scripted-response-sent', { index, factor });
            json(response, 200, {
              id: `background-delivery-response-${index}`, object: 'chat.completion', model: body.model,
              choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ canRecommend: true,
                params: { kp: evidence.params.kp * factor, ki: evidence.params.ki * factor, kd: 0 },
                rationale: `本地脚本候选 #${index}；仅验证渲染和订阅暂停时的真实业务遥测读取与停止边界。`,
              }) }, finish_reason: 'stop' }],
            });
          };
          if (entry.hold) { entry.status = 'held'; state.held.set(index, release); record(state, 'actual-response-held', { index }); }
          else release();
        } catch (reason) { json(response, 400, { error: String(reason) }); }
      });
    },
  }],
  clearScreen: false, server: {
    host: '127.0.0.1', port, strictPort: true, hmr: false,
    watch: { ignored: ['**/src-tauri/**', '**/output/**', '**/release/**', '**/data/**', '**/dist/**'] },
  },
});
await server.listen();
console.log(`Actual App background delivery fixture: ${origin}/tests/browser/background-delivery-harness.html`);
console.log(`Source root: ${root}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
