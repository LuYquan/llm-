use llm_serial_lib::model::{LogDirection, LogLine};
use llm_serial_lib::pipeline::data_source::process_serial_bytes;
use llm_serial_lib::pipeline::demuxer::{DemuxOutput, StreamDemuxer};
use llm_serial_lib::pipeline::ring_buffer::SamplePoint;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

fn get_fixtures_dir() -> PathBuf {
    // 兼容从 workspace 根目录或 src-tauri 运行 cargo test
    let candidate1 = Path::new("..")
        .join("tests")
        .join("fixtures")
        .join("stream");
    let candidate2 = Path::new("tests").join("fixtures").join("stream");
    if candidate1.exists() {
        candidate1
    } else {
        candidate2
    }
}

/// 深度比对实际采样点与 expected.json 中的 samples 数组
fn assert_samples_match(actual: &[SamplePoint], expected_val: &serde_json::Value) {
    let exp_samples = expected_val["samples"]
        .as_array()
        .expect("expected.samples must be an array");
    assert_eq!(
        actual.len(),
        exp_samples.len(),
        "Sample count mismatch: expected {}, got {}",
        exp_samples.len(),
        actual.len()
    );
    for (i, (act_s, exp_s)) in actual.iter().zip(exp_samples.iter()).enumerate() {
        let exp_vals = exp_s["values"]
            .as_array()
            .expect("sample.values must be an array");
        assert_eq!(
            act_s.values.len(),
            exp_vals.len(),
            "Sample {} channel count mismatch: expected {}, got {}",
            i,
            exp_vals.len(),
            act_s.values.len()
        );
        for (ch, exp_v) in exp_vals.iter().enumerate() {
            match (act_s.values[ch], exp_v.as_f64()) {
                (Some(act), Some(exp)) => {
                    assert!(
                        (act - exp).abs() < 1e-4,
                        "Sample {} channel {} mismatch: expected {}, got {}",
                        i,
                        ch,
                        exp,
                        act
                    );
                }
                (None, None) => {
                    assert!(
                        exp_v.is_null(),
                        "Sample {} channel {} expected non-null but was None",
                        i,
                        ch
                    );
                }
                (act, exp) => {
                    panic!(
                        "Sample {} channel {} nullability mismatch: expected {:?}, got {:?}",
                        i, ch, exp, act
                    );
                }
            }
        }
    }
}

/// 深度比对实际日志与 expected.json 中的 logs 数组
fn assert_logs_match(actual: &[LogLine], expected_val: &serde_json::Value) {
    let exp_logs = expected_val["logs"]
        .as_array()
        .expect("expected.logs must be an array");
    assert_eq!(
        actual.len(),
        exp_logs.len(),
        "Log count mismatch: expected {}, got {}",
        exp_logs.len(),
        actual.len()
    );
    for (i, (act_l, exp_l)) in actual.iter().zip(exp_logs.iter()).enumerate() {
        let exp_text = exp_l["text"].as_str().expect("log.text must be string");
        let exp_level = exp_l["level"].as_str().expect("log.level must be string");
        assert_eq!(
            act_l.text, exp_text,
            "Log {} text mismatch: expected {:?}, got {:?}",
            i, exp_text, act_l.text
        );
        assert_eq!(
            format!("{:?}", act_l.level),
            exp_level,
            "Log {} level mismatch: expected {:?}, got {:?}",
            i,
            exp_level,
            act_l.level
        );
    }
}

/// 比对 summary 计数统计指标
fn assert_summary_match(
    dirty_counter: u64,
    demux_error_count: u64,
    actual_samples_len: usize,
    actual_logs_len: usize,
    expected_val: &serde_json::Value,
) {
    let summary = &expected_val["summary"];
    if let Some(exp_dirty) = summary["byte_dirty_count"].as_u64() {
        assert_eq!(dirty_counter, exp_dirty, "byte_dirty_count mismatch");
    }
    if let Some(exp_demux_err) = summary["demux_error_count"].as_u64() {
        assert_eq!(
            demux_error_count, exp_demux_err,
            "demux_error_count mismatch"
        );
    }
    if let Some(exp_sample_count) = summary["sample_count"].as_u64() {
        assert_eq!(
            actual_samples_len as u64, exp_sample_count,
            "sample_count mismatch"
        );
    }
    if let Some(exp_log_count) = summary["log_count"].as_u64() {
        assert_eq!(actual_logs_len as u64, exp_log_count, "log_count mismatch");
    }
}

