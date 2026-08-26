//! Decodes Quint ITF values without collapsing structural keys or collection types.

use quint_refinements::RuntimeValue;
use serde_json::json;

fn main() {
    let itf = json!({
        "pool_counts": {
            "#map": [[
                { "org": "org-a", "service": "api" },
                { "#bigint": "3" }
            ]]
        },
        "healthy": { "#set": ["api", "worker"] },
        "selection": { "tag": "Present", "value": "api" },
        "coordinates": { "#tup": [1, 2] }
    });
    match RuntimeValue::from_itf_json(&itf) {
        Ok(value) => println!("{value:#?}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
