//! Declarative protocol configuration and bounded binary stream parser.
//!
//! FireWater remains handled by the existing text demultiplexer so its CSV,
//! Teleplot alignment, and log routing stay compatible. This module handles
//! protocols whose payload is binary and never decodes the raw RX bytes.

use serde::{Deserialize, Serialize};

const MAX_FRAME_BYTES: usize = 65_536;
const INPUT_SLICE_BYTES: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProtocolConfig {
    Firewater,
    Justfloat {
        channels: Option<usize>,
    },
    Rawdata {
        mode: RawDataMode,
        format: DataFormat,
        channels: usize,
    },
    #[serde(rename = "custom")]
    CustomFrame {
        header: Vec<u8>,
        #[serde(default)]
        tail: Vec<u8>,
        channels: usize,
        #[serde(rename = "dataType")]
        data_type: DataFormat,
        checksum: ChecksumType,
        #[serde(rename = "checksumByteOrder")]
        checksum_byte_order: ByteOrder,
    },
}

impl Default for ProtocolConfig {
    fn default() -> Self {
        Self::Firewater
    }
}

impl ProtocolConfig {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Firewater => Ok(()),
            Self::Justfloat { channels } => {
                if channels.is_some_and(|count| !(1..=64).contains(&count)) {
                    return Err("JustFloat 通道数必须在 1 到 64 之间".to_string());
                }
                Ok(())
            }
            Self::Rawdata {
                mode: _,
                format: _,
                channels,
            } => validate_channels(*channels),
            Self::CustomFrame {
                header,
                tail,
                channels,
                data_type,
                checksum,
                ..
            } => {
                validate_channels(*channels)?;
                if header.is_empty() || header.len() > 64 {
                    return Err("CustomFrame 帧头长度必须在 1 到 64 字节之间".to_string());
                }
                if tail.len() > 64 {
                    return Err("CustomFrame 帧尾最多 64 字节".to_string());
                }
                let checksum_bytes = checksum.byte_len();
                let frame_size = header
                    .len()
                    .saturating_add(data_type.byte_len().saturating_mul(*channels))
                    .saturating_add(checksum_bytes)
                    .saturating_add(tail.len());
                if frame_size > MAX_FRAME_BYTES {
                    return Err("CustomFrame 总长度超过 64 KiB 上限".to_string());
                }
                Ok(())
            }
        }
    }

    fn is_raw_display(&self) -> bool {
        matches!(
            self,
            Self::Rawdata {
                mode: RawDataMode::Display,
                ..
            }
        )
    }
}

