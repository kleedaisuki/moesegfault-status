//! 类型化 D1 参数和可失败的行解码；事务由平台 batch 保证。
//! Typed D1 parameters and fallible row decoding; platform batch owns transactions.

use serde::Deserialize;

/// D1 只接受可表示的 SQL 值，不接受任意 JSON 对象作为参数。
/// D1 accepts representable SQL values, never arbitrary JSON objects as parameters.
#[derive(Clone, Debug, PartialEq)]
pub enum SqlValue {
    /// SQL NULL，不转为字符串。 / SQL NULL, not a string.
    Null,
    /// UTF-8 文本。 / UTF-8 text.
    Text(String),
    /// 整数在宿主边界检查精度。 / Integer precision is checked at the host boundary.
    Integer(i64),
    /// 有限浮点数。 / Finite floating-point number.
    Real(f64),
    /// 原始字节。 / Raw bytes.
    Blob(Vec<u8>),
}

impl From<&str> for SqlValue {
    fn from(value: &str) -> Self {
        Self::Text(value.into())
    }
}
impl From<String> for SqlValue {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}
impl From<i64> for SqlValue {
    fn from(value: i64) -> Self {
        Self::Integer(value)
    }
}
impl From<bool> for SqlValue {
    fn from(value: bool) -> Self {
        Self::Integer(i64::from(value))
    }
}

/// SQL 与参数分离；不提供字符串插值参数接口。 / Separate SQL and parameters; no interpolated parameter API.
#[derive(Clone, Debug)]
pub struct Query {
    /// 开发者控制的 SQL。 / Developer-controlled SQL.
    sql: String,
    /// 用户值仅作为参数。 / User values are parameters only.
    values: Vec<SqlValue>,
}

impl Query {
    /// 构造参数化语句；SQL 结构必须由应用控制。 / Construct a parameterized statement; application controls SQL structure.
    pub fn new(sql: impl Into<String>, values: Vec<SqlValue>) -> Self {
        Self {
            sql: sql.into(),
            values,
        }
    }
    /// 只读 SQL 文本。 / Read-only SQL text.
    pub fn sql(&self) -> &str {
        &self.sql
    }
    /// 参数切片。 / Parameter slice.
    pub fn values(&self) -> &[SqlValue] {
        &self.values
    }
}

/// 不携带 SQL、参数或原始平台异常，便于安全映射 HTTP 错误。
/// Carries no SQL, parameters, or raw platform exception, allowing safe HTTP mapping.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum DatabaseError {
    /// 值无法精确绑定。 / Value cannot be bound exactly.
    #[error("SQL parameter is not representable")]
    InvalidParameter,
    /// 平台执行失败。 / Platform execution failure.
    #[error("Database operation failed")]
    Execution,
    /// 已知数据库约束冲突。 / Known database constraint conflict.
    #[error("Database constraint conflict")]
    Constraint,
    /// 临时平台或网络不可用。 / Temporary platform or network unavailability.
    #[error("Database temporarily unavailable")]
    Unavailable,
    /// 返回行不符合期望类型。 / Returned rows do not match the expected type.
    #[error("Database result violates the row contract")]
    RowContract,
}

/// SQL 数值转为宿主 Number 前检查范围。 / Check SQL numeric range before conversion to host Number.
pub fn validate_parameter(value: &SqlValue) -> Result<(), DatabaseError> {
    match value {
        SqlValue::Integer(n) if !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(n) => {
            Err(DatabaseError::InvalidParameter)
        }
        SqlValue::Real(n) if !n.is_finite() => Err(DatabaseError::InvalidParameter),
        _ => Ok(()),
    }
}

/// 平台返回的成功标志与强类型行，缺失 results 仅表示空集。
/// Platform success flag and typed rows; absent results denotes an empty collection.
#[derive(Debug, Deserialize)]
pub struct QueryResult<T> {
    /// 平台成功标志。 / Platform success flag.
    pub success: bool,
    /// 已解码的结果行。 / Decoded result rows.
    #[serde(default = "Vec::new")]
    pub results: Vec<T>,
    /// 平台元数据，可包含新增字段。 / Platform metadata, allowing future fields.
    #[serde(default)]
    pub meta: serde_json::Value,
}

#[cfg(target_arch = "wasm32")]
mod platform {
    use super::*;
    use serde::de::DeserializeOwned;
    use wasm_bindgen::{JsCast, JsValue};
    use wasm_bindgen_futures::JsFuture;
    use worker::{D1Database, D1PreparedStatement};

    /// 直接使用 Workers 的 D1 binding，不经 REST 或手写 TypeScript。
    /// Use the Workers D1 binding directly, without REST or handwritten TypeScript.
    pub struct Database {
        /// 本次调用的数据库 binding，不跨请求保存。 / Invocation-local binding, never stored across requests.
        binding: D1Database,
    }

    impl Database {
        /// 从已配置 binding 构造。 / Construct from a configured binding.
        pub fn new(binding: D1Database) -> Self {
            Self { binding }
        }

