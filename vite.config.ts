import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// https://vitejs.dev/config/
export default defineConfig({
  base: './', // 桌面应用必须使用相对路径，防止本地文件协议或特定环境下绝对路径导致 404 白屏
  plugins: [vue(), {
    name: 'llm-serial-build-identity',
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { name: 'llm-serial-build', content: process.env.LLM_SERIAL_BUILD_ID || 'development' }, injectTo: 'head' }];
    },
  }],
  build: {
    outDir: process.env.LLM_SERIAL_FRONTEND_DIR || 'dist',
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    watch: {
      // 独立构建/验收产物不属于开发输入；Windows 上监视它们会与打包写入争用文件。
      ignored: ['**/src-tauri/**', '**/output/**', '**/release/**', '**/dist/**', '**/dist-staging/**'],
    },
  },
});
