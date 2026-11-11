/**
 * Tests of the Axum project (`cargo test`, one integration test crate in tests/api/). They call every enabled
 * endpoint through the router, the way a client would, with the same cases as every other framework
 * (common/testing.ts). Each test builds the application anew, so it starts with empty storage and can count
 * items exactly.
 */
import type { SpecEndpoint, SpecResource } from '../../../api/spec.ts'
import { sampleBody, updatableField, type JsonValue, type SampleReference } from '../../common/samples.ts'
import {
  TEST_API_KEY,
  TEST_JWT_SECRET,
  comparableFields,
  creatable,
  findEndpoint,
  fixedPath,
  keyWire,
  missingKey,
  pathWithKey,
  protectedEndpoint,
  requiredField,
  roleEndpoint,
  sampleKeysDiffer,
} from '../../common/testing.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines, type Lines } from '../../common/text.ts'
import { RsUses, rsDoc, rsString } from '../../languages/rust/rust.ts'
import { article, names, type AxumContext } from './context.ts'

/** A Rust expression for a path whose key is the variable `key`. */
function url(endpoint: SpecEndpoint, resource: SpecResource): string {
  const path = pathWithKey(endpoint, resource)
  return path.includes('{key}') ? `&format!(${rsString(path)})` : rsString(path)
}

