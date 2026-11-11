/**
 * Files of the Axum project that do not belong to one resource: the entry point and the library root (state and
 * router), the error format, the reading of request bodies with their rules, list queries, query strings, the
 * clock, the settings read from the environment, authentication and the database connection.
 */
import { GENERAL_ERROR_CODES } from '../../../openapi/build.ts'
import { referencedResources } from '../../common/references.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines, type Lines } from '../../common/text.ts'
import { RsUses, rsDoc, rsHeader, rsString } from '../../languages/rust/rust.ts'
import { names, resourceModule, type AxumContext } from './context.ts'

/** Default database URL of each database, for a database on this computer. */
export const DATABASE_URLS: Record<string, string> = {
  postgresql: 'postgres://api:change-me@localhost:5432/api',
  mysql: 'mysql://api:change-me@localhost:3306/api',
  mariadb: 'mysql://api:change-me@localhost:3306/api',
  sqlite: 'sqlite://app.db?mode=rwc',
}

function file(path: string, doc: string, uses: string[], body: Lines[]): GeneratedFile {
  return { path, content: fileText(lines(...rsHeader(doc, new RsUses().add(...uses)), ...body)) }
}

export function commonFiles(context: AxumContext): GeneratedFile[] {
  return [
    file(
      'src/common/error.rs',
      'The error format of the API: {"error": {"code", "message", "details"}}, with the status of openapi.yaml.',
      [
        'axum::Json',
        'axum::http::StatusCode',
        'axum::response::{IntoResponse, Response}',
        'serde::Serialize',
        'std::any::Any',
        ...(context.seaOrm ? ['sea_orm::{DbErr, SqlErr}'] : []),
      ],
      [
        rsDoc('Where the request is wrong and why.'),
        '#[derive(Clone, Debug, Serialize)]',
        'pub struct ErrorDetail {',
        '    pub field: String,',
        '    pub message: String,',
        '}',
        '',
        rsDoc('An error the API answers with a status, a code and a message (see openapi.yaml).'),
        '#[derive(Debug)]',
        'pub struct ApiError {',
        '    pub status: StatusCode,',
        "    pub code: &'static str,",
        '    pub message: String,',
        '    pub details: Vec<ErrorDetail>,',
        '}',
        '',
        'impl ApiError {',
        "    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {",
        '        Self { status, code, message: message.into(), details: Vec::new() }',
        '    }',
        '',
        '    /// A request that breaks its rules, with each problem.',
        '    pub fn invalid_body(details: Vec<ErrorDetail>) -> Self {',
        '        Self { details, ..Self::new(StatusCode::BAD_REQUEST, "validation_error", "The request is not valid") }',
        '    }',
        '',
        '    pub fn invalid(field: impl Into<String>, message: impl Into<String>) -> Self {',
        '        Self::invalid_body(vec![ErrorDetail { field: field.into(), message: message.into() }])',
        '    }',
        '',
        '    pub fn not_found(what: &str) -> Self {',
        '        Self::new(StatusCode::NOT_FOUND, "not_found", format!("No {what} has this key"))',
        '    }',
        '',
        '    pub fn conflict(message: impl Into<String>) -> Self {',
        '        Self::new(StatusCode::CONFLICT, "conflict", message)',
        '    }',
        '',
        '    pub fn unauthorized() -> Self {',
        '        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", "Missing or invalid credentials")',
        '    }',
        '',
        '    pub fn forbidden() -> Self {',
        '        Self::new(StatusCode::FORBIDDEN, "forbidden", "The credentials do not allow this operation")',
        '    }',
        '',
        '    /// Code still to write: the API answers 501.',
        '    pub fn not_implemented(message: impl Into<String>) -> Self {',
        '        Self::new(StatusCode::NOT_IMPLEMENTED, "not_implemented", message)',
        '    }',
        '',
        '    pub fn internal() -> Self {',
        `        Self::new(StatusCode::INTERNAL_SERVER_ERROR, ${rsString(GENERAL_ERROR_CODES[1])}, "Something went wrong on the server")`,
        '    }',
        '}',
        '',
        'impl IntoResponse for ApiError {',
        '    fn into_response(self) -> Response {',
        '        let mut error = serde_json::json!({ "code": self.code, "message": self.message });',
        '        if !self.details.is_empty() {',
        '            error["details"] = serde_json::to_value(&self.details).unwrap_or_default();',
        '        }',
        '        (self.status, Json(serde_json::json!({ "error": error }))).into_response()',
        '    }',
        '}',
        context.seaOrm && [
          '',
          'impl From<DbErr> for ApiError {',
          '    fn from(error: DbErr) -> Self {',
          '        if let Some(SqlErr::UniqueConstraintViolation(_)) = error.sql_err() {',
          '            // A key already used. The cause stays in the log',
          '            tracing::warn!("Integrity error: {error}");',
          '            return Self::conflict("The change conflicts with the stored data");',
          '        }',
          '        tracing::error!("Database error: {error}");',
          '        Self::internal()',
          '    }',
          '}',
        ],
        '',
        rsDoc('The status of a successful answer.'),
        'pub fn status(code: u16) -> StatusCode {',
        '    StatusCode::from_u16(code).unwrap_or(StatusCode::OK)',
        '}',
        '',
        rsDoc('Answers a request no route takes.'),
        'pub async fn no_route() -> ApiError {',
        '    ApiError::new(StatusCode::NOT_FOUND, "not_found", "No route matches this request")',
        '}',
        '',
        rsDoc('Answers a method a path does not accept.'),
        'pub async fn wrong_method() -> ApiError {',
        `    ApiError::new(StatusCode::METHOD_NOT_ALLOWED, ${rsString(GENERAL_ERROR_CODES[0])}, "This path does not accept this method")`,
        '}',
        '',
        rsDoc('Answers a request whose handler panicked, after logging it.'),
        "pub fn panic_response(_panic: Box<dyn Any + Send + 'static>) -> Response {",
        '    tracing::error!("Unexpected error: a handler panicked");',
        '    ApiError::internal().into_response()',
        '}',
      ],
    ),
    file(
      'src/common/body.rs',
      'Reading request bodies: a JSON object that meets the rules of its type, checked before it is read.',
      [
        'serde::de::DeserializeOwned',
        'serde_json::{Map, Value}',
        'rust_decimal::Decimal',
        'std::collections::BTreeSet',
        'std::str::FromStr',
        'crate::common::error::{ApiError, ErrorDetail}',
      ],
      [
        rsDoc('A request body: its values, and the JSON names it carried (a field sent as null is there, a missing one is not).'),
        'pub struct Body<T> {',
        '    pub value: T,',
        '    sent: BTreeSet<String>,',
        '}',
        '',
        'impl<T> Body<T> {',
        '    pub fn has(&self, field: &str) -> bool {',
        '        self.sent.contains(field)',
        '    }',
        '}',
        '',
        rsDoc('The kinds of JSON value a field can hold.'),
        '#[derive(Clone, Copy, Debug)]',
        'pub enum JsonKind {',
        '    Text,',
        '    Whole,',
        '    Number,',
        '    Boolean,',
        '    List,',
        '    Object,',
        '}',
        '',
        rsDoc('The problems of a request body, by field. Embedded objects add their path: `address.street`.'),
        '#[derive(Default)]',
        'pub struct Checks {',
        '    problems: Vec<ErrorDetail>,',
        '    prefix: String,',
        '}',
        '',
        'impl Checks {',
        '    pub fn fail(&mut self, field: &str, message: &str) {',
        '        self.problems.push(ErrorDetail { field: format!("{}{field}", self.prefix), message: message.to_string() });',
        '    }',
        '',
        '    pub fn required(&mut self, json: &Map<String, Value>, field: &str) {',
        '        if !json.contains_key(field) {',
        '            self.fail(field, "The field is required");',
        '        }',
        '    }',
        '',
        '    pub fn not_null(&mut self, json: &Map<String, Value>, field: &str) {',
        '        if json.get(field).is_some_and(Value::is_null) {',
        '            self.fail(field, "The field must not be null");',
        '        }',
        '    }',
        '',
        '    /// The value has the kind of the field; null is left to not_null.',
        '    pub fn kind(&mut self, json: &Map<String, Value>, field: &str, kind: JsonKind) {',
        '        let Some(value) = json.get(field).filter(|value| !value.is_null()) else {',
        '            return;',
        '        };',
        '        let valid = match kind {',
        '            JsonKind::Text => value.is_string(),',
        '            JsonKind::Whole => value.is_i64() || value.is_u64() || value.as_f64().is_some_and(|number| number.fract() == 0.0),',
        '            JsonKind::Number => value.is_number(),',
        '            JsonKind::Boolean => value.is_boolean(),',
        '            JsonKind::List => value.is_array(),',
        '            JsonKind::Object => value.is_object(),',
        '        };',
        '        if !valid {',
        '            self.fail(field, &format!("Must be {}", format!("{kind:?}").to_lowercase()));',
        '        }',
        '    }',
        '',
        '    pub fn length(&mut self, json: &Map<String, Value>, field: &str, min: Option<usize>, max: Option<usize>) {',
        '        let Some(text) = json.get(field).and_then(Value::as_str) else {',
        '            return;',
        '        };',
        '        // Counted as JavaScript counts: in UTF-16 units',
        '        let length = text.encode_utf16().count();',
        '        if min.is_some_and(|min| length < min) || max.is_some_and(|max| length > max) {',
        '            self.fail(field, "Has a length out of its limits");',
        '        }',
        '    }',
        '',
        '    pub fn count(&mut self, json: &Map<String, Value>, field: &str, min: Option<usize>, max: Option<usize>) {',
        '        let Some(list) = json.get(field).and_then(Value::as_array) else {',
        '            return;',
        '        };',
        '        if min.is_some_and(|min| list.len() < min) || max.is_some_and(|max| list.len() > max) {',
        '            self.fail(field, "Has a number of items out of its limits");',
        '        }',
        '    }',
        '',
        '    pub fn range(&mut self, json: &Map<String, Value>, field: &str, min: Option<&str>, max: Option<&str>, min_exclusive: bool, max_exclusive: bool) {',
        '        let Some(number) = json.get(field).filter(|value| value.is_number()).and_then(|value| Decimal::from_str(&value.to_string()).ok().or_else(|| value.as_f64().and_then(|n| Decimal::try_from(n).ok()))) else {',
        '            return;',
        '        };',
        '        let below = min.and_then(|min| Decimal::from_str(min).ok()).is_some_and(|min| number < min || (min_exclusive && number == min));',
        '        let above = max.and_then(|max| Decimal::from_str(max).ok()).is_some_and(|max| number > max || (max_exclusive && number == max));',
        '        if below || above {',
        '            self.fail(field, "Is out of its range");',
        '        }',
        '    }',
        '',
        '    /// The text matches the expression somewhere, as "pattern" reads it in openapi.yaml.',
        '    pub fn pattern(&mut self, json: &Map<String, Value>, field: &str, pattern: &str) {',
        '        let Some(text) = json.get(field).and_then(Value::as_str) else {',
        '            return;',
        '        };',
        '        // An expression this engine cannot read checks nothing, rather than reject every value',
        '        let Ok(regex) = fancy_regex::Regex::new(pattern) else {',
        '            return;',
        '        };',
        '        if !regex.is_match(text).unwrap_or(false) {',
        '            self.fail(field, "Has the wrong format");',
        '        }',
        '    }',
        '',
        '    pub fn email(&mut self, json: &Map<String, Value>, field: &str) {',
        '        let Some(text) = json.get(field).and_then(Value::as_str) else {',
        '            return;',
        '        };',
        "        let mut parts = text.split('@');",
        '        let valid = matches!((parts.next(), parts.next(), parts.next()), (Some(user), Some(domain), None) if !user.is_empty() && !domain.is_empty() && !text.contains(char::is_whitespace));',
        '        if !valid {',
        '            self.fail(field, "Must be an email address");',
        '        }',
        '    }',
        '',
        '    /// The rules of an embedded object, with its path before each field.',
        '    pub fn nested(&mut self, json: &Map<String, Value>, field: &str, rules: fn(&mut Checks, &Map<String, Value>)) {',
        '        if let Some(inner) = json.get(field).and_then(Value::as_object) {',
        '            let prefix = format!("{}{field}.", self.prefix);',
        '            self.run(prefix, inner, rules);',
        '        }',
        '    }',
        '',
        '    /// The rules of each embedded object of a list.',
        '    pub fn each(&mut self, json: &Map<String, Value>, field: &str, rules: fn(&mut Checks, &Map<String, Value>)) {',
        '        let Some(list) = json.get(field).and_then(Value::as_array) else {',
        '            return;',
        '        };',
        '        for (index, item) in list.iter().enumerate() {',
        '            if let Some(inner) = item.as_object() {',
        '                let prefix = format!("{}{field}[{index}].", self.prefix);',
        '                self.run(prefix, inner, rules);',
        '            }',
        '        }',
        '    }',
        '',
        '    fn run(&mut self, prefix: String, json: &Map<String, Value>, rules: fn(&mut Checks, &Map<String, Value>)) {',
        '        let mut inner = Checks { problems: Vec::new(), prefix };',
        '        rules(&mut inner, json);',
        '        self.problems.append(&mut inner.problems);',
        '    }',
        '}',
        '',
        rsDoc(
          'Reads a request body: a JSON object that meets its rules (with every problem reported) and has no field the\ncontract does not describe.',
        ),
        'pub fn read_body<T: DeserializeOwned>(bytes: &[u8], rules: fn(&mut Checks, &Map<String, Value>)) -> Result<Body<T>, ApiError> {',
        '    let json: Value = serde_json::from_slice(bytes).map_err(|_| ApiError::invalid("", "The body is not valid JSON"))?;',
        '    let Some(object) = json.as_object() else {',
        '        return Err(ApiError::invalid("", "The body must be a JSON object"));',
        '    };',
        '    let mut checks = Checks::default();',
        '    rules(&mut checks, object);',
        '    if !checks.problems.is_empty() {',
        '        return Err(ApiError::invalid_body(checks.problems));',
        '    }',
        '    let sent = object.keys().cloned().collect();',
        '    let value = serde_json::from_value(json).map_err(|error| ApiError::invalid("", error.to_string()))?;',
        '    Ok(Body { value, sent })',
        '}',
      ],
    ),
    file(
      'src/common/list.rs',
      'What a list asks a repository for, and what it gets back.',
      ['serde::Serialize', 'std::cmp::Ordering'],
      [
        rsDoc('A list: the filters of its resource, an order by a JSON field name and a window.'),
        '#[derive(Clone, Debug)]',
        'pub struct ListQuery<F> {',
        '    pub filters: F,',
        '    pub sort_field: Option<String>,',
        '    pub descending: bool,',
        '    pub offset: u64,',
        '    pub limit: Option<u64>,',
        '}',
        '',
        'impl<F> ListQuery<F> {',
        '    /// "-createdAt" sorts by createdAt in descending order.',
        '    pub fn new(filters: F, sort: Option<String>, offset: u64, limit: Option<u64>) -> Self {',
        "        let descending = sort.as_deref().is_some_and(|sort| sort.starts_with('-'));",
        "        let sort_field = sort.map(|sort| sort.trim_start_matches('-').to_string());",
        '        Self { filters, sort_field, descending, offset, limit }',
        '    }',
        '}',
        '',
        rsDoc('A window of items and how many match, whatever the window.'),
        'pub struct ListResult<T> {',
        '    pub items: Vec<T>,',
        '    pub total: u64,',
        '}',
        '',
        rsDoc('One page of a list, as the API returns it.'),
        '#[derive(Serialize)]',
        'pub struct PageResponse<T> {',
        '    pub items: Vec<T>,',
        '    pub total: u64,',
        '    pub page: u64,',
        '    pub size: u64,',
        '}',
        '',
        rsDoc('Orders two values of a field: the ones without a value go last, whatever the order.'),
        'pub fn order_values<T: PartialOrd>(a: &Option<T>, b: &Option<T>, descending: bool) -> Ordering {',
        '    match (a, b) {',
        '        (Some(a), Some(b)) => {',
        '            let order = a.partial_cmp(b).unwrap_or(Ordering::Equal);',
        '            if descending { order.reverse() } else { order }',
        '        }',
        '        (Some(_), None) => Ordering::Less,',
        '        (None, Some(_)) => Ordering::Greater,',
        '        (None, None) => Ordering::Equal,',
        '    }',
        '}',
      ],
    ),
    file(
      'src/common/query.rs',
      'Keys in paths and values in query strings are text: they are read with their type, and a malformed one is a 400.',
      ['chrono::{DateTime, NaiveDate, Utc}', 'std::collections::HashMap', 'uuid::Uuid', 'crate::common::error::ApiError'],
      [
        rsDoc('The values of a query string or of the parameters of a path, by name.'),
        'pub type Params = HashMap<String, String>;',
        '',
        'pub fn long_key(params: &Params, name: &str) -> Result<i64, ApiError> {',
        '    params.get(name).and_then(|text| text.parse().ok()).ok_or_else(|| ApiError::invalid(name, "Must be a whole number"))',
        '}',
        '',
        'pub fn uuid_key(params: &Params, name: &str) -> Result<Uuid, ApiError> {',
        '    params.get(name).and_then(|text| parse_uuid(text)).ok_or_else(|| ApiError::invalid(name, "Must be a UUID"))',
        '}',
        '',
        'pub fn text_key(params: &Params, name: &str) -> Result<String, ApiError> {',
        '    params.get(name).cloned().ok_or_else(|| ApiError::invalid(name, "Is missing"))',
        '}',
        '',
        rsDoc('A whole number of the query string within its limits; the default when it is not there.'),
        'pub fn int_query(query: &Params, name: &str, default: u64, min: u64, max: Option<u64>) -> Result<u64, ApiError> {',
        '    let Some(text) = query.get(name) else {',
        '        return Ok(default);',
        '    };',
        '    match text.parse::<u64>() {',
        '        Ok(value) if value >= min && max.is_none_or(|max| value <= max) => Ok(value),',
        '        _ => Err(ApiError::invalid(name, "Must be a whole number within its limits")),',
        '    }',
        '}',
        '',
        rsDoc('A filter of the query string read with its type, or None when it is not there; a malformed one is a 400.'),
        'pub fn filter<T>(query: &Params, name: &str, parse: impl Fn(&str) -> Option<T>) -> Result<Option<T>, ApiError> {',
        '    match query.get(name) {',
        '        None => Ok(None),',
        '        Some(text) => parse(text).map(Some).ok_or_else(|| ApiError::invalid(name, "Has the wrong format")),',
        '    }',
        '}',
        '',
        rsDoc('A value of the query string that must be one of the choices.'),
        'pub fn choice_query(query: &Params, name: &str, choices: &[&str]) -> Result<Option<String>, ApiError> {',
        '    match query.get(name) {',
        '        None => Ok(None),',
        '        Some(text) if choices.contains(&text.as_str()) => Ok(Some(text.clone())),',
        '        Some(_) => Err(ApiError::invalid(name, format!("Must be one of: {}", choices.join(", ")))),',
        '    }',
        '}',
        '',
        rsDoc('A UUID written as 8-4-4-4-12 hexadecimal digits.'),
        'pub fn parse_uuid(text: &str) -> Option<Uuid> {',
        "    let canonical = text.len() == 36 && text.chars().enumerate().all(|(index, char)| if [8, 13, 18, 23].contains(&index) { char == '-' } else { char.is_ascii_hexdigit() });",
        '    if canonical { Uuid::parse_str(text).ok() } else { None }',
        '}',
        '',
        'pub fn parse_date(text: &str) -> Option<NaiveDate> {',
        '    NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()',
        '}',
        '',
        'pub fn parse_date_time(text: &str) -> Option<DateTime<Utc>> {',
        '    DateTime::parse_from_rfc3339(text).ok().map(|value| value.with_timezone(&Utc))',
        '}',
      ],
    ),
    file(
      'src/common/clock.rs',
      'The time the server writes, in UTC.',
      ['chrono::{DateTime, NaiveDate, SubsecRound, Utc}'],
      [
        rsDoc('Now, to the microsecond: what databases keep, so a later read gives the same value.'),
        'pub fn now() -> DateTime<Utc> {',
        '    Utc::now().trunc_subsecs(6)',
        '}',
        '',
        'pub fn today() -> NaiveDate {',
        '    Utc::now().date_naive()',
        '}',
        '',
        rsDoc('Now as ISO 8601 text, for a text field the server fills.'),
        'pub fn text() -> String {',
        '    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()',
        '}',
      ],
    ),
    settingsFile(context),
  ]
}

