//! 供应商 JSON 只投影有界标量，不透传嵌套正文。 / Project vendor JSON into bounded scalars, never nested payloads.
use serde_json::{json, Map, Value};
/// UTC 毫秒表示。 / UTC millisecond representation.
pub(super) fn timestamp(ms: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
/// 有界、安全的统一记录。 / Bounded safe normalized record.
pub(super) fn record(title: &str, time: Option<String>, attrs: &Value) -> Value {
    let attrs = attrs
        .as_object()
        .map(|m| {
            m.iter()
                .take(32)
                .filter(|(_, v)| !v.is_array() && !v.is_object())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<Map<_, _>>()
        })
        .unwrap_or_default();
    let safe: Map<String, Value> = attrs
        .into_iter()
        .filter(|(k, _)| {
            !k.is_empty()
                && k.len() <= 64
                && k.as_bytes()[0].is_ascii_alphabetic()
                && k.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        })
        .map(|(k, v)| {
            let secret = k
                .to_ascii_lowercase()
                .replace("api_key", "apikey")
                .replace("api-key", "apikey")
                .split(['_', '.', '-'])
                .any(|p| {
                    [
                        "authorization",
                        "cookie",
                        "password",
                        "passwd",
                        "secret",
                        "token",
                        "apikey",
                    ]
                    .contains(&p)
                });
            let v = if secret {
                json!("[REDACTED]")
            } else if let Some(s) = v.as_str() {
                json!(crate::telemetry::sanitize_text(s, 512))
            } else {
                v
            };
            (k, v)
        })
        .collect();
    let title = crate::telemetry::sanitize_text(title, 512);
    let mut r =
        json!({"title":if title.trim().is_empty(){"evidence"}else{title.trim()},"attributes":safe});
    if let Some(t) = time {
        r["timestamp"] = json!(t);
    }
    r
}
/// 抽取最多 101 条用于检测截断。 / Extract at most 101 records to detect truncation.
pub(super) fn normalize(adapter: &str, reference: &Value, data: &Value) -> (Vec<Value>, bool) {
    let mut records = Vec::new();
    match adapter {
        "tempo" => {
            let mut pending = vec![data];
            while let Some(v) = pending.pop() {
                if records.len() > 100 {
                    break;
                }
                match v {
                    Value::Array(a) => pending.extend(a.iter().rev()),
                    Value::Object(m) => {
                        if let Some(spans) = m.get("spans").and_then(Value::as_array) {
                            for span in spans.iter().take(101 - records.len()) {
                                let mut attrs = Map::new();
                                for a in array(&span["attributes"]).iter().take(32) {
                                    if let (Some(k), Some(v)) = (
                                        a["key"].as_str(),
                                        a["value"].as_object().and_then(|m| {
                                            m.values().find(|v| {
                                                v.is_string() || v.is_boolean() || v.is_number()
                                            })
                                        }),
                                    ) {
                                        attrs.insert(k.into(), v.clone());
                                    }
                                }
                                for (k, v) in [
                                    ("span_id", &span["spanId"]),
                                    ("parent_span_id", &span["parentSpanId"]),
                                    ("status", &span["status"]["code"]),
                                ] {
                                    if (v.is_string() || v.is_number()) && attrs.len() < 32 {
                                        attrs.insert(k.into(), v.clone());
                                    }
                                }
                                records.push(record(
                                    span["name"].as_str().unwrap_or("span"),
                                    nano(&span["startTimeUnixNano"]),
                                    &Value::Object(attrs),
                                ));
                            }
                        }
                        pending.extend(
                            m.iter()
                                .filter(|(k, _)| k.as_str() != "spans")
                                .map(|(_, v)| v),
                        );
                    }
                    _ => {}
                }
            }
        }
        "loki" | "prometheus" => {
            'series: for stream in array(&data["data"]["result"]) {
                let labels = stream.get("stream").unwrap_or(&stream["metric"]);
                let samples = if let Some(a) = stream["values"].as_array() {
                    a.clone()
                } else {
                    vec![stream["value"].clone()]
                };
                for pair in samples {
                    let Some(value) = scalar(&pair[1]) else {
                        continue;
                    };
                    let (title, time) = if adapter == "loki" {
                        (value, nano(&pair[0]))
                    } else {
                        (
                            format!(
                                "{} = {}",
                                reference["locator"]["metric_name"]
                                    .as_str()
                                    .unwrap_or("metric"),
                                value
                            ),
                            scalar(&pair[0])
                                .and_then(|s| s.parse::<f64>().ok())
                                .filter(|n| n.is_finite())
                                .and_then(|n| timestamp((n * 1000.) as i64)),
                        )
                    };
                    records.push(record(&title, time, labels));
                    if records.len() == 100 {
                        break 'series;
                    }
                }
            }
        }
        "pyroscope" => {
            for name in array(&data["flamebearer"]["names"])
                .iter()
                .filter_map(Value::as_str)
                .take(101)
            {
                records.push(record(
                    name,
                    None,
                    &json!({"profile_type":reference["locator"]["profile_type"]}),
                ));
            }
        }
        _ => {}
    }
    let truncated = if ["loki", "prometheus"].contains(&adapter) {
        records.len() == 100
    } else {
        records.len() > 100
    };
    records.truncate(100);
    (records, truncated)
}
fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(_) => Some(v.to_string()),
        _ => None,
    }
}
fn nano(v: &Value) -> Option<String> {
    let s = scalar(v)?;
    if s.len() > 30 || s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n = s.parse::<i128>().ok()? / 1_000_000;
    timestamp(i64::try_from(n).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalization_bounds_records_and_redacts_secrets() {
        let payload = json!({"data":{"result":[{"stream":{"api_key":"secret","nested":{"bad":true}},"values":(0..120).map(|_|json!(["1726099200000000000","password=secret"])).collect::<Vec<_>>()}]}});
        let (r, truncated) = normalize("loki", &json!({}), &payload);
        assert_eq!(r.len(), 100);
        assert!(truncated);
        assert!(!r[0].to_string().contains("password=secret"));
        assert_eq!(r[0]["attributes"]["api_key"], "[REDACTED]");
        assert!(r[0]["attributes"].get("nested").is_none());
    }
    #[test]
    fn normalizes_vendor_shapes() {
        let (r, t) = normalize(
            "tempo",
            &json!({}),
            &json!({"batches":[{"scopeSpans":[{"spans":[{"name":"work","spanId":"123","startTimeUnixNano":"1726099200000000000"}]}]}]}),
        );
        assert_eq!(r.len(), 1);
        assert!(!t);
        assert_eq!(r[0]["title"], "work");
        let (r, _) = normalize(
            "prometheus",
            &json!({"locator":{"metric_name":"up"}}),
            &json!({"data":{"result":[{"metric":{"service_name":"api"},"values":[[1726099200,"1"]]}]}}),
        );
        assert_eq!(r[0]["title"], "up = 1");
        let (r, _) = normalize(
            "pyroscope",
            &json!({"locator":{"profile_type":"cpu"}}),
            &json!({"flamebearer":{"names":["main","worker"]}}),
        );
        assert_eq!(r.len(), 2);
    }
}