/** A JSON pointer to a place in a body: `/lines/0/productId`. */
function pointer(path: SampleReference['path']): string {
  return path.map((part) => `/${String(part).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('')
}

/** A JSON value written in Rust: parsed from its text. */
function json(value: JsonValue): string {
  return `parse(${rsString(JSON.stringify(value))})`
}

/** A Rust function name from a test title. */
function testName(title: string): string {
  const name = title
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return /^[0-9]/.test(name) ? `test_${name}` : name || 'test'
}

/** tests/api/main.rs: the test crate, one module per resource. */
function mainFile(context: AxumContext): GeneratedFile {
  const content = lines(
    '//! Tests of the API: each module calls the endpoints of one resource through the router.',
    '',
    'mod support;',
    context.spec.resources.map((resource) => `mod ${names(resource).test};`),
  )
  return { path: 'tests/api/main.rs', content: fileText(content) }
}

/** The base of the tests: a new application for each test, the client, credentials and builders of valid bodies. */
function supportFile(context: AxumContext): GeneratedFile {
  const { auth } = context.settings
  const crate = context.crate
  const uses = new RsUses().add(
    'axum::Router',
    'axum::body::Body',
    'axum::http::Request',
    'serde_json::Value',
    'tower::ServiceExt',
    `${crate}::build`,
    `${crate}::common::settings::Settings`,
  )
  if (context.seaOrm) uses.add('tokio::sync::{Mutex, MutexGuard}', 'uuid::Uuid', `${crate}::database::drop_tables`)
  if (auth === 'jwt') uses.add('jsonwebtoken::{EncodingKey, Header, encode}', 'std::time::{SystemTime, UNIX_EPOCH}')

  const credentials = [
    auth === 'apiKey' && '        api_keys: vec![TEST_API_KEY.to_string()],',
    auth === 'jwt' && '        jwt_secret: TEST_JWT_SECRET.to_string(),',
  ]
  const settings: Lines = context.seaOrm
    ? [
        rsDoc('Turns on a shared database: one test at a time, each with the tables dropped first.'),
        'static TURN: Mutex<()> = Mutex::const_new(());',
        '',
        rsDoc(
          'Settings of the application under test. TEST_DATABASE_URL runs the tests on that database, emptied first;\nwithout it, each test has its own SQLite file.',
        ),
        "async fn settings() -> (Settings, Option<MutexGuard<'static, ()>>) {",
        '    let shared = std::env::var("TEST_DATABASE_URL").unwrap_or_default();',
        '    let (database_url, turn) = if shared.is_empty() {',
        '        let file = std::env::temp_dir().join(format!("api-test-{}.db", Uuid::new_v4()));',
        '        (format!("sqlite://{}?mode=rwc", file.display()), None)',
        '    } else {',
        '        let turn = TURN.lock().await;',
        '        let database = sea_orm::Database::connect(&shared).await.expect("the test database answers");',
        '        drop_tables(&database).await.expect("the tables can be dropped");',
        '        database.close().await.ok();',
        '        (shared, Some(turn))',
        '    };',
        '    let settings = Settings {',
        '        database_url,',
        credentials,
        '        ..Default::default()',
        '    };',
        '    (settings, turn)',
        '}',
      ]
    : [
        rsDoc('Settings of the application under test.'),
        auth === 'none'
          ? 'fn settings() -> Settings {\n    Settings::default()\n}'
          : ['fn settings() -> Settings {', '    Settings {', credentials, '        ..Default::default()', '    }', '}'],
      ]

  const builders: string[] = []
  for (const resource of context.spec.resources) {
    if (!creatable(context.spec, resource)) continue
    const name = names(resource)
    const create = findEndpoint(resource, 'create')!
    const first = sampleBody(context.spec, resource, 0).sample
    const second = sampleBody(context.spec, resource, 1).sample
    const fills = first.references.map((reference) => {
      const target = context.spec.resources.find((item) => item.name === reference.resource)!
      return `        body = with(body, ${rsString(pointer(reference.path))}, self.create_${names(target).one}(0).await[${rsString(keyWire(target))}].clone());`
    })
    builders.push(
      lines(
        `    /// A valid body to create ${article(resource.singular)}, with the items it refers to created first.`,
        `    pub async fn ${name.one}_payload(&self, variant: usize) -> Value {`,
        `        let ${fills.length > 0 ? 'mut ' : ''}body = if variant == 0 { ${json(first.body as JsonValue)} } else { ${json(second.body as JsonValue)} };`,
        fills,
        '        body',
        '    }',
        '',
        `    /// Creates ${article(resource.singular)} and returns it as the API answers.`,
        `    pub async fn create_${name.one}(&self, variant: usize) -> Value {`,
        `        let payload = self.${name.one}_payload(variant).await;`,
        `        let response = self.post(${rsString(create.path)}, &payload, &headers()).await;`,
        `        response.assert_status(${create.status});`,
        '        response.json',
        '    }',
      ),
    )
  }

  const content = lines(
    '//! Base of the tests: a new application for each test, so each one starts with empty storage.',
    '',
    '// Each test module uses only some of these helpers',
    '#![allow(dead_code)]',
    '',
    uses.render(),
    '',
    auth === 'apiKey' && [`pub const TEST_API_KEY: &str = ${rsString(TEST_API_KEY)};`, ''],
    auth === 'jwt' && [`pub const TEST_JWT_SECRET: &str = ${rsString(TEST_JWT_SECRET)};`, ''],
    settings,
    '',
    rsDoc('Headers of a client allowed to call every endpoint.'),
    auth === 'none' && "pub fn headers() -> Vec<(&'static str, String)> {\n    Vec::new()\n}",
    auth === 'apiKey' && 'pub fn headers() -> Vec<(&\'static str, String)> {\n    vec![("x-api-key", TEST_API_KEY.to_string())]\n}',
    auth === 'jwt' && [
      "pub fn headers() -> Vec<(&'static str, String)> {",
      `    vec![("authorization", format!("Bearer {}", token(&[${context.spec.roles.map(rsString).join(', ')}])))]`,
      '}',
      '',
      rsDoc('Headers of a client with a valid token but no role.'),
      "pub fn headers_without_roles() -> Vec<(&'static str, String)> {",
      '    vec![("authorization", format!("Bearer {}", token(&[])))]',
      '}',
      '',
      rsDoc('A token signed with the test secret, valid for one hour.'),
      'pub fn token(roles: &[&str]) -> String {',
      '    let now = SystemTime::now().duration_since(UNIX_EPOCH).expect("the clock is after 1970").as_secs();',
      '    let claims = serde_json::json!({ "sub": "tests", "roles": roles, "exp": now + 3600 });',
      '    encode(&Header::default(), &claims, &EncodingKey::from_secret(TEST_JWT_SECRET.as_bytes())).expect("the token is signed")',
      '}',
    ],
    '',
    rsDoc('The application under test, called through its router.'),
    'pub struct Api {',
    '    router: Router,',
    context.seaOrm && "    _turn: Option<MutexGuard<'static, ()>>,",
    '}',
    '',
    rsDoc('The answer of a request in a test: its status and its JSON body (null when it has none).'),
    'pub struct TestResponse {',
    '    pub status: u16,',
    '    pub text: String,',
    '    pub json: Value,',
    '}',
    '',
    'impl TestResponse {',
    '    pub fn assert_status(&self, expected: u16) {',
    '        assert_eq!(expected, self.status, "{}", self.text);',
    '    }',
    '}',
    '',
    'impl Api {',
    '    pub async fn new() -> Self {',
    context.seaOrm
      ? [
          '        let (settings, turn) = settings().await;',
          '        let router = build(settings).await.expect("the API starts");',
          '        Self { router, _turn: turn }',
        ]
      : ['        let router = build(settings()).await.expect("the API starts");', '        Self { router }'],
    '    }',
    '',
    "    pub async fn get(&self, path: &str, headers: &[(&'static str, String)]) -> TestResponse {",
    '        self.send("GET", path, None, headers).await',
    '    }',
    '',
    "    pub async fn post(&self, path: &str, body: &Value, headers: &[(&'static str, String)]) -> TestResponse {",
    '        self.send("POST", path, Some(body), headers).await',
    '    }',
    '',
    "    pub async fn put(&self, path: &str, body: &Value, headers: &[(&'static str, String)]) -> TestResponse {",
    '        self.send("PUT", path, Some(body), headers).await',
    '    }',
    '',
    "    pub async fn patch(&self, path: &str, body: &Value, headers: &[(&'static str, String)]) -> TestResponse {",
    '        self.send("PATCH", path, Some(body), headers).await',
    '    }',
    '',
    "    pub async fn delete(&self, path: &str, headers: &[(&'static str, String)]) -> TestResponse {",
    '        self.send("DELETE", path, None, headers).await',
    '    }',
    '',
    '    /// Sends a request, with a JSON body when there is one.',
    "    pub async fn send(&self, method: &str, path: &str, body: Option<&Value>, headers: &[(&'static str, String)]) -> TestResponse {",
    '        let mut request = Request::builder().method(method).uri(path);',
    '        for (name, value) in headers {',
    '            request = request.header(*name, value);',
    '        }',
    '        let request = match body {',
    '            Some(body) => request.header("content-type", "application/json").body(Body::from(body.to_string())),',
    '            None => request.body(Body::empty()),',
    '        }',
    '        .expect("the request is valid");',
    '        let response = self.router.clone().oneshot(request).await.expect("the router answers");',
    '        let status = response.status().as_u16();',
    '        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("the body can be read");',
    '        let text = String::from_utf8_lossy(&bytes).into_owned();',
    '        let json = serde_json::from_str(&text).unwrap_or(Value::Null);',
    '        TestResponse { status, text, json }',
    '    }',
    builders.length > 0 && ['', builders.join('\n\n')],
    '}',
    '',
    rsDoc('A JSON value from its text.'),
    'pub fn parse(text: &str) -> Value {',
    '    serde_json::from_str(text).expect("the JSON of the test is valid")',
    '}',
    '',
    rsDoc('The text of a key in a JSON answer, for a path.'),
    'pub fn text(value: &Value) -> String {',
    '    value.as_str().map(String::from).unwrap_or_else(|| value.to_string())',
    '}',
    '',
    rsDoc('A copy of a JSON value with another value at a JSON pointer: "/lines/0/productId".'),
    'pub fn with(mut value: Value, pointer: &str, new: Value) -> Value {',
    '    let (parent, last) = pointer.rsplit_once(\'/\').expect("the pointer starts with /");',
    '    let last = last.replace("~1", "/").replace("~0", "~");',
    '    match value.pointer_mut(parent) {',
    '        Some(Value::Object(map)) => {',
    '            map.insert(last, new);',
    '        }',
    '        Some(Value::Array(items)) => {',
    '            if let Some(item) = last.parse::<usize>().ok().and_then(|index| items.get_mut(index)) {',
    '                *item = new;',
    '            }',
    '        }',
    '        _ => {}',
    '    }',
    '    value',
    '}',
    '',
    rsDoc('A copy of a JSON object without a field.'),
    'pub fn without(mut value: Value, field: &str) -> Value {',
    '    if let Some(map) = value.as_object_mut() {',
    '        map.remove(field);',
    '    }',
    '    value',
    '}',
  )
  return { path: 'tests/api/support.rs', content: fileText(content) }
}

