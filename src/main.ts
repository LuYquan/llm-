import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import 'uplot/dist/uPlot.min.css';

// 初始化 Claude 双模主题 (默认优雅暖黑 Warm Espresso)
try {
  const savedTheme = localStorage.getItem('llm-serial.theme-mode');
  if (savedTheme === 'light') {
    document.documentElement.classList.add('light');
    document.documentElement.classList.remove('dark');
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.classList.add('dark');
    document.documentElement.classList.remove('light');
    document.documentElement.setAttribute('data-theme', 'dark');
  }
} catch {
  document.documentElement.classList.add('dark');
  document.documentElement.setAttribute('data-theme', 'dark');
}

// 全局未捕获错误防护，一旦发生白屏异常直接在页面呈现排查提示
window.addEventListener('error', (event) => {
  console.error('Global uncaught error:', event.error || event.message);
  const el = document.getElementById('app');
  if (el && !el.children.length) {
    // Error messages and stack traces can contain arbitrary device or service
    // text. Build the fallback page with text nodes so a startup failure cannot
    // turn an exception payload into executable markup or inline script.
    const container = document.createElement('div');
    container.style.cssText = 'padding:24px;color:#f87171;background:var(--bg-base,#1F1E1D);height:100vh;box-sizing:border-box;font-family:monospace;';

    const title = document.createElement('h2');
    title.textContent = '⚠️ 界面挂载异常';
    title.style.marginTop = '0';

    const summary = document.createElement('p');
    summary.textContent = event.message || '未知启动错误';
    summary.style.color = 'var(--text-muted,#9E9C94)';

    const details = document.createElement('pre');
    details.textContent = String(event.error?.stack || event.message || '未知启动错误');
    details.style.cssText = 'background:var(--bg-elevated,#2F2E2A);padding:12px;border-radius:6px;overflow:auto;max-height:400px;color:var(--text-main,#ECEAE4);border:1px solid var(--border-subtle,#383633);';

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '刷新重试';
    retry.style.cssText = 'margin-top:16px;padding:6px 16px;background:var(--accent-terracotta,#DA7756);color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;';
    retry.addEventListener('click', () => window.location.reload());

    container.append(title, summary, details, retry);
    el.replaceChildren(container);
  }
});

createApp(App).mount('#app');
