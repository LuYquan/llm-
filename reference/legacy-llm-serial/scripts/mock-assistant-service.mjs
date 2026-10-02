// Local UI integration fixture. Never a production AI provider or a device transport.
import http from 'node:http';
import fs from 'node:fs';
const port = Number(process.env.LLM_TEST_AI_PORT || 4189);
const evidenceDir = process.env.LLM_TEST_EVIDENCE_DIR || 'output/product-redesign-20260930';
fs.mkdirSync(evidenceDir, { recursive: true });
let requests = 0;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.end(); return; }
  if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'test-fixture' }] })); return; }
  if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end('{}'); return; }
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 100_000) req.destroy(); });
  req.on('end', () => {
    try {
      const request = JSON.parse(body);
      const user = request.messages.find(message => message.role === 'user');
      const context = JSON.parse(user.content);
      requests++;
      fs.writeFileSync(`${evidenceDir}/mock-ai-request-${requests}.json`, JSON.stringify(context, null, 2));
      const actions = [{ type: 'command_draft', title: '测试字节草稿', input: 'AA 55', encoding: 'hex', escapeText: false, lineEnding: 'none' }];
      const channel = context.evidence?.channelSummaries?.[0]?.id;
      if (channel) actions.push({ type: 'display_widget', title: '测试通道数值', widget: 'number', channels: [channel], unit: '' });
      actions.push({ type: 'send_now', title: '应被本地拒绝的测试动作' });
      const content = JSON.stringify({ explanation: '这是本机测试服务的固定响应，用于验证审阅、精确草稿和取消流程，不代表模型诊断。', uncertainties: ['没有进行设备测试。'], actions });
      setTimeout(() => { if (!res.destroyed) res.end(JSON.stringify({ choices: [{ message: { content } }] })); }, context.task.includes('延迟') ? 2500 : 50);
    } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid test request' })); }
  });
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`Test AI fixture listening on http://127.0.0.1:${port}/v1\n`));
