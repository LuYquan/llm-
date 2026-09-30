use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::logger::get_app_dir;
use crate::model::SerialSettings;
use crate::protocol::ProtocolConfig;

pub const CURRENT_CONFIG_VERSION: u32 = 2;
const MAX_CONFIG_BYTES: u64 = 512 * 1024;
static CONFIG_SAVE_LOCK: Mutex<()> = Mutex::new(());

fn default_config_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AppConfig {
    #[serde(default = "default_config_version")]
    pub schema_version: u32,
    pub port_name: Option<String>,
    pub baud_rate: u32,
    pub mode: String,       // "mock" | "serial"
    pub active_tab: String, // "debug" | "waveform"
    pub ai_config: AiConfig,
    pub channel_mapping: ChannelMapping,
    pub quick_commands: Vec<QuickCommand>,
    pub emergency_command: Option<String>,
    pub serial_settings: SerialSettings,
    pub protocol_config: ProtocolConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AiConfig {
    pub provider: String, // "deepseek" | "openai" | "ollama"
    #[serde(default)]
    pub api_key_configured: bool,
    pub api_key: String,
    pub api_url: String,
    pub model: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: "deepseek".to_string(),
            api_key_configured: false,
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
            schema_version: CURRENT_CONFIG_VERSION,
            port_name: None,
            baud_rate: 115200,
            mode: "serial".to_string(),
            active_tab: "waveform".to_string(),
            ai_config: AiConfig::default(),
            channel_mapping: ChannelMapping::default(),
            // Device-specific commands require explicit user configuration.
            quick_commands: vec![],
            emergency_command: None,
            serial_settings: SerialSettings::default(),
            protocol_config: ProtocolConfig::default(),
        }
    }
}

pub fn get_config_path() -> PathBuf {
    get_app_dir().join("config.json")
}

/// 从 %APPDATA%/LLM-Serial/config.json 读取配置，失败则返回默认值
pub fn load_config() -> AppConfig {
    load_config_checked().unwrap_or_else(|error| {
        tracing::warn!("Failed to load config.json, using defaults: {}", error);
        AppConfig::default()
    })
}

/// Load without replacing a malformed file with defaults. Commands that
/// expose configuration to the UI use this path so the user can recover the
/// original JSON instead of losing it on the next autosave.
pub fn load_config_checked() -> Result<AppConfig, String> {
    load_config_at(&get_config_path())
}

fn load_config_at(target: &Path) -> Result<AppConfig, String> {
    // Recover an interrupted replacement from older builds in memory. Preserve
    // the backup on disk until a successful user save creates the primary file.
    let backup = target.with_extension("json.replace-backup");
    let path = if !target.exists() && backup.exists() { backup.as_path() } else { target };
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    if fs::metadata(path).map_err(|e| format!("无法读取配置元数据：{e}"))?.len() > MAX_CONFIG_BYTES {
        return Err("配置文件超过 512 KiB；原文件已保留，请检查配置内容".to_string());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("读取配置文件失败 [{}]: {error}", path.display()))?;
    let mut config = serde_json::from_str::<AppConfig>(&content)
        .map_err(|error| format!("配置文件格式无效 [{}]: {error}", path.display()))?;
    if config.schema_version > CURRENT_CONFIG_VERSION {
        return Err(format!(
            "配置文件版本 {} 高于当前支持的 {}；原文件已保留",
            config.schema_version, CURRENT_CONFIG_VERSION
        ));
    }
    // Version 1 used the same fields but had no explicit migration marker.
    // Normalize it in memory; the new version is written only after a valid
    // user save.
    config.schema_version = CURRENT_CONFIG_VERSION;
    Ok(config)
}

/// 保存配置到 %APPDATA%/LLM-Serial/config.json
pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let _guard = CONFIG_SAVE_LOCK.lock().map_err(|_| "配置存储暂不可用，请重启后重试".to_string())?;
    let path = get_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
    }

    // Defense in depth: API keys are stored by the secrets service, never in config.json.
    let mut persisted = config_without_secrets(config);
    persisted.schema_version = CURRENT_CONFIG_VERSION;
    let json = serde_json::to_string_pretty(&persisted).map_err(|e| e.to_string())?;
    let temp_path = path.with_extension("json.tmp");
    if json.len() as u64 > MAX_CONFIG_BYTES {
        return Err("配置超过 512 KiB，未覆盖已保存的配置".to_string());
    }
    let mut temporary = fs::File::create(&temp_path).map_err(|e| format!("创建临时配置失败：{e}"))?;
    temporary.write_all(json.as_bytes()).map_err(|e| format!("写入临时配置失败：{e}"))?;
    temporary.sync_all().map_err(|e| format!("同步临时配置失败：{e}"))?;
    drop(temporary);
    replace_config_file(&temp_path, &path)?;
    tracing::debug!("App config successfully persisted to {}", path.display());
    Ok(())
}