/** Settings of the API, read from the environment; the tests build their own. */
function settingsFile(context: AxumContext): GeneratedFile {
  const { auth, database } = context.settings
  const fields = [
    context.seaOrm && '    /// Connection URL of the database (DATABASE_URL)\n    pub database_url: String,',
    auth === 'apiKey' && '    /// Accepted API keys (API_KEYS, separated by commas)\n    pub api_keys: Vec<String>,',
    auth === 'jwt' && [
      '    /// Secret that signs the tokens (JWT_SECRET); without it every token is rejected',
      '    pub jwt_secret: String,',
      '    /// Expected audience and issuer of the tokens, when set',
      '    pub jwt_audience: String,',
      '    pub jwt_issuer: String,',
    ],
  ]
  const reads = [
    context.seaOrm &&
      `            database_url: read("DATABASE_URL").unwrap_or_else(|| ${rsString(DATABASE_URLS[database ?? 'postgresql'])}.to_string()),`,
    auth === 'apiKey' &&
      '            api_keys: read("API_KEYS").unwrap_or_default().split(\',\').map(str::trim).filter(|key| !key.is_empty()).map(String::from).collect(),',
    auth === 'jwt' && [
      '            jwt_secret: read("JWT_SECRET").unwrap_or_default(),',
      '            jwt_audience: read("JWT_AUDIENCE").unwrap_or_default(),',
      '            jwt_issuer: read("JWT_ISSUER").unwrap_or_default(),',
    ],
  ]
  const empty = !context.seaOrm && auth === 'none'
  return file(
    'src/common/settings.rs',
    'Settings of the API, read from the environment (see .env.example).',
    [],
    [
      rsDoc('Settings of the API. The tests build their own.'),
      '#[derive(Clone, Debug, Default)]',
      empty ? 'pub struct Settings {}' : ['pub struct Settings {', fields, '}'],
      '',
      'impl Settings {',
      '    pub fn from_env() -> Self {',
      empty
        ? '        Self {}'
        : [
            '        let read = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());',
            '        Self {',
            reads,
            '        }',
          ],
      '    }',
      '}',
    ],
  )
}

