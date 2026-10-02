import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({
  configFile: false, root, plugins: [vue()], clearScreen: false,
  server: { host: '127.0.0.1', port: 5192, strictPort: true, hmr: false,
    watch: { ignored: ['**/src-tauri/**', '**/output/**', '**/release/**', '**/dist/**'] } },
});
await server.listen();
console.log('Synthetic replay FFT fixture: http://127.0.0.1:5192/tests/browser/replay-analysis-harness.html');
console.log('Real Vue/module Worker FFT; synthetic samples only, no native/hardware/AI requests.');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
