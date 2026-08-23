use serde::Serialize;
use serde_json::Value;
use std::{env, fs, process};

#[path = "../../../generated/rust/protocol.rs"]
mod protocol;

#[derive(Serialize)]
struct Outcome {
    id: String,
    accepted: bool,
}

fn main() {
    let path = env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: magic-context-protocol-conformance GOLDEN.json");
        process::exit(2);
    });
    let cases: Vec<Value> = serde_json::from_str(
        &fs::read_to_string(path).expect("failed to read golden cases"),
    )
    .expect("golden cases must be JSON");
    let outcomes: Vec<Outcome> = cases
        .into_iter()
        .map(|case| {
            let id = case["id"].as_str().expect("case id").to_owned();
            let accepted = if case["target"] == "call" {
                protocol::validate_runtime_call(&case["value"])
            } else {
                protocol::validate_runtime_result(
                    case["method"].as_str().unwrap_or_default(),
                    &case["value"],
                )
            };
            Outcome { id, accepted }
        })
        .collect();
    println!("{}", serde_json::to_string(&outcomes).expect("serialize outcomes"));
}
