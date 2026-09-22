use serde::{Deserialize, Serialize};
use serialport::{available_ports, SerialPortType};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SerialPortInfo {
    pub port_name: String,
    pub port_type: String, // "USB", "PCI", "Bluetooth", "Unknown"
    pub description: Option<String>,
    pub manufacturer: Option<String>,
}

/// 枚举系统当前可用的物理串口与虚拟串口 (Step 2.3)
pub fn enumerate_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    let ports = available_ports().map_err(|e| format!("枚举串口失败: {}", e))?;
    let mut result = Vec::new();

    for p in ports {
        let (port_type, description, manufacturer) = match p.port_type {
            SerialPortType::UsbPort(info) => (
                "USB".to_string(),
                info.product.clone(),
                info.manufacturer.clone(),
            ),
            SerialPortType::PciPort => ("PCI".to_string(), None, None),
            SerialPortType::BluetoothPort => ("Bluetooth".to_string(), None, None),
            SerialPortType::Unknown => ("Unknown".to_string(), None, None),
        };

        result.push(SerialPortInfo {
            port_name: p.port_name,
            port_type,
            description,
            manufacturer,
        });
    }

    // 自然数字排序 (COM1 < COM2 < COM10)
    result.sort_by(|a, b| {
        let num_a = a.port_name.trim_start_matches(|c: char| !c.is_ascii_digit()).parse::<u32>().ok();
        let num_b = b.port_name.trim_start_matches(|c: char| !c.is_ascii_digit()).parse::<u32>().ok();
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
            },
            SerialPortInfo {
                port_name: "COM2".to_string(),
                port_type: "USB".to_string(),
                description: None,
                manufacturer: None,
            },
            SerialPortInfo {
                port_name: "COM1".to_string(),
                port_type: "USB".to_string(),
                description: None,
                manufacturer: None,
            },
        ];

        ports.sort_by(|a, b| {
            let num_a = a.port_name.trim_start_matches(|c: char| !c.is_ascii_digit()).parse::<u32>().ok();
            let num_b = b.port_name.trim_start_matches(|c: char| !c.is_ascii_digit()).parse::<u32>().ok();
            match (num_a, num_b) {
                (Some(na), Some(nb)) => na.cmp(&nb),
                _ => a.port_name.cmp(&b.port_name),
            }
        });

        assert_eq!(ports[0].port_name, "COM1");
        assert_eq!(ports[1].port_name, "COM2");
        assert_eq!(ports[2].port_name, "COM10");
    }
}