fn validate_channels(channels: usize) -> Result<(), String> {
    if !(1..=64).contains(&channels) {
        return Err("通道数必须在 1 到 64 之间".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RawDataMode {
    Display,
    Decode,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DataFormat {
    U8,
    I8,
    U16le,
    U16be,
    I16le,
    I16be,
    U32le,
    U32be,
    I32le,
    I32be,
    F32le,
    F32be,
    F64le,
    F64be,
}

impl DataFormat {
    fn byte_len(self) -> usize {
        match self {
            Self::U8 | Self::I8 => 1,
            Self::U16le | Self::U16be | Self::I16le | Self::I16be => 2,
            Self::U32le | Self::U32be | Self::I32le | Self::I32be | Self::F32le | Self::F32be => 4,
            Self::F64le | Self::F64be => 8,
        }
    }

    fn read(self, bytes: &[u8]) -> Option<f64> {
        let value = match self {
            Self::U8 => *bytes.first()? as f64,
            Self::I8 => (*bytes.first()? as i8) as f64,
            Self::U16le => u16::from_le_bytes(bytes.get(..2)?.try_into().ok()?) as f64,
            Self::U16be => u16::from_be_bytes(bytes.get(..2)?.try_into().ok()?) as f64,
            Self::I16le => i16::from_le_bytes(bytes.get(..2)?.try_into().ok()?) as f64,
            Self::I16be => i16::from_be_bytes(bytes.get(..2)?.try_into().ok()?) as f64,
            Self::U32le => u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as f64,
            Self::U32be => u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?) as f64,
            Self::I32le => i32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as f64,
            Self::I32be => i32::from_be_bytes(bytes.get(..4)?.try_into().ok()?) as f64,
            Self::F32le => f32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as f64,
            Self::F32be => f32::from_be_bytes(bytes.get(..4)?.try_into().ok()?) as f64,
            Self::F64le => f64::from_le_bytes(bytes.get(..8)?.try_into().ok()?),
            Self::F64be => f64::from_be_bytes(bytes.get(..8)?.try_into().ok()?),
        };
        value.is_finite().then_some(value)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChecksumType {
    None,
    Sum8,
    Xor8,
    #[serde(rename = "crc16_modbus")]
    Crc16Modbus,
    #[serde(rename = "crc16_ccitt")]
    Crc16Ccitt,
}

impl ChecksumType {
    fn byte_len(self) -> usize {
        match self {
            Self::None => 0,
            Self::Sum8 | Self::Xor8 => 1,
            Self::Crc16Modbus | Self::Crc16Ccitt => 2,
        }
    }

    fn calculate(self, bytes: &[u8]) -> u16 {
        match self {
            Self::None => 0,
            Self::Sum8 => {
                bytes
                    .iter()
                    .fold(0u16, |sum, byte| sum.wrapping_add(*byte as u16))
                    & 0xff
            }
            Self::Xor8 => bytes.iter().fold(0u16, |sum, byte| sum ^ *byte as u16),
            Self::Crc16Modbus => {
                let mut crc = 0xffffu16;
                for byte in bytes {
                    crc ^= *byte as u16;
                    for _ in 0..8 {
                        crc = if crc & 1 != 0 {
                            (crc >> 1) ^ 0xa001
                        } else {
                            crc >> 1
                        };
                    }
                }
                crc
            }
            Self::Crc16Ccitt => {
                let mut crc = 0u16;
                for byte in bytes {
                    crc ^= (*byte as u16) << 8;
                    for _ in 0..8 {
                        crc = if crc & 0x8000 != 0 {
                            (crc << 1) ^ 0x1021
                        } else {
                            crc << 1
                        };
                    }
                }
                crc
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ByteOrder {
    Little,
    Big,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProtocolOutput {
    pub frames: Vec<Vec<f64>>,
    pub dropped_bytes: u64,
    pub error_count: u64,
}

#[derive(Debug, Clone)]
pub struct BinaryProtocolParser {
    config: ProtocolConfig,
    buffer: Vec<u8>,
}

impl BinaryProtocolParser {
    pub fn new(config: ProtocolConfig) -> Result<Self, String> {
        config.validate()?;
        Ok(Self {
            config,
            buffer: Vec::new(),
        })
    }

    pub fn set_config(&mut self, config: ProtocolConfig) -> Result<(), String> {
        config.validate()?;
        if self.config != config {
            self.config = config;
            self.buffer.clear();
        }
        Ok(())
    }

    pub fn reset(&mut self) {
        self.buffer.clear();
    }

    pub fn feed(&mut self, chunk: &[u8]) -> ProtocolOutput {
        if chunk.is_empty() || self.config.is_raw_display() {
            return ProtocolOutput::default();
        }
        let mut output = ProtocolOutput::default();
        for part in chunk.chunks(INPUT_SLICE_BYTES) {
            self.buffer.extend_from_slice(part);
            let config = self.config.clone();
            match config {
                ProtocolConfig::Firewater => {}
                ProtocolConfig::Justfloat { channels } => {
                    self.parse_justfloat(channels, &mut output)
                }
                ProtocolConfig::Rawdata {
                    mode: RawDataMode::Decode,
                    format,
                    channels,
                } => self.parse_rawdata(format, channels, &mut output),
                ProtocolConfig::Rawdata {
                    mode: RawDataMode::Display,
                    ..
                } => self.buffer.clear(),
                ProtocolConfig::CustomFrame {
                    header,
                    tail,
                    channels,
                    data_type,
                    checksum,
                    checksum_byte_order,
                } => self.parse_custom(
                    &header,
                    &tail,
                    channels,
                    data_type,
                    checksum,
                    checksum_byte_order,
                    &mut output,
                ),
            }
            self.enforce_buffer_limit(&mut output);
        }
        output
    }

    fn parse_justfloat(&mut self, expected_channels: Option<usize>, output: &mut ProtocolOutput) {
        const TAIL: [u8; 4] = [0, 0, 0x80, 0x7f];
        let mut cursor = 0usize;
        let mut consumed = 0usize;
        while cursor + TAIL.len() <= self.buffer.len() {
            let Some(relative) = self.buffer[cursor..]
                .windows(TAIL.len())
                .position(|window| window == TAIL)
            else {
                break;
            };
            let tail_at = cursor + relative;
            let payload = &self.buffer[consumed..tail_at];
            if !payload.is_empty() {
                // Drop a non-float32-aligned prefix so a corrupt byte before a
                // valid frame cannot poison the following frame. This is the
                // same resynchronization rule as the Web parser.
                let remainder = payload.len() % 4;
                let mut valid_start = remainder;
                let mut valid_len = payload.len().saturating_sub(remainder);
                if remainder > 0 {
                    output.error_count += 1;
                    output.dropped_bytes += remainder as u64;
                }

                if let Some(count) = expected_channels {
                    let expected_bytes = count * 4;
                    if valid_len > expected_bytes {
                        let extra = valid_len - expected_bytes;
                        output.error_count += 1;
                        output.dropped_bytes += extra as u64;
                        valid_start += extra;
                        valid_len = expected_bytes;
                    }
                }

                let valid = valid_len >= 4
                    && valid_len % 4 == 0
                    && expected_channels.map_or(true, |count| valid_len == count * 4);
                if valid {
                    let valid_payload = &payload[valid_start..valid_start + valid_len];
                    let values = valid_payload
                        .chunks_exact(4)
                        .map(|bytes| {
                            f32::from_le_bytes(bytes.try_into().expect("four-byte chunk")) as f64
                        })
                        .collect::<Vec<_>>();
                    if values.iter().all(|value| value.is_finite()) {
                        output.frames.push(values);
                    } else {
                        output.error_count += 1;
                        output.dropped_bytes += valid_len as u64;
                    }
                } else if valid_len > 0 {
                    output.error_count += 1;
                    output.dropped_bytes += valid_len as u64;
                }
            }
            consumed = tail_at + TAIL.len();
            cursor = consumed;
        }
        if consumed > 0 {
            self.buffer.drain(..consumed);
        }
    }

    fn parse_rawdata(&mut self, format: DataFormat, channels: usize, output: &mut ProtocolOutput) {
        let sample_bytes = format.byte_len();
        let frame_bytes = sample_bytes * channels;
        let complete_bytes = self.buffer.len() / frame_bytes * frame_bytes;
        for frame in self.buffer[..complete_bytes].chunks_exact(frame_bytes) {
            let values = frame
                .chunks_exact(sample_bytes)
                .filter_map(|sample| format.read(sample))
                .collect::<Vec<_>>();
            if values.len() == channels {
                output.frames.push(values);
            } else {
                output.error_count += 1;
                output.dropped_bytes += frame_bytes as u64;
            }
        }
        if complete_bytes > 0 {
            self.buffer.drain(..complete_bytes);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn parse_custom(
        &mut self,
        header: &[u8],
        tail: &[u8],
        channels: usize,
        data_type: DataFormat,
        checksum: ChecksumType,
        checksum_byte_order: ByteOrder,
        output: &mut ProtocolOutput,
    ) {
        let payload_bytes = data_type.byte_len() * channels;
        let checksum_bytes = checksum.byte_len();
        let frame_bytes = header.len() + payload_bytes + checksum_bytes + tail.len();
        let mut cursor = 0usize;
        while cursor + frame_bytes <= self.buffer.len() {
            if self.buffer[cursor..cursor + header.len()] != *header {
                cursor += 1;
                output.dropped_bytes += 1;
                continue;
            }
            let payload_start = cursor + header.len();
            let payload_end = payload_start + payload_bytes;
            let checksum_end = payload_end + checksum_bytes;
            let tail_end = checksum_end + tail.len();
            if !tail.is_empty() && self.buffer[checksum_end..tail_end] != *tail {
                cursor += 1;
                output.dropped_bytes += 1;
                output.error_count += 1;
                continue;
            }
            if checksum_bytes > 0 {
                let expected = checksum.calculate(&self.buffer[payload_start..payload_end]);
                let actual = if checksum_bytes == 1 {
                    self.buffer[payload_end] as u16
                } else {
                    let bytes = [self.buffer[payload_end], self.buffer[payload_end + 1]];
                    match checksum_byte_order {
                        ByteOrder::Little => u16::from_le_bytes(bytes),
                        ByteOrder::Big => u16::from_be_bytes(bytes),
                    }
                };
                if expected != actual {
                    cursor += 1;
                    output.dropped_bytes += 1;
                    output.error_count += 1;
                    continue;
                }
            }
            let values = self.buffer[payload_start..payload_end]
                .chunks_exact(data_type.byte_len())
                .filter_map(|sample| data_type.read(sample))
                .collect::<Vec<_>>();
            if values.len() == channels {
                output.frames.push(values);
            } else {
                output.error_count += 1;
                output.dropped_bytes += frame_bytes as u64;
            }
            cursor += frame_bytes;
        }
        if cursor > 0 {
            self.buffer.drain(..cursor);
        }
    }

    fn enforce_buffer_limit(&mut self, output: &mut ProtocolOutput) {
        if self.buffer.len() <= MAX_FRAME_BYTES {
            return;
        }
        let preserve = match &self.config {
            ProtocolConfig::Justfloat { .. } => 3,
            ProtocolConfig::Rawdata {
                format, channels, ..
            } => format.byte_len() * channels.saturating_sub(1).max(1),
            ProtocolConfig::CustomFrame { header, .. } => header.len().saturating_sub(1),
            ProtocolConfig::Firewater => 0,
        }
        .min(MAX_FRAME_BYTES);
        let drop_count = self.buffer.len().saturating_sub(preserve);
        self.buffer.drain(..drop_count);
        output.dropped_bytes += drop_count as u64;
        output.error_count += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn justfloat_is_invariant_to_single_byte_chunks_and_rejects_non_finite_values() {
        let mut parser =
            BinaryProtocolParser::new(ProtocolConfig::Justfloat { channels: Some(2) }).unwrap();
        let mut wire = Vec::new();
        wire.extend_from_slice(&1.25f32.to_le_bytes());
        wire.extend_from_slice(&(-2.5f32).to_le_bytes());
        wire.extend_from_slice(&[0, 0, 0x80, 0x7f]);
        let mut output = ProtocolOutput::default();
        for byte in &wire {
            let next = parser.feed(std::slice::from_ref(byte));
            output.frames.extend(next.frames);
            output.dropped_bytes += next.dropped_bytes;
            output.error_count += next.error_count;
        }
        assert_eq!(output.frames, vec![vec![1.25, -2.5]]);

        let mut non_finite = f32::NAN.to_le_bytes().to_vec();
        non_finite.extend_from_slice(&0.0f32.to_le_bytes());
        non_finite.extend_from_slice(&[0, 0, 0x80, 0x7f]);
        let rejected = parser.feed(&non_finite);
        assert!(rejected.frames.is_empty());
        assert_eq!(rejected.error_count, 1);
    }

    #[test]
    fn justfloat_resynchronizes_dirty_prefix_and_preserves_declared_channel_count() {
        let mut parser = BinaryProtocolParser::new(ProtocolConfig::Justfloat { channels: None }).unwrap();
        let mut wire = vec![0xee, 0xff];
        wire.extend_from_slice(&1.5f32.to_le_bytes());
        wire.extend_from_slice(&2.5f32.to_le_bytes());
        wire.extend_from_slice(&3.5f32.to_le_bytes());
        wire.extend_from_slice(&[0, 0, 0x80, 0x7f]);
        let output = parser.feed(&wire);
        assert_eq!(output.frames, vec![vec![1.5, 2.5, 3.5]]);
        assert_eq!(output.dropped_bytes, 2);
        assert_eq!(output.error_count, 1);

        let mut fixed = BinaryProtocolParser::new(ProtocolConfig::Justfloat { channels: Some(2) }).unwrap();
        let mut fixed_wire = Vec::new();
        fixed_wire.extend_from_slice(&1.0f32.to_le_bytes());
        fixed_wire.extend_from_slice(&2.0f32.to_le_bytes());
        fixed_wire.extend_from_slice(&3.0f32.to_le_bytes());
        fixed_wire.extend_from_slice(&[0, 0, 0x80, 0x7f]);
        let fixed_output = fixed.feed(&fixed_wire);
        assert_eq!(fixed_output.frames, vec![vec![2.0, 3.0]]);
        assert_eq!(fixed_output.dropped_bytes, 4);
        assert_eq!(fixed_output.error_count, 1);
    }

    #[test]
    fn rawdata_decodes_complete_frames_and_keeps_partial_bytes() {
        let mut parser = BinaryProtocolParser::new(ProtocolConfig::Rawdata {
            mode: RawDataMode::Decode,
            format: DataFormat::I16le,
            channels: 2,
        })
        .unwrap();
        assert!(parser.feed(&[1, 0]).frames.is_empty());
        let output = parser.feed(&[0xfe, 0xff, 9, 0, 0]);
        assert_eq!(output.frames, vec![vec![1.0, -2.0]]);
        assert_eq!(parser.feed(&[0]).frames, vec![vec![9.0, 0.0]]);
    }

    #[test]
    fn custom_frame_validates_checksum_endianness_and_resynchronizes() {
        let config = ProtocolConfig::CustomFrame {
            header: vec![0xaa, 0x55],
            tail: vec![0x0d, 0x0a],
            channels: 2,
            data_type: DataFormat::I16le,
            checksum: ChecksumType::Crc16Ccitt,
            checksum_byte_order: ByteOrder::Big,
        };
        let payload = [1u8, 0, 0xfe, 0xff];
        let crc = ChecksumType::Crc16Ccitt.calculate(&payload).to_be_bytes();
        let mut wire = vec![0xaa, 0x55];
        wire.extend_from_slice(&payload);
        wire.extend_from_slice(&crc);
        wire.extend_from_slice(&[0x0d, 0x0a]);
        let mut parser = BinaryProtocolParser::new(config).unwrap();
        let output = parser.feed(&wire);
        assert_eq!(output.frames, vec![vec![1.0, -2.0]]);

        wire[6] ^= 1;
        let rejected = parser.feed(&wire);
        assert!(rejected.frames.is_empty());
        assert!(rejected.error_count > 0);
    }

    #[test]
    fn raw_display_does_not_interpret_bytes_as_waveform_values() {
        let mut parser = BinaryProtocolParser::new(ProtocolConfig::Rawdata {
            mode: RawDataMode::Display,
            format: DataFormat::U8,
            channels: 1,
        })
        .unwrap();
        assert!(parser.feed(&[0, 0xff, b'\n']).frames.is_empty());
    }

    #[test]
    fn rejects_out_of_range_custom_frame_configuration() {
        let config = ProtocolConfig::CustomFrame {
            header: vec![],
            tail: vec![],
            channels: 1,
            data_type: DataFormat::F32le,
            checksum: ChecksumType::None,
            checksum_byte_order: ByteOrder::Little,
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn deserializes_shared_web_protocol_configuration_shape() {
        let justfloat: ProtocolConfig = serde_json::from_value(serde_json::json!({
            "type": "justfloat", "channels": 2
        }))
        .unwrap();
        assert_eq!(justfloat, ProtocolConfig::Justfloat { channels: Some(2) });

        let rawdata: ProtocolConfig = serde_json::from_value(serde_json::json!({
            "type": "rawdata", "mode": "decode", "format": "i16le", "channels": 2
        }))
        .unwrap();
        assert_eq!(
            rawdata,
            ProtocolConfig::Rawdata {
                mode: RawDataMode::Decode,
                format: DataFormat::I16le,
                channels: 2,
            }
        );

        let custom: ProtocolConfig = serde_json::from_value(serde_json::json!({
            "type": "custom", "header": [170, 85], "tail": [13, 10],
            "channels": 2, "dataType": "i16le", "checksum": "crc16_ccitt",
            "checksumByteOrder": "big"
        }))
        .unwrap();
        assert_eq!(
            custom,
            ProtocolConfig::CustomFrame {
                header: vec![0xaa, 0x55],
                tail: vec![0x0d, 0x0a],
                channels: 2,
                data_type: DataFormat::I16le,
                checksum: ChecksumType::Crc16Ccitt,
                checksum_byte_order: ByteOrder::Big,
            }
        );
    }
}