        /// 强类型查询；解析失败返回错误，不 panic。
        /// Typed query; deserialization failure returns an error rather than panicking.
        ///
        /// ```ignore
        /// let db = Database::new(env.d1("DB")?);
        /// let rows = db.all::<ServiceRow>(&Query::new("SELECT service_name FROM services WHERE enabled = ?", vec![true.into()])).await?;
        /// ```
        pub async fn all<T: DeserializeOwned>(
            &self,
            query: &Query,
        ) -> Result<Vec<T>, DatabaseError> {
            let statement = self.prepare(query)?;
            // SDK 0.8.5 results<T>() 内部 unwrap；使用同一官方 binding 的可失败解码。
            // SDK 0.8.5 results<T>() unwraps internally; decode the same official binding fallibly instead.
            let promise = statement.inner().all().map_err(classify_error)?;
            let raw = JsFuture::from(promise).await.map_err(classify_error)?;
            let result: QueryResult<T> =
                serde_wasm_bindgen::from_value(raw).map_err(|_| DatabaseError::RowContract)?;
            if !result.success {
                return Err(DatabaseError::Execution);
            }
            Ok(result.results)
        }

        /// 返回第一行，调用者的 SQL 应明确 LIMIT 或唯一性约束。 / Return first row; SQL should specify LIMIT or uniqueness.
        pub async fn first<T: DeserializeOwned>(
            &self,
            query: &Query,
        ) -> Result<Option<T>, DatabaseError> {
            self.prepare(query)?
                .first(None)
                .await
                .map_err(|_| DatabaseError::RowContract)
        }

        /// 将全部语句作为一次平台事务；任何语句失败使整个 batch 回滚。
        /// Execute all statements as one platform transaction; any failure rolls back the complete batch.
        pub async fn batch(
            &self,
            queries: &[Query],
        ) -> Result<Vec<QueryResult<serde_json::Value>>, DatabaseError> {
            if queries.is_empty() {
                return Ok(Vec::new());
            }
            let statements = js_sys::Array::new();
            for query in queries {
                statements.push(self.prepare(query)?.inner().as_ref());
            }
            let binding: &worker_sys::types::D1Database = self.binding.as_ref().unchecked_ref();
            let promise = binding.batch(statements).map_err(classify_error)?;
            let raw = JsFuture::from(promise).await.map_err(classify_error)?;
            let results: Vec<QueryResult<serde_json::Value>> =
                serde_wasm_bindgen::from_value(raw).map_err(|_| DatabaseError::RowContract)?;
            if results.len() != queries.len() || results.iter().any(|r| !r.success) {
                return Err(DatabaseError::Execution);
            }
            Ok(results)
        }

        /// 转换经过校验的 SQL 值。 / Convert validated SQL values.
        fn prepare(&self, query: &Query) -> Result<D1PreparedStatement, DatabaseError> {
            let values: Vec<JsValue> = query
                .values
                .iter()
                .map(parameter)
                .collect::<Result<_, _>>()?;
            self.binding
                .prepare(&query.sql)
                .bind(&values)
                .map_err(|_| DatabaseError::InvalidParameter)
        }
    }

    /// Classify fixed platform error categories without exposing SQL or parameters.
    /// 仅分类固定平台错误，不暴露 SQL 或参数。
    fn classify_error(error: JsValue) -> DatabaseError {
        let mut current = error;
        let mut messages = String::new();
        for _ in 0..3 {
            if let Some(message) = current.as_string() {
                messages.push_str(&message);
            }
            if let Ok(message) = js_sys::Reflect::get(&current, &"message".into()) {
                if let Some(message) = message.as_string() {
                    messages.push_str(&message);
                }
            }
            let Ok(cause) = js_sys::Reflect::get(&current, &"cause".into()) else {
                break;
            };
            if cause.is_null() || cause.is_undefined() {
                break;
            }
            current = cause;
        }
        let message = messages.to_ascii_lowercase();
        if message.contains("sqlite_constraint") || message.contains("constraint failed") {
            return DatabaseError::Constraint;
        }
        if [
            "temporarily unavailable",
            "networkerror",
            "fetch failed",
            "overloaded",
            "rate limit",
        ]
        .iter()
        .any(|kind| message.contains(kind))
        {
            return DatabaseError::Unavailable;
        }
        DatabaseError::Execution
    }

    /// SQLite bool 用整数表达；BLOB 不转成字符串。 / Represent SQLite booleans as integers; never stringify BLOBs.
    fn parameter(value: &SqlValue) -> Result<JsValue, DatabaseError> {
        validate_parameter(value)?;
        Ok(match value {
            SqlValue::Null => JsValue::NULL,
            SqlValue::Text(value) => JsValue::from_str(value),
            SqlValue::Integer(value) => JsValue::from_f64(*value as f64),
            SqlValue::Real(value) => JsValue::from_f64(*value),
            SqlValue::Blob(value) => js_sys::Uint8Array::from(value.as_slice()).into(),
        })
    }
}

#[cfg(target_arch = "wasm32")]
pub use platform::Database;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_precision_loss_and_nonfinite_numbers() {
        assert!(validate_parameter(&SqlValue::Integer(9_007_199_254_740_991)).is_ok());
        assert!(validate_parameter(&SqlValue::Integer(9_007_199_254_740_992)).is_err());
        assert!(validate_parameter(&SqlValue::Real(f64::NAN)).is_err());
        assert!(validate_parameter(&SqlValue::Real(f64::INFINITY)).is_err());
        assert_eq!(SqlValue::from(true), SqlValue::Integer(1));
    }

    #[test]
    fn typed_row_mismatch_is_an_error() {
        #[derive(Deserialize)]
        struct Row {
            count: u64,
        }
        let valid: QueryResult<Row> =
            serde_json::from_str(r#"{"success":true,"results":[{"count":3}]}"#).unwrap();
        assert_eq!(valid.results[0].count, 3);
        assert!(serde_json::from_str::<QueryResult<Row>>(
            r#"{"success":true,"results":[{"count":"wrong"}]}"#
        )
        .is_err());
    }
}