/** Authentication: an extractor that a protected handler asks for. */
export function securityFile(context: AxumContext): GeneratedFile | null {
  const { auth } = context.settings
  if (auth === 'none') return null
  const uses = ['axum::extract::FromRequestParts', 'axum::http::request::Parts', 'crate::AppState', 'crate::common::error::ApiError']
  if (auth === 'jwt')
    uses.push('axum::http::header::AUTHORIZATION', 'jsonwebtoken::{Algorithm, DecodingKey, Validation, decode}', 'serde::Deserialize')
  const body: Lines[] =
    auth === 'apiKey'
      ? [
          rsDoc(
            'API key authentication: a handler that asks for it only runs with one of the keys in API_KEYS (header\nX-API-Key). Without API_KEYS, no request is authenticated.',
          ),
          'pub struct Authenticated;',
          '',
          'impl FromRequestParts<AppState> for Authenticated {',
          '    type Rejection = ApiError;',
          '',
          '    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {',
          '        let key = parts.headers.get("x-api-key").and_then(|value| value.to_str().ok()).unwrap_or("");',
          '        if key.is_empty() || !state.settings.api_keys.iter().any(|valid| same(valid, key)) {',
          '            return Err(ApiError::unauthorized());',
          '        }',
          '        Ok(Self)',
          '    }',
          '}',
          '',
          rsDoc('Compares in constant time, so the answer time says nothing about the key.'),
          'fn same(a: &str, b: &str) -> bool {',
          '    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |difference, (x, y)| difference | (x ^ y)) == 0',
          '}',
        ]
      : [
          rsDoc(
            'Bearer token authentication. Tokens are issued by your identity provider; this API only verifies them with\nJWT_SECRET (HS256, and JWT_AUDIENCE / JWT_ISSUER when set), requires an expiry and reads the roles from the\n"roles" claim.',
          ),
          'pub struct Authenticated {',
          '    roles: Vec<String>,',
          '}',
          '',
          'impl Authenticated {',
          '    /// Rejects the call with 403 unless the token holds one of the roles.',
          '    pub fn require_roles(&self, roles: &[&str]) -> Result<(), ApiError> {',
          '        if roles.iter().any(|role| self.roles.iter().any(|granted| granted == role)) {',
          '            Ok(())',
          '        } else {',
          '            Err(ApiError::forbidden())',
          '        }',
          '    }',
          '}',
          '',
          '#[derive(Deserialize)]',
          'struct Claims {',
          '    #[serde(default)]',
          '    roles: Vec<String>,',
          '}',
          '',
          'impl FromRequestParts<AppState> for Authenticated {',
          '    type Rejection = ApiError;',
          '',
          '    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {',
          '        let settings = &state.settings;',
          '        let header = parts.headers.get(AUTHORIZATION).and_then(|value| value.to_str().ok()).unwrap_or("");',
          '        let token = header.strip_prefix("Bearer ").unwrap_or("");',
          '        if token.is_empty() || settings.jwt_secret.is_empty() {',
          '            return Err(ApiError::unauthorized());',
          '        }',
          '        let mut validation = Validation::new(Algorithm::HS256);',
          '        validation.set_required_spec_claims(&["exp"]);',
          '        if settings.jwt_audience.is_empty() {',
          '            validation.validate_aud = false;',
          '        } else {',
          '            validation.set_audience(&[settings.jwt_audience.as_str()]);',
          '        }',
          '        if !settings.jwt_issuer.is_empty() {',
          '            validation.set_issuer(&[settings.jwt_issuer.as_str()]);',
          '        }',
          '        let key = DecodingKey::from_secret(settings.jwt_secret.as_bytes());',
          '        let claims = decode::<Claims>(token, &key, &validation).map_err(|_| ApiError::unauthorized())?.claims;',
          '        Ok(Self { roles: claims.roles })',
          '    }',
          '}',
        ]
  return file('src/security.rs', 'Authentication of the protected endpoints.', uses, body)
}

