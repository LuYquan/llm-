use llm_serial_lib::protocol::{BinaryProtocolParser, ProtocolConfig};
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
struct Fixture {
    name: String,
    config: serde_json::Value,
    chunks: Vec<Vec<u8>>,
    expected: ExpectedOutput,
}

#[derive(Debug, Deserialize)]
struct ExpectedOutput {
    frames: Vec<Vec<f64>>,
    #[serde(rename = "droppedBytes")]
    dropped_bytes: u64,
    #[serde(rename = "errorCount")]
    error_count: u64,
}

#[test]
fn binary_protocol_fixtures_match_the_web_parser_contract() {
    let fixture_path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "..", "tests", "fixtures", "binary-protocol.json"]
        .iter()
        .collect();
    let fixtures: Vec<Fixture> = serde_json::from_str(
        &fs::read_to_string(&fixture_path).expect("shared binary protocol fixture must exist"),
    )
    .expect("shared binary protocol fixture must be valid JSON");

    assert!(!fixtures.is_empty(), "the parity suite must contain fixtures");
    for fixture in fixtures {
        let config: ProtocolConfig = serde_json::from_value(fixture.config)
            .unwrap_or_else(|error| panic!("{} has invalid Rust protocol config: {error}", fixture.name));
        let mut parser = BinaryProtocolParser::new(config)
            .unwrap_or_else(|error| panic!("{} has invalid parser config: {error}", fixture.name));
        let mut frames = Vec::new();
        let mut dropped_bytes = 0;
        let mut error_count = 0;

        for chunk in fixture.chunks {
            let output = parser.feed(&chunk);
            frames.extend(output.frames);
            dropped_bytes += output.dropped_bytes;
            error_count += output.error_count;
        }

        assert_eq!(frames, fixture.expected.frames, "{} frame mismatch", fixture.name);
        assert_eq!(
            dropped_bytes, fixture.expected.dropped_bytes,
            "{} dropped-byte mismatch",
            fixture.name
        );
        assert_eq!(
            error_count, fixture.expected.error_count,
            "{} error-count mismatch",
            fixture.name
        );
    }
}
