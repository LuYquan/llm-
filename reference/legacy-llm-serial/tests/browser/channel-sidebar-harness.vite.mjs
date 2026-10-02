import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
const server = await createServer({
  configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), clearScreen: false,
  plugins: [vue(), { name: 'sidebar-fixture-no-ai', configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith('/no-ai/')) { next(); return; }
      response.statusCode = 410; response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ error: 'This synthetic sidebar fixture does not provide AI responses.' }));
    });
  } }],
  server: { host: '127.0.0.1', port: 5194, strictPort: true, hmr: false,
    watch: { ignored: ['**/output/**', '**/release/**', '**/data/**', '**/src-tauri/**', '**/dist/**'] } },
});
await server.listen();
console.log('Actual App sidebar fixture: http://127.0.0.1:5194/tests/browser/channel-sidebar-harness.html');
console.log('Synthetic transport only; persisted aliases loaded by actual App, no fixture setAlias, no hardware/online AI.');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