/** The database: connection, and the tables of every resource. */
export function databaseFile(context: AxumContext): GeneratedFile | null {
  if (!context.seaOrm) return null
  const entities = context.spec.resources.map((resource) => `crate::${context.layout.resource(resource, 'entity')}`)
  const create = context.spec.resources.map(
    (resource, index) =>
      `    database.execute(&schema.create_table_from_entity(${names(resource).module}_${index}::Entity).if_not_exists().to_owned()).await?;`,
  )
  const drop = context.spec.resources.map(
    (resource, index) =>
      `    database.execute(&Table::drop().table(${names(resource).module}_${index}::Entity).if_exists().to_owned()).await?;`,
  )
  const sqlite = context.settings.database === 'sqlite'
  return file(
    'src/database.rs',
    'The database of the API: its connection and its tables, one per resource.',
    [
      'sea_orm::sea_query::Table',
      'sea_orm::{ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbErr, Schema}',
      'crate::common::settings::Settings',
      ...entities.map((path, index) => `${path} as ${names(context.spec.resources[index]).module}_${index}`),
    ],
    [
      rsDoc(
        'Connects to the database of DATABASE_URL and creates the tables it does not have, while you develop; use\nmigrations for a real database (Model2DB writes them).',
      ),
      'pub async fn connect(settings: &Settings) -> Result<DatabaseConnection, DbErr> {',
      '    let mut options = ConnectOptions::new(settings.database_url.clone());',
      '    options.sqlx_logging(false);',
      sqlite && ['    // SQLite allows one writer at a time', '    options.max_connections(1);'],
      '    let database = Database::connect(options).await?;',
      '    create_tables(&database).await?;',
      '    Ok(database)',
      '}',
      '',
      rsDoc('Creates the tables that are missing.'),
      'pub async fn create_tables(database: &DatabaseConnection) -> Result<(), DbErr> {',
      '    let schema = Schema::new(database.get_database_backend());',
      create,
      '    Ok(())',
      '}',
      '',
      rsDoc('Drops every table of the API: for a database only for tests.'),
      'pub async fn drop_tables(database: &DatabaseConnection) -> Result<(), DbErr> {',
      drop,
      '    Ok(())',
      '}',
    ],
  )
}

