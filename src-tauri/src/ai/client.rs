use reqwest::{Client, Response, StatusCode, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

const MAX_AI_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_AI_PROMPT_BYTES: usize = 256 * 1024;

fn http_client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("创建 AI 网络客户端失败：{e}"))
}

async fn bounded_body(mut response: Response) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|size| size > MAX_AI_RESPONSE_BYTES as u64) {
        return Err("AI 响应超过 2 MiB，已中止读取；请检查服务地址或缩小请求".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取 AI 响应失败，请重试".to_string())? {
        if bytes.len().saturating_add(chunk.len()) > MAX_AI_RESPONSE_BYTES {
            return Err("AI 响应超过 2 MiB，已中止读取；请检查服务地址或缩小请求".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn response_json(response: Response) -> Result<Value, String> {
    let bytes = bounded_body(response).await?;
    serde_json::from_slice(&bytes).map_err(|_| "AI 服务未返回有效 JSON，请检查 API 地址与接口兼容性".to_string())
}

/// Desktop AI requests are deliberately represented without an API key. The
/// key is loaded inside the command boundary from the protected secrets store.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    pub provider: String,
    pub api_url: String,
    pub model: String,
    pub system_prompt: String,
    pub user_prompt: String,
    #[serde(default = "default_true")]
    pub json_mode: bool,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub temperature: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelsRequest {
    pub provider: String,
    pub api_url: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatEndpoint {
    pub url: String,
    pub ollama_native: bool,
}

fn default_true() -> bool {
    true
}

fn default_base_url(provider: &str) -> &'static str {
    match provider {
        "ollama" => "http://127.0.0.1:11434",
        "deepseek" => "https://api.deepseek.com/v1",
        _ => "https://api.openai.com/v1",
    }
}

fn normalize_base_url(base_url: &str, provider: &str) -> Result<String, String> {
    let value = if base_url.trim().is_empty() {
        default_base_url(provider).to_string()
    } else {
        base_url.trim().trim_end_matches('/').to_string()
    };
    let url = Url::parse(&value).map_err(|_| "AI 服务地址格式无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("AI 服务地址必须使用 http:// 或 https://".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("AI 服务地址不能包含用户名、密码、查询参数或片段；请使用独立 API Key 字段".to_string());
    }
    Ok(value)
}

pub fn resolve_chat_endpoint(base_url: &str, provider: &str) -> Result<ChatEndpoint, String> {
    let base = normalize_base_url(base_url, provider)?;
    if provider == "ollama" && !base.contains("/v1") {
        let url = if base.ends_with("/api/generate") || base.ends_with("/api/chat") {
            base
        } else {
            format!("{base}/api/generate")
        };
        return Ok(ChatEndpoint {
            url,
            ollama_native: true,
        });
    }

    let url = if base.ends_with("/chat/completions") {
        base
    } else if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    };
    Ok(ChatEndpoint {
        url,
        ollama_native: false,
    })
}

fn model_name(request: &AiChatRequest) -> String {
    let model = request.model.trim();
    if !model.is_empty() {
        model.to_string()
    } else if request.provider == "deepseek" {
        "deepseek-chat".to_string()
    } else if request.provider == "ollama" {
        "llama3".to_string()
    } else {
        "gpt-4o-mini".to_string()
    }
}

fn request_timeout(timeout_ms: Option<u64>, default_ms: u64) -> Duration {
    Duration::from_millis(timeout_ms.unwrap_or(default_ms).clamp(1_000, 120_000))
}

fn require_key(provider: &str, api_url: &str, api_key: &str) -> Result<(), String> {
    let local_custom = provider == "custom" && Url::parse(api_url).ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if provider != "ollama" && !local_custom && api_key.trim().is_empty() {
        return Err("当前 AI 服务需要 API Key；密钥只从桌面受保护存储读取".to_string());
    }
    Ok(())
}

fn redact(text: &str, api_key: &str) -> String {
    let mut redacted = if api_key.trim().is_empty() {
        text.to_string()
    } else {
        text.replace(api_key, "[已隐藏]")
    };
    let lower = redacted.to_ascii_lowercase();
    if let Some(index) = lower.find("bearer ") {
        let start = index + "bearer ".len();
        let end = redacted[start..]
            .find(|character: char| {
                character.is_whitespace()
                    || character == ','
                    || character == '}'
                    || character == '"'
            })
            .map(|offset| start + offset)
            .unwrap_or(redacted.len());
        redacted.replace_range(start..end, "[已隐藏]");
    }
    redacted.chars().take(240).collect()
}

async fn response_error(response: Response, context: &str, api_key: &str) -> String {
    let status = response.status();
    let body = match bounded_body(response).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
        Err(error) => return format!("{context}返回 HTTP {status}：{error}"),
    };
    let recovery = match status.as_u16() {
        301..=399 => "；请填写服务最终 API 地址，自动重定向已禁用",
        401 | 403 => "；请核对 API Key 和模型权限",
        429 => "；请求受限，请稍后重试或检查服务额度",
        500..=599 => "；服务暂不可用，请稍后重试",
        _ => "",
    };
    let detail = if body.trim().is_empty() {
        String::new()
    } else {
        format!(": {}", redact(&body, api_key))
    };
    format!("{context}返回 HTTP {status}{detail}{recovery}")
}

async fn send_chat_request(
    client: &Client,
    endpoint: &ChatEndpoint,
    request: &AiChatRequest,
    api_key: &str,
    include_json_format: bool,
) -> Result<Response, String> {
    let model = model_name(request);
    let body = if endpoint.ollama_native {
        let mut body = json!({
            "model": model,
            "prompt": format!("{}\n\n{}", request.system_prompt, request.user_prompt),
            "stream": false,
        });
        if include_json_format {
            body["format"] = Value::String("json".to_string());
        }
        body
    } else {
        let mut body = json!({
            "model": model,
            "messages": [
                { "role": "system", "content": request.system_prompt },
                { "role": "user", "content": request.user_prompt },
            ],
            "temperature": request.temperature.unwrap_or(0.2),
        });
        if include_json_format {
            body["response_format"] = json!({ "type": "json_object" });
        }
        body
    };

    let mut builder = client.post(&endpoint.url).json(&body);
    if !endpoint.ollama_native && !api_key.trim().is_empty() {
        builder = builder.bearer_auth(api_key.trim());
    }
    builder
        .send()
        .await
        .map_err(|error| format!("AI 请求失败：{}", redact(&error.to_string(), api_key)))
}

pub async fn chat(request: AiChatRequest, api_key: &str) -> Result<String, String> {
    if request.system_prompt.len().saturating_add(request.user_prompt.len()) > MAX_AI_PROMPT_BYTES {
        return Err("AI 请求内容超过 256 KiB，请缩小日志或数据范围".to_string());
    }
    require_key(&request.provider, &request.api_url, api_key)?;
    let endpoint = resolve_chat_endpoint(&request.api_url, &request.provider)?;
    let client = http_client(request_timeout(request.timeout_ms, 25_000))?;

    let mut response =
        send_chat_request(&client, &endpoint, &request, api_key, request.json_mode).await?;
    if !endpoint.ollama_native && request.json_mode && response.status() == StatusCode::BAD_REQUEST
    {
        response = send_chat_request(&client, &endpoint, &request, api_key, false).await?;
    }
    if !response.status().is_success() {
        return Err(response_error(response, "AI 服务", api_key).await);
    }

    let data = response_json(response).await?;
    let content = data
        .get("response")
        .and_then(Value::as_str)
        .or_else(|| data.pointer("/message/content").and_then(Value::as_str))
        .or_else(|| {
            data.pointer("/choices/0/message/content")
                .and_then(Value::as_str)
        })
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "AI 服务未返回可读取的内容".to_string())?;
    Ok(content.to_string())
}

fn ollama_tags_url(base: &str) -> String {
    if base.ends_with("/v1") {
        format!("{}/api/tags", base.trim_end_matches("/v1"))
    } else if base.ends_with("/api/tags") {
        base.to_string()
    } else {
        format!("{base}/api/tags")
    }
}

fn models_url(base: &str) -> String {
    if base.ends_with("/chat/completions") {
        base.replace("/chat/completions", "/models")
    } else if base.ends_with("/models") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    }
}

