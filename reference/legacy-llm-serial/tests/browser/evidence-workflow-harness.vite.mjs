import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
const history = [];
let delayNext = false;
const pending = [];
function json(response, status, value) { response.statusCode = status; response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store'); response.end(JSON.stringify(value)); }
const server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), clearScreen: false,
  plugins: [vue(), { name: 'local-evidence-reply', configureServer(vite) { vite.middlewares.use(async (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1:5193');
    if (url.pathname === '/fixture-ai/history') { json(response, 200, history); return; }
    if (url.pathname === '/fixture-ai/delay' && request.method === 'POST') { delayNext = true; json(response, 200, { delayed: true }); return; }
    if (url.pathname === '/fixture-ai/release' && request.method === 'POST') { pending.splice(0).forEach(release => release()); json(response, 200, { released: true }); return; }
    if (url.pathname !== '/fixture-ai/v1/chat/completions') { next(); return; }
    try {
      let length = 0; const chunks = [];
      for await (const chunk of request) { length += chunk.length; if (length > 100_000) throw new Error('Fixture request limit'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.method !== 'POST' || body.model !== 'fixture-evidence-local') throw new Error('Synthetic model only');
      const rawUserMessage = body.messages.find(message => message.role === 'user').content;
      const state = JSON.parse(rawUserMessage);
      history.push({ rawUserMessage, state });
      const reply = () => json(response, 200, { choices: [{ message: { content: JSON.stringify({ explanation: '本机合成回复：这里只解释冻结选区，不证明硬件行为。', uncertainties: ['演示时间来源未验证'], actions: [{ type: 'command_draft', title: '填写测试草稿', input: 'FIXTURE_STATUS', encoding: 'text', escapeText: false, lineEnding: 'lf' }] }) } }] });
      if (delayNext) { delayNext = false; pending.push(reply); } else reply();
    } catch (error) { json(response, 400, { error: String(error) }); }
  }); } }],
  server: { host: '127.0.0.1', port: 5193, strictPort: true, hmr: false, watch: { ignored: ['**/output/**', '**/release/**', '**/data/**', '**/src-tauri/**', '**/dist/**'] } },
});
await server.listen();
console.log('Real App evidence fixture: http://127.0.0.1:5193/tests/browser/evidence-workflow-harness.html');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