/** An assertion that a value of a JSON answer equals a sample value. */
function assertValue(value: JsonValue, actual: string): string {
  if (typeof value === 'number') return `assert_eq!(Some(${Number.isInteger(value) ? `${value}.0` : value}), ${actual}.as_f64());`
  return `assert_eq!(${json(value)}, ${actual});`
}

function resourceTestFile(context: AxumContext, resource: SpecResource): GeneratedFile {
  const name = names(resource)
  const key = keyWire(resource)
  const tests: string[] = []
  const canCreate = creatable(context.spec, resource)
  const problem = sampleBody(context.spec, resource, 0).problem
  const get = findEndpoint(resource, 'get')
  const create = findEndpoint(resource, 'create')
  const list = findEndpoint(resource, 'list')
  const used = new Set<string>()
  const test = (title: string, body: Lines[], skip?: string) => {
    let fn = testName(title)
    for (let n = 2; used.has(fn); n++) fn = `${testName(title)}_${n}`
    used.add(fn)
    tests.push(
      skip
        ? lines('#[test]', `#[ignore = ${rsString(skip)}]`, `fn ${fn}() {`, ...body, '}')
        : lines('#[tokio::test]', `async fn ${fn}() {`, '    let api = Api::new().await;', ...body, '}'),
    )
  }
  const createdKey = [`    let created = api.create_${name.one}(0).await;`, `    let key = text(&created[${rsString(key)}]);`]
  const code = 'response.json["error"]["code"]'

  if (context.pending) {
    for (const endpoint of [list, get].filter(Boolean) as SpecEndpoint[]) {
      test(`${endpoint.name} answers 501 until the storage is written`, [
        `    let response = api.get(${rsString(fixedPath(endpoint, resource, missingKey(resource)))}, &headers()).await;`,
        '',
        '    response.assert_status(501);',
        `    assert_eq!(${code}, "not_implemented");`,
      ])
    }
  } else {
    if (create && !canCreate) {
      test(
        `creates ${article(resource.singular)}`,
        [`    // TODO: ${problem ?? 'write a body with the items it refers to'}`],
        problem ?? 'An item it refers to cannot be created through the API.',
      )
    }
    if (canCreate) {
      const sent = sampleBody(context.spec, resource, 0).sample.body
      test(`creates ${article(resource.singular)}`, [
        `    let payload = api.${name.one}_payload(0).await;`,
        '',
        `    let response = api.post(${rsString(create!.path)}, &payload, &headers()).await;`,
        '',
        `    response.assert_status(${create!.status});`,
        `    assert!(response.json.get(${rsString(key)}).is_some());`,
        comparableFields(resource, sent).map((wire) => `    assert_eq!(payload[${rsString(wire)}], response.json[${rsString(wire)}]);`),
      ])
      const required = requiredField(resource)
      if (required) {
        test(`rejects ${article(resource.singular)} without ${required.wire}`, [
          `    let payload = without(api.${name.one}_payload(0).await, ${rsString(required.wire)});`,
          '',
          `    let response = api.post(${rsString(create!.path)}, &payload, &headers()).await;`,
          '',
          '    response.assert_status(400);',
          `    assert_eq!(${code}, "validation_error");`,
          `    let details = response.json["error"]["details"].as_array().cloned().unwrap_or_default();`,
          `    assert!(details.iter().any(|detail| detail["field"] == ${rsString(required.wire)}));`,
        ])
      }
      if (resource.key.generated === null) {
        test(`rejects a second ${resource.singular} with the same key`, [
          `    let created = api.create_${name.one}(0).await;`,
          `    let payload = with(api.${name.one}_payload(0).await, ${rsString(pointer([key]))}, created[${rsString(key)}].clone());`,
          '',
          `    let response = api.post(${rsString(create!.path)}, &payload, &headers()).await;`,
          '',
          '    response.assert_status(409);',
        ])
      }
    }
    if (get) {
      if (canCreate) {
        test(`gets ${article(resource.singular)}`, [
          ...createdKey,
          '',
          `    let response = api.get(${url(get, resource)}, &headers()).await;`,
          '',
          '    response.assert_status(200);',
          '    assert_eq!(created, response.json);',
        ])
      }
      test(`answers 404 for a missing ${resource.singular}`, [
        `    let response = api.get(${rsString(fixedPath(get, resource, missingKey(resource)))}, &headers()).await;`,
        '',
        '    response.assert_status(404);',
        `    assert_eq!(${code}, "not_found");`,
      ])
    }
    if (list) {
      const distinct = sampleKeysDiffer(context.spec, resource)
      const count = canCreate ? (distinct ? 2 : 1) : 0
      test(`lists ${resource.plural}`, [
        canCreate && `    api.create_${name.one}(0).await;`,
        canCreate && distinct && `    api.create_${name.one}(1).await;`,
        '',
        `    let response = api.get(${rsString(list.path)}, &headers()).await;`,
        '',
        '    response.assert_status(200);',
        list.pagination
          ? [`    assert_eq!(response.json["total"], ${count});`, '    assert_eq!(response.json["page"], 1);']
          : `    assert_eq!(response.json.as_array().map(Vec::len), Some(${count}));`,
      ])
      if (list.pagination && canCreate && distinct) {
        test(`lists ${resource.plural} by page`, [
          `    api.create_${name.one}(0).await;`,
          `    api.create_${name.one}(1).await;`,
          '',
          `    let response = api.get(${rsString(`${list.path}?page=2&size=1`)}, &headers()).await;`,
          '',
          '    response.assert_status(200);',
          '    assert_eq!(response.json["total"], 2);',
          '    assert_eq!(response.json["items"].as_array().map(Vec::len), Some(1));',
          '    assert_eq!(response.json["page"], 2);',
        ])
      }
      if (list.pagination) {
        test('rejects a page that does not exist', [
          `    let response = api.get(${rsString(`${list.path}?page=0`)}, &headers()).await;`,
          '',
          '    response.assert_status(400);',
        ])
      }
    }
    const replace = findEndpoint(resource, 'replace')
    if (replace && canCreate) {
      const compared = comparableFields(resource, sampleBody(context.spec, resource, 1).sample.body).filter((wire) => wire !== key)
      test(`replaces ${article(resource.singular)}`, [
        ...createdKey,
        resource.key.generated === null
          ? `    let payload = with(api.${name.one}_payload(1).await, ${rsString(pointer([key]))}, created[${rsString(key)}].clone());`
          : `    let payload = api.${name.one}_payload(1).await;`,
        '',
        `    let response = api.put(${url(replace, resource)}, &payload, &headers()).await;`,
        '',
        '    response.assert_status(200);',
        compared.map((wire) => `    assert_eq!(payload[${rsString(wire)}], response.json[${rsString(wire)}]);`),
      ])
    }
    const update = findEndpoint(resource, 'update')
    const field = updatableField(resource)
    if (update && canCreate && field) {
      const value = sampleBody(context.spec, resource, 1).sample.body[field.wire] ?? null
      test(`updates part of ${article(resource.singular)}`, [
        ...createdKey,
        '',
        `    let response = api.patch(${url(update, resource)}, &${json({ [field.wire]: value })}, &headers()).await;`,
        '',
        '    response.assert_status(200);',
        `    ${assertValue(value, `response.json[${rsString(field.wire)}]`)}`,
      ])
      if (!field.nullable) {
        test(`rejects null for ${field.wire}`, [
          ...createdKey,
          '',
          `    let response = api.patch(${url(update, resource)}, &${json({ [field.wire]: null })}, &headers()).await;`,
          '',
          '    response.assert_status(400);',
        ])
      }
    }
    const remove = findEndpoint(resource, 'delete')
    if (remove && canCreate) {
      test(`deletes ${article(resource.singular)}`, [
        ...createdKey,
        '',
        `    let response = api.delete(${url(remove, resource)}, &headers()).await;`,
        '',
        `    response.assert_status(${remove.status});`,
        get && `    api.get(${url(get, resource)}, &headers()).await.assert_status(404);`,
      ])
    }
    for (const endpoint of resource.endpoints.filter((item) => item.operation === 'custom')) {
      const needsItem = endpoint.pathParams.some((param) => param.name === resource.key.param)
      if ((needsItem || endpoint.input === 'resource') && !canCreate) continue
      const body =
        endpoint.input === 'none' ? 'None' : endpoint.input === 'partial' ? 'Some(&parse("{}"))' : `Some(&api.${name.one}_payload(0).await)`
      const path = needsItem ? url(endpoint, resource) : rsString(fixedPath(endpoint, resource, 'sample'))
      test(`${endpoint.name} answers 501 until it is written`, [
        needsItem && createdKey,
        '    // TODO: replace this test when the operation is written',
        `    let response = api.send(${rsString(endpoint.method)}, ${path}, ${body}, &headers()).await;`,
        '',
        '    response.assert_status(501);',
      ])
    }
  }
  const guarded = protectedEndpoint(resource, context.settings.auth)
  if (guarded) {
    test(`${guarded.name} needs credentials`, [
      `    let response = api.get(${rsString(fixedPath(guarded, resource, missingKey(resource)))}, &[]).await;`,
      '',
      '    response.assert_status(401);',
      `    assert_eq!(${code}, "unauthorized");`,
    ])
  }
  const withRoles = roleEndpoint(resource, context.settings.auth)
  if (withRoles) {
    test(`${withRoles.name} needs a role`, [
      `    let response = api.get(${rsString(fixedPath(withRoles, resource, missingKey(resource)))}, &headers_without_roles()).await;`,
      '',
      '    response.assert_status(403);',
    ])
  }
  const body = tests.join('\n\n')
  const patterns: Record<string, RegExp> = {
    Api: /\bApi::new\(/,
    headers: /\bheaders\(/,
    headers_without_roles: /\bheaders_without_roles\(/,
    parse: /\bparse\(/,
    text: /\btext\(/,
    with: /\bwith\(/,
    without: /\bwithout\(/,
  }
  const helpers = Object.keys(patterns).filter((helper) => patterns[helper].test(body))
  const content = lines(
    `//! Tests of the ${resource.plural} endpoints.`,
    '',
    helpers.length > 0 && [`use crate::support::{${helpers.join(', ')}};`, ''],
    tests.length > 0 ? body : ['#[test]', 'fn has_no_endpoints() {}'],
  )
  return { path: `tests/api/${name.test}.rs`, content: fileText(content) }
}

export function testFiles(context: AxumContext): GeneratedFile[] {
  return [mainFile(context), supportFile(context), ...context.spec.resources.map((resource) => resourceTestFile(context, resource))]
}