/** src/main.rs: starts the API on PORT with the settings of the environment. */
export function mainFile(context: AxumContext): GeneratedFile {
  return file(
    'src/main.rs',
    'Starts the API on PORT (8080 by default) with the settings of the environment.',
    [`${context.crate}::build`, `${context.crate}::common::settings::Settings`],
    [
      '#[tokio::main]',
      'async fn main() {',
      '    tracing_subscriber::fmt::init();',
      '    let port = std::env::var("PORT").ok().and_then(|port| port.parse::<u16>().ok()).unwrap_or(8080);',
      '    let app = build(Settings::from_env()).await.expect("the API could not start");',
      '    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("the port is free");',
      '    tracing::info!("Listening on http://localhost:{port}");',
      '    axum::serve(listener, app).await.expect("the server stopped");',
      '}',
    ],
  )
}

/** The modules of a folder, from the paths of the files generated in it. */
function moduleTree(paths: string[]): Map<string, Set<string>> {
  const tree = new Map<string, Set<string>>()
  for (const path of paths) {
    if (!path.startsWith('src/') || !path.endsWith('.rs') || path === 'src/main.rs' || path === 'src/lib.rs') continue
    const parts = path.slice(4, -3).split('/')
    for (let depth = 0; depth < parts.length; depth++) {
      const folder = parts.slice(0, depth).join('/')
      if (!tree.has(folder)) tree.set(folder, new Set())
      tree.get(folder)!.add(parts[depth])
    }
  }
  return tree
}

