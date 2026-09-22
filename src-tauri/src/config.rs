use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

use crate::logger::get_app_dir;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AppConfig {
    pub port_name: Option<String>,
    pub baud_rate: u32,
    pub mode: String,          // "mock" | "serial"
    pub active_tab: String,    // "debug" | "waveform"
    pub ai_config: AiConfig,
    pub channel_mapping: ChannelMapping,
    pub quick_commands: Vec<QuickCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AiConfig {
    pub provider: String,      // "deepseek" | "openai" | "ollama"
    pub api_key: String,
    pub api_url: String,
    pub model: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: "deepseek".to_string(),
            api_key: "".to_string(),
            api_url: "https://api.deepseek.com/v1".to_string(),
            model: "deepseek-chat".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ChannelMapping {
    pub target: String,
    pub actual: String,
    pub output: String,
}

impl Default for ChannelMapping {
    fn default() -> Self {
        Self {
            target: "setpoint".to_string(),
            actual: "actual".to_string(),
            output: "output".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct QuickCommand {
    pub id: String,
    pub name: String,
    pub command: String,
    pub is_hex: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            port_name: None,
            baud_rate: 115200,
            mode: "mock".to_string(),
            active_tab: "waveform".to_string(),
            ai_config: AiConfig::default(),
            channel_mapping: ChannelMapping::default(),
            quick_commands: vec![
                QuickCommand {
                    id: "cmd_rst".to_string(),
                    name: "复位".to_string(),
                    command: "RST\\n".to_string(),
                    is_hex: false,
                },
                QuickCommand {
                    id: "cmd_calib".to_string(),
                    name: "校准".to_string(),
                    command: "CALIB\\n".to_string(),
                    is_hex: false,
                },
                QuickCommand {
                    id: "cmd_stop".to_string(),
                    name: "急停".to_string(),
                    command: "CMD:STOP\\n".to_string(),
                    is_hex: false,
                },
            ],
        }
    }
}

pub fn get_config_path() -> PathBuf {
    get_app_dir().join("config.json")
}

/// 从 %APPDATA%/LLM-Serial/config.json 读取配置，失败则返回默认值
pub fn load_config() -> AppConfig {
    let path = get_config_path();
    if !path.exists() {
        return AppConfig::default();
    }

    match fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<AppConfig>(&content) {
            Ok(cfg) => cfg,
            Err(e) => {
                tracing::warn!("Failed to parse config.json, using default: {}", e);
                AppConfig::default()
            }
        },
        Err(e) => {
            tracing::warn!("Failed to read config.json, using default: {}", e);
            AppConfig::default()
        }
    }
}

/// 保存配置到 %APPDATA%/LLM-Serial/config.json
pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = get_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("Failed to write config.json: {}", e))?;
    tracing::debug!("App config successfully persisted to {}", path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = AppConfig::default();
        assert_eq!(config.baud_rate, 115200);
        assert_eq!(config.mode, "mock");
        assert_eq!(config.active_tab, "waveform");
        assert_eq!(config.channel_mapping.target, "setpoint");
        assert_eq!(config.quick_commands.len(), 3);
    }

    #[test]
    fn test_config_serialization() {
        let mut config = AppConfig::default();
        config.port_name = Some("COM4".to_string());
        config.baud_rate = 921600;
        config.active_tab = "debug".to_string();

        let json = serde_json::to_string(&config).expect("Serialization failed");
        let deserialized: AppConfig = serde_json::from_str(&json).expect("Deserialization failed");

        assert_eq!(config, deserialized);
        assert_eq!(deserialized.port_name, Some("COM4".to_string()));
        assert_eq!(deserialized.baud_rate, 921600);
        assert_eq!(deserialized.active_tab, "debug");
    }

    #[test]
    fn test_save_and_load_config_roundtrip() {
        let temp_dir = std::env::temp_dir().join("llm_serial_test_config");
        let _ = fs::create_dir_all(&temp_dir);
        let test_file = temp_dir.join("test_config.json");

        let mut cfg = AppConfig::default();
        cfg.port_name = Some("COM7".to_string());
        cfg.baud_rate = 921600;
        cfg.active_tab = "debug".to_string();

        let json = serde_json::to_string_pretty(&cfg).unwrap();
        fs::write(&test_file, json).unwrap();

        let content = fs::read_to_string(&test_file).unwrap();
        let loaded: AppConfig = serde_json::from_str(&content).unwrap();

        assert_eq!(cfg, loaded);
        let _ = fs::remove_file(&test_file);
    }

    #[test]
    fn test_partial_config_deserialization_with_defaults() {
        // 模拟旧版本或缺失部分字段的 config.json，确保能正常解析且缺失字段自动填充默认值
        let partial_json = r#"{"port_name": "COM8", "baud_rate": 230400}"#;
        let config: AppConfig = serde_json::from_str(partial_json).expect("Partial json should deserialize");
        assert_eq!(config.port_name, Some("COM8".to_string()));
        assert_eq!(config.baud_rate, 230400);
        assert_eq!(config.mode, "mock");
        assert_eq!(config.active_tab, "waveform");
        assert_eq!(config.ai_config.provider, "deepseek");
        assert_eq!(config.channel_mapping.target, "setpoint");
    }
}

