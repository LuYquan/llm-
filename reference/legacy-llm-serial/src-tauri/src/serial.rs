use serde::{Deserialize, Serialize};
use serialport::{available_ports, SerialPortType};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SerialPortInfo {
    pub port_name: String,
    pub port_type: String, // "USB", "PCI", "Bluetooth", "Unknown"
    pub description: Option<String>,
    pub manufacturer: Option<String>,
    #[serde(default)]
    pub vid: Option<u16>,
    #[serde(default)]
    pub pid: Option<u16>,
}

/// 枚举系统当前可用的物理串口与虚拟串口 (Step 2.3)
pub fn enumerate_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    let ports = available_ports().map_err(|e| format!("枚举串口失败: {}", e))?;
    let mut result = Vec::new();

    for p in ports {
        let (port_type, description, manufacturer, vid, pid) = match p.port_type {
            SerialPortType::UsbPort(info) => (
                "USB".to_string(),
                info.product.clone(),
                info.manufacturer.clone(),
                Some(info.vid),
                Some(info.pid),
            ),
            SerialPortType::PciPort => ("PCI".to_string(), None, None, None, None),
            SerialPortType::BluetoothPort => ("Bluetooth".to_string(), None, None, None, None),
            SerialPortType::Unknown => ("Unknown".to_string(), None, None, None, None),
        };

        result.push(SerialPortInfo {
            port_name: p.port_name,
            port_type,
            description,
            manufacturer,
            vid,
            pid,
        });
    }

    // 自然数字排序 (COM1 < COM2 < COM10)
    result.sort_by(|a, b| {
        let num_a = a
            .port_name
            .trim_start_matches(|c: char| !c.is_ascii_digit())
            .parse::<u32>()
            .ok();
        let num_b = b
            .port_name
            .trim_start_matches(|c: char| !c.is_ascii_digit())
            .parse::<u32>()
            .ok();
        match (num_a, num_b) {
            (Some(na), Some(nb)) => na.cmp(&nb),
            _ => a.port_name.cmp(&b.port_name),
        }
    });

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_enumerate_ports_does_not_panic() {
        // 在 CI / 本地无物理串口环境下，enumerate_serial_ports 应当返回 Ok(vec![]) 或实际串口列表，绝不 panic
        let res = enumerate_serial_ports();
        assert!(res.is_ok());
    }

    #[test]
    fn test_port_natural_sorting() {
        let mut ports = vec![
            SerialPortInfo {
                port_name: "COM10".to_string(),
                port_type: "USB".to_string(),
                description: None,
                manufacturer: None,
                vid: None,
                pid: None,
            },
            SerialPortInfo {
                port_name: "COM2".to_string(),
                port_type: "USB".to_string(),
                description: None,
                manufacturer: None,
                vid: None,
                pid: None,
            },
            SerialPortInfo {
                port_name: "COM1".to_string(),
                port_type: "USB".to_string(),
                description: None,
                manufacturer: None,
                vid: None,
                pid: None,
            },
        ];

        ports.sort_by(|a, b| {
            let num_a = a
                .port_name
                .trim_start_matches(|c: char| !c.is_ascii_digit())
                .parse::<u32>()
                .ok();
            let num_b = b
                .port_name
                .trim_start_matches(|c: char| !c.is_ascii_digit())
                .parse::<u32>()
                .ok();
            match (num_a, num_b) {
                (Some(na), Some(nb)) => na.cmp(&nb),
                _ => a.port_name.cmp(&b.port_name),
            }
        });

        assert_eq!(ports[0].port_name, "COM1");
        assert_eq!(ports[1].port_name, "COM2");
        assert_eq!(ports[2].port_name, "COM10");
    }

    #[test]
    fn test_normalize_port_name_windows() {
        assert_eq!(normalize_port_name("COM1"), "COM1");
        assert_eq!(normalize_port_name("COM9"), "COM9");
        #[cfg(target_os = "windows")]
        {
            assert_eq!(normalize_port_name("COM10"), r"\\.\COM10");
            assert_eq!(normalize_port_name("com15"), r"\\.\com15");
            assert_eq!(normalize_port_name(r"\\.\COM10"), r"\\.\COM10");
        }
        assert_eq!(display_port_name(r"\\.\COM10"), "COM10");
        assert_eq!(display_port_name("COM3"), "COM3");
    }
}

/// 规范化串口名称，对 Windows 系统的 COM10 及以上端口自动补齐 `\\.\` 前缀，并统一格式
pub fn normalize_port_name(port_name: &str) -> String {
    let trimmed = port_name.trim();
    #[cfg(target_os = "windows")]
    {
        if trimmed.starts_with(r"\\.\") {
            return trimmed.to_string();
        }
        let upper = trimmed.to_uppercase();
        if upper.starts_with("COM") {
            if let Ok(num) = upper[3..].parse::<u32>() {
                if num >= 10 {
                    return format!(r"\\.\{}", trimmed);
                }
            }
        }
        trimmed.to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        trimmed.to_string()
    }
}

/// 获取用于界面显示的简短端口名 (如 \\.\COM10 -> COM10)
pub fn display_port_name(port_name: &str) -> String {
    let trimmed = port_name.trim();
    if let Some(stripped) = trimmed.strip_prefix(r"\\.\") {
        stripped.to_string()
    } else {
        trimmed.to_string()
    }
}