/** What each folder of the crate holds, for the documentation of its `mod.rs`. */
const FOLDERS: Record<string, string> = {
  common: 'What every resource shares: errors, request bodies, lists, query strings, the clock and the settings.',
  models: 'Domain types, enums and embedded objects.',
  dtos: 'Request bodies and responses.',
  repositories: 'Where each resource is kept.',
  entities: 'The tables of the database, as SeaORM entities.',
  services: 'The rules of each resource.',
  routes: 'The HTTP routes of each resource.',
  shared: 'Enums and embedded objects shared by the resources.',
}

/** The `mod.rs` of every folder, and `lib.rs` with the state and the router of the application. */
export function moduleFiles(context: AxumContext, paths: string[]): GeneratedFile[] {
  const tree = moduleTree(paths)
  const files: GeneratedFile[] = []
  for (const [folder, modules] of tree) {
    if (folder === '') continue
    const resource = context.spec.resources.find((item) => resourceModule(item) === folder)
    const doc = FOLDERS[folder] ?? (resource ? `Everything about ${resource.plural}.` : `The ${folder} of the API.`)
    files.push({
      path: `src/${folder}/mod.rs`,
      content: fileText(
        lines(
          `//! ${doc}`,
          '',
          [...modules].sort().map((module) => `pub mod ${module};`),
        ),
      ),
    })
  }
  files.push(libFile(context, [...(tree.get('') ?? [])].sort()))
  return files
}