fn alternate_models_url(base: &str, current: &str) -> Option<String> {
    let base_without_v1 = base.strip_suffix("/v1").unwrap_or(base);
    let alternate = if current.ends_with("/v1/models") {
        format!("{base_without_v1}/models")
    } else {
        format!("{base_without_v1}/v1/models")
    };
    (alternate != current).then_some(alternate)
}

fn parse_model_ids(data: &Value) -> Vec<String> {
    let list = data
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| data.get("models").and_then(Value::as_array))
        .or_else(|| data.as_array());
    let Some(list) = list else {
        return Vec::new();
    };
    let mut models: Vec<String> = list
        .iter()
        .filter_map(|item| match item {
            Value::String(value) => Some(value.clone()),
            Value::Object(object) => object
                .get("id")
                .or_else(|| object.get("name"))
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
        .filter(|value| !value.trim().is_empty())
        .collect();
    models.sort();
    models.dedup();
    models
}

async fn get_models(
    client: &Client,
    url: &str,
    api_key: &str,
) -> Result<(StatusCode, Value), String> {
    let mut builder = client.get(url).header("content-type", "application/json");
    if !api_key.trim().is_empty() {
        builder = builder.bearer_auth(api_key.trim());
    }
    let response = builder
        .send()
        .await
        .map_err(|error| format!("拉取模型失败：{}", redact(&error.to_string(), api_key)))?;
    let status = response.status();
    if !status.is_success() {
        let message = response_error(response, "模型服务", api_key).await;
        return Err(message);
    }
    let data = response_json(response).await?;
    Ok((status, data))
}

pub async fn models(request: AiModelsRequest, api_key: &str) -> Result<Vec<String>, String> {
    require_key(&request.provider, &request.api_url, api_key)?;
    let base = normalize_base_url(&request.api_url, &request.provider)?;
    let client = http_client(request_timeout(request.timeout_ms, 8_000))?;

    if request.provider == "ollama" {
        let tags = ollama_tags_url(&base);
        if let Ok((_, data)) = get_models(&client, &tags, api_key).await {
            let models = parse_model_ids(&data);
            if !models.is_empty() {
                return Ok(models);
            }
        }
    }

    let primary = models_url(&base);
    match get_models(&client, &primary, api_key).await {
        Ok((_, data)) => {
            let models = parse_model_ids(&data);
            if models.is_empty() {
                Err("模型服务正常响应，但没有可用模型".to_string())
            } else {
                Ok(models)
            }
        }
        Err(primary_error) => {
            if let Some(alternate) = alternate_models_url(&base, &primary) {
                if let Ok((_, data)) = get_models(&client, &alternate, api_key).await {
                    let models = parse_model_ids(&data);
                    if !models.is_empty() {
                        return Ok(models);
                    }
                }
            }
            Err(primary_error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_native_and_compatible_endpoints() {
        assert_eq!(
            resolve_chat_endpoint("http://127.0.0.1:11434", "ollama").unwrap(),
            ChatEndpoint {
                url: "http://127.0.0.1:11434/api/generate".to_string(),
                ollama_native: true,
            }
        );
        assert_eq!(
            resolve_chat_endpoint("https://api.deepseek.com/v1", "deepseek")
                .unwrap()
                .url,
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            resolve_chat_endpoint("https://example.test/chat/completions", "custom")
                .unwrap()
                .url,
            "https://example.test/chat/completions"
        );
    }

    #[test]
    fn rejects_non_http_urls_and_missing_cloud_keys() {
        assert!(resolve_chat_endpoint("file:///secret", "custom").is_err());
        assert!(require_key("deepseek", "https://api.deepseek.com/v1", "").is_err());
        assert!(require_key("ollama", "http://127.0.0.1:11434", "").is_ok());
        assert!(require_key("custom", "http://127.0.0.1:8080/v1", "").is_ok());
        assert!(require_key("custom", "http://[::1]:8080/v1", "").is_ok());
        assert!(require_key("custom", "https://localhost.example.com/v1", "").is_err());
        assert!(require_key("custom", "https://example.com/v1", "").is_err());
        for address in ["https://user:secret@example.test/v1", "https://example.test/v1?key=secret", "https://example.test/v1#key", "http://"] {
            assert!(normalize_base_url(address, "custom").is_err());
        }
    }

    #[test]
    fn redacts_api_key_and_bearer_values() {
        let message = "Bearer sk-secret and sk-secret";
        let redacted = redact(message, "sk-secret");
        assert!(!redacted.contains("sk-secret"));
        assert!(redacted.contains("[已隐藏]"));
    }

    #[test]
    fn parses_model_variants_and_deduplicates() {
        let data = json!({"data": [{"id": "b"}, {"id": "a"}, {"id": "a"}]});
        assert_eq!(parse_model_ids(&data), vec!["a", "b"]);
    }

    async fn local_response(reply: Vec<u8>) -> Response {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request).await;
            let _ = stream.write_all(&reply).await;
        });
        http_client(Duration::from_secs(3)).unwrap().get(format!("http://{address}")).send().await.unwrap()
    }

    #[tokio::test]
    async fn bounded_response_accepts_json_and_rejects_declared_oversize() {
        let valid = local_response(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}".to_vec()).await;
        assert_eq!(response_json(valid).await.unwrap()["ok"], true);
        let large = local_response(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_AI_RESPONSE_BYTES + 1).into_bytes()).await;
        assert!(bounded_body(large).await.unwrap_err().contains("2 MiB"));
    }

    #[tokio::test]
    async fn bounded_response_rejects_oversize_without_content_length() {
        let mut reply = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        reply.resize(reply.len() + MAX_AI_RESPONSE_BYTES + 1, b'a');
        assert!(bounded_body(local_response(reply).await).await.unwrap_err().contains("2 MiB"));
    }

    #[tokio::test]
    async fn redirect_is_not_followed_and_returns_recovery_instruction() {
        let response = local_response(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()).await;
        assert_eq!(response.status(), StatusCode::FOUND);
        assert!(response_error(response, "AI 服务", "test-key").await.contains("最终 API 地址"));
    }
}
