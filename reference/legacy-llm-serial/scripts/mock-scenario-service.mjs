// Local integration fixture. Fixed synthetic answers test the application flow;
// they do not validate a real model, AI provider, or physical control system.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.LLM_TEST_AI_PORT || 4190);
const evidenceDir = path.resolve('output/scenario-ai-20260930/mock-ai');
fs.mkdirSync(evidenceDir, { recursive: true });
let requests = 0;

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.end(); return; }
  if (req.url === '/v1/models') {
    res.end(JSON.stringify({ data: [{ id: 'scenario-fixture' }] })); return;
  }
  if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
    res.writeHead(404); res.end('{}'); return;
  }
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 100_000) req.destroy(); });
  req.on('end', () => {
    try {
      const request = JSON.parse(body);
      const context = JSON.parse(request.messages.find(message => message.role === 'user').content);
      const prompt = request.messages.find(message => message.role === 'system')?.content || '';
      requests++;
      fs.writeFileSync(path.join(evidenceDir, `request-${requests}.json`), JSON.stringify({ context, prompt }, null, 2));
      let reply;
      if (prompt.includes('建模草稿')) {
        reply = context.description?.includes('拒绝')
          ? { canModel: false, reason: '本机测试：缺少工作点，拒绝生成模型。' }
          : { canModel: true, title: '本机测试 · 质量阻尼模型', numerator: ['1'], denominator: ['mass', 'damping'], tau: '0',
            physicalFields: [
              { id: 'mass', label: '测试质量', unit: 'kg', required: true, min: 0 },
              { id: 'damping', label: '测试阻尼', unit: 'N·s/m', required: true, min: 0 },
            ],
            assumptions: ['本机固定响应，仅验证表单与模型审核流程。', '测试对象为力输入、速度输出的一维线性质量阻尼模型。'],
            explanation: '测试关系 G(s)=1/(mass*s+damping)。用户填写数值后必须确认假设；不代表真实设备。' };
      } else if (prompt.includes('候选建议器')) {
        reply = { canRecommend: true, params: { ...context.evidence.params, kp: context.evidence.params.kp * 1.01 },
          rationale: '本机固定候选仅验证套组约束与本地边界校验。' };
      } else {
        reply = { explanation: '本机测试：核对协议和通道绑定。', uncertainties: ['未连接真实设备。'],
          actions: [{ type: 'command_draft', title: '测试草稿', input: 'AA 55', encoding: 'hex', escapeText: false, lineEnding: 'none' }] };
      }
      setTimeout(() => {
        if (!res.destroyed) res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
      }, context.description?.includes('延迟') ? 1500 : 20);
    } catch {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid synthetic test request' }));
    }
  });
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`Synthetic scenario fixture: http://127.0.0.1:${port}/v1\n`);
});