#[test]
fn test_fixture_01_pure_csv() {
    let dir = get_fixtures_dir();
    let raw_bytes = fs::read(dir.join("01_pure_csv.raw")).expect("Failed to read 01_pure_csv.raw");
    let json_str = fs::read_to_string(dir.join("01_pure_csv.expected.json"))
        .expect("Failed to read 01_pure_csv.expected.json");
    let expected: serde_json::Value = serde_json::from_str(&json_str).unwrap();

    let mut line_buf = Vec::new();
    let dirty_counter = AtomicU64::new(0);
    let lines = process_serial_bytes(&raw_bytes, &mut line_buf, &dirty_counter);

    let exp_lines = expected["raw_lines"].as_array().unwrap();
    assert_eq!(lines.len(), exp_lines.len());
    for (i, exp_line) in exp_lines.iter().enumerate() {
        assert_eq!(&lines[i], exp_line.as_str().unwrap());
    }

    let mut demuxer = StreamDemuxer::new();
    let mut samples = Vec::new();
    let mut logs = Vec::new();

    for (idx, line) in lines.iter().enumerate() {
        let ts = idx as u64 * 1000;
        match demuxer.demux_line(line, ts, LogDirection::Rx) {
            DemuxOutput::Sample(s) => samples.push(s),
            DemuxOutput::Log(l) => logs.push(l),
            DemuxOutput::None => {}
        }
    }
    if let Some(flush_s) = demuxer.flush() {
        samples.push(flush_s);
    }

    assert_samples_match(&samples, &expected);
    assert_logs_match(&logs, &expected);
    assert_summary_match(
        dirty_counter.load(Ordering::Relaxed),
        demuxer.error_count(),
        samples.len(),
        logs.len(),
        &expected,
    );
}