fn replace_config_file(temp_path: &PathBuf, target_path: &PathBuf) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        fs::rename(temp_path, target_path)
            .map_err(|e| format!("Failed to replace config.json atomically: {e}"))
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
        }
        let source: Vec<u16> = temp_path.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target_path.as_os_str().encode_wide().chain(Some(0)).collect();
        // Same-directory replacement removes the interval where no primary file
        // exists. WRITE_THROUGH completes the operation before reporting success.
        let success = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0x1 | 0x8) };
        if success == 0 {
            Err(format!("替换配置失败，原配置已保留：{}", std::io::Error::last_os_error()))
        } else {
            Ok(())
        }
    }
}

fn config_without_secrets(config: &AppConfig) -> AppConfig {
    let mut persisted = config.clone();
    persisted.ai_config.api_key.clear();
    persisted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("llm-config-{name}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn interrupted_legacy_replacement_recovers_backup_without_overwriting_it() {
        let directory = isolated_directory("recovery");
        let target = directory.join("config.json");
        let backup = target.with_extension("json.replace-backup");
        let original = r#"{"port_name":"COM9","baud_rate":230400}"#;
        fs::write(&backup, original).unwrap();
        let config = load_config_at(&target).unwrap();
        assert_eq!(config.port_name.as_deref(), Some("COM9"));
        assert_eq!(config.baud_rate, 230400);
        assert!(!target.exists());
        assert_eq!(fs::read_to_string(backup).unwrap(), original);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn replacement_updates_existing_file_and_failure_preserves_original() {
        let directory = isolated_directory("replace");
        let target = directory.join("config.json");
        let temporary = directory.join("config.json.tmp");
        fs::write(&target, "old").unwrap();
        fs::write(&temporary, "new").unwrap();
        replace_config_file(&temporary, &target).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        assert!(replace_config_file(&temporary, &target).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn corrupt_primary_is_reported_instead_of_using_defaults_or_backup() {
        let directory = isolated_directory("corrupt");
        let target = directory.join("config.json");
        fs::write(&target, "broken").unwrap();
        fs::write(target.with_extension("json.replace-backup"), "{}").unwrap();
        assert!(load_config_at(&target).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "broken");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn test_default_config() {
        let config = AppConfig::default();
        assert_eq!(config.schema_version, CURRENT_CONFIG_VERSION);
        assert_eq!(config.baud_rate, 115200);
        assert_eq!(config.mode, "serial");
        assert_eq!(config.active_tab, "waveform");
        assert_eq!(config.channel_mapping.target, "setpoint");
        assert!(config.quick_commands.is_empty());
        assert_eq!(config.emergency_command, None);
        assert_eq!(config.serial_settings, SerialSettings::default());
        assert_eq!(config.protocol_config, ProtocolConfig::default());
    }

    #[test]
    fn test_config_serialization() {
        let mut config = AppConfig::default();
        config.port_name = Some("COM4".to_string());
        config.baud_rate = 921600;
        config.active_tab = "debug".to_string();
        config.emergency_command = Some("CMD:STOP\\n".to_string());
        config.serial_settings = SerialSettings {
            data_bits: 7,
            parity: crate::model::SerialParity::Even,
            stop_bits: 2,
            flow_control: crate::model::SerialFlowControl::Hardware,
        };

        let json = serde_json::to_string(&config).expect("Serialization failed");
        let deserialized: AppConfig = serde_json::from_str(&json).expect("Deserialization failed");

        assert_eq!(config, deserialized);
        assert_eq!(deserialized.port_name, Some("COM4".to_string()));
        assert_eq!(deserialized.baud_rate, 921600);
        assert_eq!(deserialized.active_tab, "debug");
        assert_eq!(
            deserialized.emergency_command,
            Some("CMD:STOP\\n".to_string())
        );
        assert_eq!(deserialized.serial_settings, config.serial_settings);
    }

    #[test]
    fn test_plain_config_persistence_removes_api_key() {
        let mut cfg = AppConfig::default();
        cfg.ai_config.api_key = "sk-private-test-value".to_string();

        let serialized = serde_json::to_string(&config_without_secrets(&cfg)).unwrap();

        assert!(!serialized.contains("sk-private-test-value"));
        assert!(serialized.contains("\"api_key\":\"\""));
        assert_eq!(cfg.ai_config.api_key, "sk-private-test-value");
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
        let config: AppConfig =
            serde_json::from_str(partial_json).expect("Partial json should deserialize");
        assert_eq!(config.port_name, Some("COM8".to_string()));
        assert_eq!(config.schema_version, 1);
        assert_eq!(config.baud_rate, 230400);
        assert_eq!(config.mode, "serial");
        assert_eq!(config.active_tab, "waveform");
        assert_eq!(config.ai_config.provider, "deepseek");
        assert_eq!(config.channel_mapping.target, "setpoint");
    }

    #[test]
    fn checked_loader_normalizes_legacy_version_without_overwriting_file() {
        let mut config: AppConfig = serde_json::from_str(r#"{"port_name":"COM9"}"#).unwrap();
        assert_eq!(config.schema_version, 1);
        config.schema_version = CURRENT_CONFIG_VERSION;
        assert_eq!(config.port_name.as_deref(), Some("COM9"));
    }
}