function libFile(context: AxumContext, modules: string[]): GeneratedFile {
  const uses = new RsUses().add(
    'axum::Router',
    'std::sync::Arc',
    'tower_http::catch_panic::CatchPanicLayer',
    'crate::common::error::{no_route, panic_response, wrong_method}',
    'crate::common::settings::Settings',
  )
  const fields: string[] = []
  const repositories: string[] = []
  const services: string[] = []
  const routes: string[] = []
  for (const resource of context.spec.resources) {
    const name = names(resource)
    const repository = context.layout.resource(resource, 'repository')
    const implementation = context.pending ? name.pendingRepository : context.seaOrm ? name.seaOrmRepository : name.memory
    uses.add(
      `crate::${repository}::{${implementation}, ${name.repository}}`,
      `crate::${context.layout.resource(resource, 'service')}::${name.service}`,
    )
    fields.push(`    pub ${name.state}: Arc<${name.service}>,`)
    const created = context.seaOrm ? `${implementation}::new(database.clone())` : `${implementation}::default()`
    repositories.push(`    let ${name.one}_repository: Arc<dyn ${name.repository}> = Arc::new(${created});`)
    const needs = referencedResources(context, resource).map((item) => `${names(item).one}_repository.clone()`)
    services.push(`        ${name.state}: Arc::new(${name.service}::new(${[`${name.one}_repository.clone()`, ...needs].join(', ')})),`)
    routes.push(`        .merge(crate::${context.layout.resource(resource, 'routes')}::router())`)
  }
  const content = lines(
    '//! The API: the state every handler shares, and the router with every route.',
    '',
    modules.map((module) => `pub mod ${module};`),
    '',
    uses.render(),
    '',
    rsDoc('What every handler shares: the settings and the service of each resource.'),
    '#[derive(Clone)]',
    'pub struct AppState {',
    '    pub settings: Arc<Settings>,',
    fields,
    '}',
    '',
    rsDoc('Builds the API with its storage: the router that main serves and the tests call.'),
    'pub async fn build(settings: Settings) -> Result<Router, Box<dyn std::error::Error>> {',
    context.seaOrm && '    let database = database::connect(&settings).await?;',
    repositories,
    '    let state = AppState {',
    '        settings: Arc::new(settings),',
    services,
    '    };',
    '    Ok(Router::new()',
    routes,
    '        .fallback(no_route)',
    '        .method_not_allowed_fallback(wrong_method)',
    '        .layer(CatchPanicLayer::custom(panic_response))',
    '        .with_state(state))',
    '}',
  )
  return { path: 'src/lib.rs', content: fileText(content) }
}
