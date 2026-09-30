import assert from 'node:assert';
import {
  fetchAvailableModels,
  PROVIDER_DEFAULTS,
  resolveAiEndpoint,
  requestChatCompletion,
  diagnoseStep,
  explainLog,
  prepareLogEvidence,
} from '../src/services/ai.ts';

export async function runAiModelsTests() {
  console.log('\n--- 单元测试套件: AI 服务商地址联动与模型动态拉取 ---');

  // 1. 服务商默认地址与模型配置
  {
    assert.strictEqual(PROVIDER_DEFAULTS.deepseek.url, 'https://api.deepseek.com/v1');
    assert.strictEqual(PROVIDER_DEFAULTS.deepseek.model, 'deepseek-chat');

    assert.strictEqual(PROVIDER_DEFAULTS.openai.url, 'https://api.openai.com/v1');
    assert.strictEqual(PROVIDER_DEFAULTS.openai.model, 'gpt-4o-mini');

    assert.strictEqual(PROVIDER_DEFAULTS.ollama.url, 'http://127.0.0.1:11434');
    assert.strictEqual(PROVIDER_DEFAULTS.ollama.model, 'llama3');

    assert.strictEqual(PROVIDER_DEFAULTS.custom.url, 'https://api.openai.com/v1');
    assert.ok(PROVIDER_DEFAULTS.custom.model);

    console.log('  ✓ 各 AI 服务商默认标准 URL 与模型名称映射正确');
  }

  // 2. resolveAiEndpoint 智能端点解析
  {
    // DeepSeek
    const ds = resolveAiEndpoint('', 'deepseek');
    assert.strictEqual(ds.endpoint, 'https://api.deepseek.com/v1/chat/completions');
    assert.strictEqual(ds.isOllamaNative, false);

    // OpenAI
    const oa = resolveAiEndpoint('https://api.openai.com/v1', 'openai');
    assert.strictEqual(oa.endpoint, 'https://api.openai.com/v1/chat/completions');

    // Ollama native
    const ol = resolveAiEndpoint('http://127.0.0.1:11434', 'ollama');
    assert.strictEqual(ol.endpoint, 'http://127.0.0.1:11434/api/generate');
    assert.strictEqual(ol.isOllamaNative, true);

    // Ollama v1 compatibility
    const olV1 = resolveAiEndpoint('http://127.0.0.1:11434/v1', 'ollama');
    assert.strictEqual(olV1.endpoint, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.strictEqual(olV1.isOllamaNative, false);

    // Custom OpenAI compatible (e.g. SiliconFlow, Moonshot, Qwen)
    const custom1 = resolveAiEndpoint('https://api.siliconflow.cn/v1', 'custom');
    assert.strictEqual(custom1.endpoint, 'https://api.siliconflow.cn/v1/chat/completions');
    assert.strictEqual(custom1.isOllamaNative, false);

    const custom2 = resolveAiEndpoint('https://api.moonshot.cn/v1/chat/completions', 'custom');
    assert.strictEqual(custom2.endpoint, 'https://api.moonshot.cn/v1/chat/completions');

    const custom3 = resolveAiEndpoint('https://api.custom.com/openai', 'custom');
    assert.strictEqual(custom3.endpoint, 'https://api.custom.com/openai/v1/chat/completions');

    console.log('  ✓ resolveAiEndpoint 兼容 DeepSeek, OpenAI, Ollama 原生与 Custom 自定义中转站');
  }

  // 3. fetchAvailableModels - Ollama /api/tags
  {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url: any) => {
        const u = url.toString();
        if (u.includes('/api/tags')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              models: [
                { name: 'llama3:latest' },
                { name: 'qwen2.5:7b' },
                { name: 'deepseek-r1:8b' },
              ],
            }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      };

      const models = await fetchAvailableModels({
        provider: 'ollama',
        api_url: 'http://127.0.0.1:11434',
        api_key: '',
      });

      assert.deepStrictEqual(models, ['deepseek-r1:8b', 'llama3:latest', 'qwen2.5:7b']);
      console.log('  ✓ fetchAvailableModels 成功拉取并排序 Ollama 本地模型 (/api/tags)');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 3b. 统一 AI 请求边界：本机 Ollama 不需要 Key，结构化请求使用 JSON 模式
  {
    const originalFetch = globalThis.fetch;
    try {
      let capturedUrl = '';
      let capturedInit: any = null;
      globalThis.fetch = async (url: any, init: any) => {
        capturedUrl = url.toString();
        capturedInit = init;
        return {
          ok: true,
          status: 200,
          json: async () => ({ response: '{"canRecommend":false,"reason":"本地测试"}' }),
        } as any;
      };

      const content = await requestChatCompletion(
        { provider: 'ollama', api_url: 'http://127.0.0.1:11434', api_key: '', model: 'qwen2.5' },
        'system',
        'user',
        { jsonMode: true, timeoutMs: 2000 },
      );
      const body = JSON.parse(capturedInit.body);
      assert.strictEqual(capturedUrl, 'http://127.0.0.1:11434/api/generate');
      assert.strictEqual(capturedInit.headers.Authorization, undefined);
      assert.strictEqual(body.format, 'json');
      assert.strictEqual(content, '{"canRecommend":false,"reason":"本地测试"}');
      console.log('  ✓ 统一 AI 请求入口支持无 Key 的本机 Ollama JSON 请求');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 3c. 统一错误边界不能把 API Key 回显到界面错误
  {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({
        ok: false,
        status: 401,
        text: async () => 'Authorization: Bearer sk-secret-key',
      } as any);
      await assert.rejects(
        () => requestChatCompletion(
          { provider: 'custom', api_url: 'https://example.test/v1', api_key: 'sk-secret-key', model: 'test' },
          'system',
          'user',
          { timeoutMs: 2000 },
        ),
        (err: any) => {
          assert.ok(err.message.includes('HTTP 401'));
          assert.ok(!err.message.includes('sk-secret-key'));
          assert.ok(err.message.includes('[已隐藏]'));
          return true;
        },
      );
      console.log('  ✓ 统一 AI 错误不会回显 API Key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 4. fetchAvailableModels - OpenAI / Custom / DeepSeek (GET /models)
  // 3d. 桌面 Tauri AI 请求只把非敏感请求体交给 Rust 命令，不走 renderer fetch
  {
    const originalWindow = (globalThis as any).window;
    const originalFetch = globalThis.fetch;
    try {
      let invokedCommand = '';
      let invokedArgs: any = null;
      (globalThis as any).window = {
        __TAURI_INTERNALS__: {
          invoke: async (command: string, args: any) => {
            invokedCommand = command;
            invokedArgs = args;
            return command === 'fetch_ai_models'
              ? ['desktop-model']
              : '{"canRecommend":false,"reason":"desktop"}';
          },
        },
      };
      globalThis.fetch = async () => {
        throw new Error('desktop AI must not use renderer fetch');
      };
      const content = await requestChatCompletion(
        {
          provider: 'custom',
          api_url: 'https://example.test/v1',
          api_key: 'sk-renderer-must-not-be-forwarded',
          api_key_configured: true,
          model: 'test',
        },
        'system',
        'user',
        { timeoutMs: 2000 },
      );
      assert.strictEqual(invokedCommand, 'request_ai_chat');
      assert.ok(invokedArgs?.request);
      assert.strictEqual(invokedArgs.request.apiKey, undefined);
      assert.strictEqual(invokedArgs.request.userPrompt, 'user');
      assert.strictEqual(content, '{"canRecommend":false,"reason":"desktop"}');
      console.log('  ✓ Tauri AI 请求不把 API Key 传给前端网络层或命令参数');

      const models = await fetchAvailableModels({
        provider: 'custom',
        api_url: 'https://example.test/v1',
        api_key: 'sk-models-must-not-be-forwarded',
        api_key_configured: true,
      });
      assert.strictEqual(invokedCommand, 'fetch_ai_models');
      assert.strictEqual(invokedArgs.request.apiKey, undefined);
      assert.deepStrictEqual(models, ['desktop-model']);
      console.log('  ✓ Tauri 模型列表请求也只传非敏感配置');
    } finally {
      (globalThis as any).window = originalWindow;
      globalThis.fetch = originalFetch;
    }
  }

  // 4. fetchAvailableModels - OpenAI / Custom / DeepSeek (GET /models)
  {
    const originalFetch = globalThis.fetch;
    try {
      let capturedAuth: string | null = null;
      let capturedUrl: string | null = null;

      globalThis.fetch = async (url: any, init: any) => {
        capturedUrl = url.toString();
        capturedAuth = init?.headers?.Authorization || null;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            object: 'list',
            data: [
              { id: 'gpt-4o' },
              { id: 'gpt-4o-mini' },
              { id: 'o1-mini' },
              { id: 'text-embedding-3-small' },
            ],
          }),
        } as any;
      };

      const models = await fetchAvailableModels({
        provider: 'custom',
        api_url: 'https://api.siliconflow.cn/v1',
        api_key: 'sk-test-secret-key',
      });

      assert.strictEqual(capturedUrl, 'https://api.siliconflow.cn/v1/models');
      assert.strictEqual(capturedAuth, 'Bearer sk-test-secret-key');
      assert.strictEqual(models.length, 4);
      assert.ok(models.includes('gpt-4o'));
      assert.ok(models.includes('gpt-4o-mini'));
      assert.deepStrictEqual(models, ['gpt-4o', 'gpt-4o-mini', 'o1-mini', 'text-embedding-3-small']);

      console.log('  ✓ fetchAvailableModels 成功拉取 Custom OpenAI 兼容端点模型并携带 Bearer Auth');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 5. fetchAvailableModels - 异常拦截 (401 报错清晰解析)
  {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        return {
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ error: { message: 'Incorrect API key provided: Bearer sk-invalid' } }),
        } as any;
      };

      await assert.rejects(
        async () => {
          await fetchAvailableModels({
            provider: 'deepseek',
            api_url: 'https://api.deepseek.com/v1',
            api_key: 'sk-invalid',
          });
        },
        (err: any) => {
          assert.ok(err.message.includes('HTTP 401'));
          assert.ok(err.message.includes('Incorrect API key provided'));
          assert.ok(!err.message.includes('sk-invalid'));
          assert.ok(err.message.includes('[已隐藏]'));
          return true;
        }
      );

      console.log('  ✓ fetchAvailableModels 遇到 401 鉴权失败时返回友好错误提示');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 6. fetchAvailableModels - 404 智能回退路径 (/v1/models -> /models 互补测试)
  {
    const originalFetch = globalThis.fetch;
    try {
      const requestedUrls: string[] = [];
      globalThis.fetch = async (url: any) => {
        const u = url.toString();
        requestedUrls.push(u);
        if (u === 'https://api.deepseek.com/models') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
            }),
          } as any;
        }
        return { ok: false, status: 404 } as any;
      };

      const models = await fetchAvailableModels({
        provider: 'deepseek',
        api_url: 'https://api.deepseek.com/v1',
        api_key: 'sk-test',
      });

      assert.deepStrictEqual(requestedUrls, [
        'https://api.deepseek.com/v1/models',
        'https://api.deepseek.com/models',
      ]);
      assert.deepStrictEqual(models, ['deepseek-chat', 'deepseek-reasoner']);
      console.log('  ✓ fetchAvailableModels 遇到 /v1/models 404 时成功自动回退至 /models');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 7. fetchAvailableModels - Ollama 空模型友好错误提示
  {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [] }),
        } as any;
      };

      await assert.rejects(
        async () => {
          await fetchAvailableModels({
            provider: 'ollama',
            api_url: 'http://127.0.0.1:11434',
            api_key: '',
          });
        },
        (err: any) => {
          assert.ok(err.message.includes('尚未安装任何模型'));
          return true;
        }
      );

      console.log('  ✓ fetchAvailableModels 在 Ollama 无模型时给出清晰安装指引提示');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 8. diagnoseStep - 第三方服务商不支持 response_format 时自动重试
  {
    const originalFetch = globalThis.fetch;
    try {
      let callCount = 0;
      let secondBody: any = null;

      globalThis.fetch = async (_url: any, init: any) => {
        callCount++;
        const parsedBody = JSON.parse(init.body);
        if (callCount === 1) {
          // 第一次带 response_format，模拟第三方中转站报 400 不支持
          assert.ok(parsedBody.response_format);
          return {
            ok: false,
            status: 400,
            text: async () => 'response_format is not supported by this model',
          } as any;
        }
        // 第二次重试，应不带 response_format
        secondBody = parsedBody;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    diagnosis: '超调适中，稳态良好',
                    recommendation: { kp: 1.5, ki: 0.5, kd: 0.2 },
                    rationale: '微调以优化调节时间',
                    risk_warning: '注意积分饱和',
                  }),
                },
              },
            ],
          }),
        } as any;
      };

      const result = await diagnoseStep(
        {
          rise_time_s: 0.2,
          overshoot_percent: 8.5,
          settling_time_s: 0.8,
          steady_state_error: 0.01,
          is_stable: true,
        } as any,
        { kp: 1.8, ki: 0.6, kd: 0.25 },
        {
          provider: 'custom',
          api_url: 'https://api.siliconflow.cn/v1',
          api_key: 'sk-test',
          model: 'deepseek-ai/DeepSeek-R1',
        }
      );

      assert.strictEqual(callCount, 2);
      assert.strictEqual(secondBody.response_format, undefined);
      const secondUserPrompt = secondBody.messages?.[1]?.content || '';
      assert.equal(secondUserPrompt.includes('sample_rate_hz'), false);
      assert.ok(secondUserPrompt.includes('未提供设备采样时钟'));
      assert.equal(secondUserPrompt.includes('1000'), false);
      assert.strictEqual(result.recommendation.kp, 1.5);
      console.log('  ✓ diagnoseStep 遇到第三方 400 格式错误时成功自动降级重试并解析结果');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 未计算稳定性时必须在联网/离线分支之前拒绝诊断，不能默认当作稳定系统。
  {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error('Unexpected AI request');
    };
    try {
      await assert.rejects(
        () => diagnoseStep(
          {
            rise_time_s: null,
            overshoot_percent: null,
            settling_time_s: null,
            steady_state_error: null,
            is_stable: null,
          } as any,
          { kp: 1, ki: 0, kd: 0 },
          { provider: 'custom', api_url: 'https://example.invalid/v1', api_key: 'test', model: 'test' }
        ),
        /阶跃分析前提不完整/
      );
      assert.strictEqual(fetchCalled, false, '证据不足时不应把数据发送给 AI');
      console.log('  ✓ 稳定性证据缺失时拒绝联网诊断与 PID 候选');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 9. explainLog 与结构化诊断共用统一请求边界，并且错误中不回显 API Key
  {
    const originalFetch = globalThis.fetch;
    try {
      let requestCount = 0;
      let capturedLogPrompt = '';
      globalThis.fetch = async (_url: any, init: any) => {
        requestCount++;
        const body = JSON.parse(init.body);
        capturedLogPrompt = body.messages?.[1]?.content || body.prompt || '';
        assert.strictEqual(body.temperature, 0.3);
        assert.strictEqual(body.response_format, undefined);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: '检查串口参数和供电，随后确认固件中断没有阻塞。' } }],
          }),
        } as any;
      };

      const explanation = await explainLog(
        'CRC error',
        ['open COM3', 'rx 00 ff'],
        {
          provider: 'custom',
          api_url: 'https://example.test/v1',
          api_key: 'sk-log-test',
          model: 'test',
        },
      );
      assert.strictEqual(requestCount, 1);
      assert.ok(explanation.includes('检查串口'));
      assert.ok(capturedLogPrompt.includes('本次仅发送 1 条选中日志'));
      assert.ok(capturedLogPrompt.includes('未上传完整日志、原始波形或串口密钥'));
      console.log('  ✓ explainLog 通过统一 AI 请求边界返回诊断文本');

      globalThis.fetch = async () => ({
        ok: false,
        status: 401,
        text: async () => 'Authorization: Bearer sk-log-secret',
      } as any);
      const failed = await explainLog(
        'timeout',
        [],
        {
          provider: 'custom',
          api_url: 'https://example.test/v1',
          api_key: 'sk-log-secret',
          model: 'test',
        },
      );
      assert.ok(failed.includes('诊断失败'));
      assert.ok(!failed.includes('sk-log-secret'));
      assert.ok(failed.includes('[已隐藏]'));
      console.log('  ✓ explainLog 请求失败时会脱敏错误并保留离线排查建议');
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 日志证据窗口必须固定上限并脱敏，避免把完整终端历史或凭据发送给模型。
  {
    const evidence = prepareLogEvidence(
      `Authorization: Bearer very-secret ${'x'.repeat(3_000)}`,
      Array.from({ length: 8 }, (_, index) => `line-${index} ${'y'.repeat(700)}`),
    );
    assert.equal(evidence.context.length, 5);
    assert.equal(evidence.omittedContextLines, 3);
    assert.ok(evidence.primary.length <= 2_048 + '…[已截断]'.length);
    assert.ok(evidence.primary.includes('[已隐藏]'));
    assert.equal(evidence.primary.includes('very-secret'), false);
    assert.ok(evidence.context.every((line) => line.length <= 512 + '…[已截断]'.length));
    assert.ok(evidence.summary.includes('未上传完整日志'));
    console.log('  ✓ 日志 AI 证据窗口有界、脱敏且可向用户说明发送范围');
  }

  console.log('========================================');
  console.log('AI 模型拉取与端点联动测试全部通过！');
  console.log('========================================\n');
}