#[test]
fn test_fixture_02_teleplot() {
    let dir = get_fixtures_dir();
    let raw_bytes = fs::read(dir.join("02_teleplot.raw")).expect("Failed to read 02_teleplot.raw");
    let json_str = fs::read_to_string(dir.join("02_teleplot.expected.json"))
        .expect("Failed to read 02_teleplot.expected.json");
    let expected: serde_json::Value = serde_json::from_str(&json_str).unwrap();

    let mut line_buf = Vec::new();
    let dirty_counter = AtomicU64::new(0);
    let lines = process_serial_bytes(&raw_bytes, &mut line_buf, &dirty_counter);

    let exp_lines = expected["raw_lines"].as_array().unwrap();
    assert_eq!(lines.len(), exp_lines.len());
    for (i, exp_line) in exp_lines.iter().enumerate() {
        assert_eq!(&lines[i], exp_line.as_str().unwrap());
    }

    let mut demuxer = StreamDemuxer::new();
    let mut samples = Vec::new();
    let mut logs = Vec::new();

    for (idx, line) in lines.iter().enumerate() {
        let ts = idx as u64 * 1000;
        match demuxer.demux_line(line, ts, LogDirection::Rx) {
            DemuxOutput::Sample(s) => samples.push(s),
            DemuxOutput::Log(l) => logs.push(l),
            DemuxOutput::None => {}
        }
    }
    if let Some(flush_s) = demuxer.flush() {
        samples.push(flush_s);
    }

    let exp_channels: Vec<String> = expected["channel_names"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert_eq!(demuxer.channel_names(), exp_channels.as_slice());

    assert_samples_match(&samples, &expected);
    assert_logs_match(&logs, &expected);
    assert_summary_match(
        dirty_counter.load(Ordering::Relaxed),
        demuxer.error_count(),
        samples.len(),
        logs.len(),
        &expected,
    );
}

#[test]
fn test_fixture_03_csv_and_log_mixed() {
    let dir = get_fixtures_dir();
    let raw_bytes = fs::read(dir.join("03_csv_and_log_mixed.raw"))
        .expect("Failed to read 03_csv_and_log_mixed.raw");
    let json_str = fs::read_to_string(dir.join("03_csv_and_log_mixed.expected.json"))
        .expect("Failed to read 03_csv_and_log_mixed.expected.json");
    let expected: serde_json::Value = serde_json::from_str(&json_str).unwrap();

    let mut line_buf = Vec::new();
    let dirty_counter = AtomicU64::new(0);
    let lines = process_serial_bytes(&raw_bytes, &mut line_buf, &dirty_counter);

    let exp_lines = expected["raw_lines"].as_array().unwrap();
    assert_eq!(lines.len(), exp_lines.len());
    for (i, exp_line) in exp_lines.iter().enumerate() {
        assert_eq!(&lines[i], exp_line.as_str().unwrap());
    }

    let mut demuxer = StreamDemuxer::new();
    let mut samples = Vec::new();
    let mut logs = Vec::new();

    for (idx, line) in lines.iter().enumerate() {
        let ts = idx as u64 * 1000;
        match demuxer.demux_line(line, ts, LogDirection::Rx) {
            DemuxOutput::Sample(s) => samples.push(s),
            DemuxOutput::Log(l) => logs.push(l),
            DemuxOutput::None => {}
        }
    }
    if let Some(flush_s) = demuxer.flush() {
        samples.push(flush_s);
    }

    assert_samples_match(&samples, &expected);
    assert_logs_match(&logs, &expected);
    assert_summary_match(
        dirty_counter.load(Ordering::Relaxed),
        demuxer.error_count(),
        samples.len(),
        logs.len(),
        &expected,
    );
}

#[test]
fn test_fixture_04_chunk_boundary_half_line() {
    let dir = get_fixtures_dir();
    let chunks_path = dir.join("04_chunk_boundary_half_line.chunks.json");
    let raw_path = dir.join("04_chunk_boundary_half_line.raw");
    let json_path = dir.join("04_chunk_boundary_half_line.expected.json");

    let chunks_str = fs::read_to_string(&chunks_path).expect("Failed to read chunks.json");
    let chunks_json: serde_json::Value = serde_json::from_str(&chunks_str).unwrap();
    let chunk_list = chunks_json["chunks"].as_array().unwrap();

    let json_str = fs::read_to_string(&json_path).expect("Failed to read 04 expected json");
    let expected: serde_json::Value = serde_json::from_str(&json_str).unwrap();

    // 1. 逐 chunk 灌入并严格比对 chunk_steps
    let mut line_buf = Vec::new();
    let dirty_counter = AtomicU64::new(0);
    let mut all_extracted_lines = Vec::new();
    let exp_chunk_steps = expected["chunk_steps"].as_array().unwrap();

    for (step_idx, chunk) in chunk_list.iter().enumerate() {
        let s = chunk.as_str().unwrap();
        let extracted = process_serial_bytes(s.as_bytes(), &mut line_buf, &dirty_counter);

        let exp_extracted = exp_chunk_steps[step_idx]["extracted_lines"]
            .as_array()
            .unwrap();
        assert_eq!(
            extracted.len(),
            exp_extracted.len(),
            "Chunk step {} extracted lines count mismatch",
            step_idx
        );
        for (line_idx, exp_line) in exp_extracted.iter().enumerate() {
            assert_eq!(
                extracted[line_idx],
                exp_line.as_str().unwrap(),
                "Chunk step {} line {} mismatch",
                step_idx,
                line_idx
            );
        }
        all_extracted_lines.extend(extracted);
    }

    assert_eq!(dirty_counter.load(Ordering::Relaxed), 0);

    // 比对 total raw_lines
    let exp_lines = expected["raw_lines"].as_array().unwrap();
    assert_eq!(all_extracted_lines.len(), exp_lines.len());
    for (i, exp_line) in exp_lines.iter().enumerate() {
        assert_eq!(&all_extracted_lines[i], exp_line.as_str().unwrap());
    }

    let mut demuxer = StreamDemuxer::new();
    let mut samples = Vec::new();
    let mut logs = Vec::new();

    for (idx, line) in all_extracted_lines.iter().enumerate() {
        let ts = idx as u64 * 1000;
        match demuxer.demux_line(line, ts, LogDirection::Rx) {
            DemuxOutput::Sample(s) => samples.push(s),
            DemuxOutput::Log(l) => logs.push(l),
            DemuxOutput::None => {}
        }
    }
    if let Some(flush_s) = demuxer.flush() {
        samples.push(flush_s);
    }

    assert_samples_match(&samples, &expected);
    assert_logs_match(&logs, &expected);
    assert_summary_match(
        dirty_counter.load(Ordering::Relaxed),
        demuxer.error_count(),
        samples.len(),
        logs.len(),
        &expected,
    );

    // 2. 双重验证：全量 raw 一次性灌入应产生 100% 相同的结果
    let raw_bytes = fs::read(&raw_path).expect("Failed to read raw file");
    let mut oneshot_buf = Vec::new();
    let oneshot_dirty = AtomicU64::new(0);
    let oneshot_lines = process_serial_bytes(&raw_bytes, &mut oneshot_buf, &oneshot_dirty);
    assert_eq!(
        all_extracted_lines, oneshot_lines,
        "Chunked vs oneshot line extraction must be identical"
    );
}

#[test]
fn test_fixture_05_invalid_utf8_and_corrupt() {
    let dir = get_fixtures_dir();
    let raw_path = dir.join("05_invalid_utf8_and_corrupt.raw");
    let json_path = dir.join("05_invalid_utf8_and_corrupt.expected.json");

    let expected_bytes: &[u8] = &[
        b'1', b'0', b'.', b'0', b',', b'2', b'0', b'.', b'0', b',', b'3', b'0', b'.', b'0', b'\n',
        0xFF, 0xFE, 0xFD, 0xAA, 0x0A, b'1', b'0', b'.', b'0', b',', b'?', b'?', b'#', b'$', b'%',
        b',', b'3', b'0', b'.', b'0', b'\n', b'>', b'b', b'r', b'o', b'k', b'e', b'n', b'_', b't',
        b'e', b'l', b'e', b'p', b'l', b'o', b't', b'_', b'n', b'o', b'_', b'c', b'o', b'l', b'o',
        b'n', b'\n', b'>', b'k', b'e', b'y', b':', b'N', b'a', b'N', b'\n', b'1', b'.', b'0', b',',
        b'N', b'a', b'N', b',', b'3', b'.', b'0', b'\n', b'1', b'.', b'0', b',', b'2', b'.', b'0',
        b',', b'\n', b'1', b'2', b'.', b'0', b',', b'2', b'2', b'.', b'0', b',', b'3', b'2', b'.',
        b'0', b'\n',
    ];

    if !raw_path.exists()
        || fs::read(&raw_path)
            .map(|b| b != expected_bytes)
            .unwrap_or(true)
    {
        fs::write(&raw_path, expected_bytes)
            .expect("Failed to write 05_invalid_utf8_and_corrupt.raw");
    }

    let raw_bytes = fs::read(&raw_path).expect("Failed to read 05_invalid_utf8_and_corrupt.raw");
    let json_str = fs::read_to_string(&json_path).expect("Failed to read 05 expected json");
    let expected: serde_json::Value = serde_json::from_str(&json_str).unwrap();

    let mut line_buf = Vec::new();
    let dirty_counter = AtomicU64::new(0);
    let lines = process_serial_bytes(&raw_bytes, &mut line_buf, &dirty_counter);

    let exp_valid_lines = expected["summary"]["valid_extracted_lines"]
        .as_u64()
        .unwrap() as usize;
    assert_eq!(lines.len(), exp_valid_lines);

    let mut demuxer = StreamDemuxer::new();
    let mut samples = Vec::new();
    let mut logs = Vec::new();

    for (idx, line) in lines.iter().enumerate() {
        let ts = idx as u64 * 1000;
        match demuxer.demux_line(line, ts, LogDirection::Rx) {
            DemuxOutput::Sample(s) => samples.push(s),
            DemuxOutput::Log(l) => logs.push(l),
            DemuxOutput::None => {}
        }
    }

    assert_samples_match(&samples, &expected);
    assert_logs_match(&logs, &expected);
    assert_summary_match(
        dirty_counter.load(Ordering::Relaxed),
        demuxer.error_count(),
        samples.len(),
        logs.len(),
        &expected,
    );
}

#[test]
fn test_fixture_06_overlong_line_protection() {
    let dir = get_fixtures_dir();
    let raw_path = dir.join("06_overlong_line_protection.raw");
    let chunks_path = dir.join("06_overlong_line_protection.chunks.json");
    let json_path = dir.join("06_overlong_line_protection.expected.json");

    let json_str = fs::read_to_string(&json_path).expect("Failed to read 06 expected json");
    let expected: serde_json::Value = serde_json::from_str(&json_str).unwrap();

    let chunks_str = fs::read_to_string(&chunks_path).expect("Failed to read chunks json");
    let chunks_json: serde_json::Value = serde_json::from_str(&chunks_str).unwrap();

    let chunk0_len = chunks_json["chunks"][0]["length"].as_u64().unwrap() as usize;
    let chunk0_byte = chunks_json["chunks"][0]["repeat_byte"].as_u64().unwrap() as u8;
    let chunk0 = vec![chunk0_byte; chunk0_len];

    let chunk1_text = chunks_json["chunks"][1]["text"].as_str().unwrap();
    let chunk1 = chunk1_text.as_bytes();

    // 确保 06_overlong_line_protection.raw 与 chunks 完全一致
    let mut expected_raw = chunk0.clone();
    expected_raw.extend_from_slice(chunk1);
    if !raw_path.exists()
        || fs::read(&raw_path)
            .map(|b| b != expected_raw)
            .unwrap_or(true)
    {
        fs::write(&raw_path, &expected_raw)
            .expect("Failed to write 06_overlong_line_protection.raw");
    }

    let mut line_buf = Vec::new();
    let dirty_counter = AtomicU64::new(0);

    // 第一阶段：注入超长无换行数据块 (65,537 字节 > 65,536 解析上限)
    let lines1 = process_serial_bytes(&chunk0, &mut line_buf, &dirty_counter);
    assert!(lines1.is_empty(), "超长无换行数据不应产生有效行");
    assert_eq!(
        dirty_counter.load(Ordering::Relaxed),
        1,
        "超过 64 KiB 应计入 1 次 dirty_counter"
    );
    assert!(line_buf.is_empty(), "超长行缓冲区应被清空");

    // 第二阶段：紧随其后到达正常行
    let lines2 = process_serial_bytes(chunk1, &mut line_buf, &dirty_counter);
    assert_eq!(lines2.len(), 1, "缓冲区清空后正常数据应成功提取");
    assert_eq!(lines2[0], "10.0,20.0,30.0");

    let mut demuxer = StreamDemuxer::new();
    let mut samples = Vec::new();
    let mut logs = Vec::new();

    for (idx, line) in lines2.iter().enumerate() {
        let ts = idx as u64 * 1000;
        match demuxer.demux_line(line, ts, LogDirection::Rx) {
            DemuxOutput::Sample(s) => samples.push(s),
            DemuxOutput::Log(l) => logs.push(l),
            DemuxOutput::None => {}
        }
    }

    assert_samples_match(&samples, &expected);
    assert_logs_match(&logs, &expected);
    assert_summary_match(
        dirty_counter.load(Ordering::Relaxed),
        demuxer.error_count(),
        samples.len(),
        logs.len(),
        &expected,
    );
}

#[test]
fn test_fixture_07_line_endings_mixed() {
    let dir = get_fixtures_dir();
    let raw_path = dir.join("07_line_endings_mixed.raw");
    let json_path = dir.join("07_line_endings_mixed.expected.json");

    let expected_mixed_bytes: &[u8] = b"10.0,20.0,30.0\r\n11.0,21.0,31.0\n[INFO] Windows CRLF log line\r\n[WARN] Unix LF log line\n>sp:10.0\r\n>act:9.5\n>sp:12.0\r\n12.0,22.0,32.0\r\n";

    // 确保真实落盘的 raw 文件具备真实的 CRLF 与 LF 混合字节 (130 字节)
    if !raw_path.exists()
        || fs::read(&raw_path)
            .map(|b| b != expected_mixed_bytes)
            .unwrap_or(true)
    {
        fs::write(&raw_path, expected_mixed_bytes)
            .expect("Failed to write 07_line_endings_mixed.raw");
    }

    let raw_bytes = fs::read(&raw_path).expect("Failed to read 07_line_endings_mixed.raw");
    assert_eq!(
        raw_bytes.len(),
        130,
        "07_line_endings_mixed.raw 必须为严格混合的 130 字节"
    );
    // 验证确实包含 \r\n
    assert!(
        raw_bytes.windows(2).any(|w| w == b"\r\n"),
        "必须包含 \\r\\n"
    );

    let json_str = fs::read_to_string(&json_path).expect("Failed to read 07 expected json");
    let expected: serde_json::Value = serde_json::from_str(&json_str).unwrap();

    let mut line_buf = Vec::new();
    let dirty_counter = AtomicU64::new(0);
    let lines = process_serial_bytes(&raw_bytes, &mut line_buf, &dirty_counter);

    let exp_lines = expected["raw_lines"].as_array().unwrap();
    assert_eq!(lines.len(), exp_lines.len());
    for (i, exp_line) in exp_lines.iter().enumerate() {
        assert_eq!(&lines[i], exp_line.as_str().unwrap());
        assert!(
            !lines[i].ends_with('\r'),
            "Line must not end with \\r: {:?}",
            lines[i]
        );
        assert!(
            !lines[i].ends_with('\n'),
            "Line must not end with \\n: {:?}",
            lines[i]
        );
    }

    let mut demuxer = StreamDemuxer::new();
    let mut samples = Vec::new();
    let mut logs = Vec::new();

    for (idx, line) in lines.iter().enumerate() {
        let ts = idx as u64 * 1000;
        match demuxer.demux_line(line, ts, LogDirection::Rx) {
            DemuxOutput::Sample(s) => samples.push(s),
            DemuxOutput::Log(l) => logs.push(l),
            DemuxOutput::None => {}
        }
    }
    if let Some(flush_s) = demuxer.flush() {
        samples.push(flush_s);
    }

    assert_samples_match(&samples, &expected);
    assert_logs_match(&logs, &expected);
    assert_summary_match(
        dirty_counter.load(Ordering::Relaxed),
        demuxer.error_count(),
        samples.len(),
        logs.len(),
        &expected,
    );
}
