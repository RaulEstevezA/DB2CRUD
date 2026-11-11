"""Tests of the Axum project (cargo test, one integration test crate in tests/api/). They call every enabled endpoint
through the router, the way a client would, with the same cases as every other framework (common/testing.py). Each
test builds the application anew, so it starts with empty storage and can count items exactly. Mirrors
web/src/core/generators/frameworks/axum/tests.ts.
"""

import re

from ....js import number_text
from ...common.samples import json_text, sample_body, updatable_field
from ...common.testing import (
    TEST_API_KEY,
    TEST_JWT_SECRET,
    comparable_fields,
    creatable,
    find_endpoint,
    fixed_path,
    key_wire,
    missing_key,
    path_with_key,
    protected_endpoint,
    required_field,
    role_endpoint,
    sample_keys_differ,
)
from ...common.text import file_text, lines
from ...languages.rust.rust import RsUses, rs_doc, rs_string
from .context import AxumContext, article, names


def _url(endpoint: dict, resource: dict) -> str:
    """A Rust expression for a path whose key is the variable key."""
    path = path_with_key(endpoint, resource)
    return f"&format!({rs_string(path)})" if "{key}" in path else rs_string(path)


def _pointer(path: list) -> str:
    """A JSON pointer to a place in a body: /lines/0/productId."""
    return "".join(
        "/" + (number_text(part) if isinstance(part, (int, float)) else part).replace("~", "~0").replace("/", "~1")
        for part in path
    )


def _json(value) -> str:
    """A JSON value written in Rust: parsed from its text."""
    return f"parse({rs_string(json_text(value))})"


_CAMEL = re.compile(r"([a-z0-9])([A-Z])")
_NOT_ALLOWED = re.compile(r"[^a-z0-9]+")


def _test_name(title: str) -> str:
    """A Rust function name from a test title."""
    name = _NOT_ALLOWED.sub("_", _CAMEL.sub(r"\1_\2", title).lower()).strip("_")
    if re.match(r"^[0-9]", name):
        return f"test_{name}"
    return name or "test"


def _main_file(context: AxumContext) -> dict:
    """tests/api/main.rs: the test crate, one module per resource."""
    content = lines(
        "//! Tests of the API: each module calls the endpoints of one resource through the router.",
        "",
        "mod support;",
        [f"mod {names(resource)['test']};" for resource in context.spec["resources"]],
    )
    return {"path": "tests/api/main.rs", "content": file_text(content)}


def _support_file(context: AxumContext) -> dict:
    """The base of the tests: a new application for each test, the client, credentials and builders of valid bodies."""
    auth = context.settings["auth"]
    spec = context.spec
    crate = context.crate
    uses = RsUses().add(
        "axum::Router",
        "axum::body::Body",
        "axum::http::Request",
        "serde_json::Value",
        "tower::ServiceExt",
        f"{crate}::build",
        f"{crate}::common::settings::Settings",
    )
    if context.sea_orm:
        uses.add("tokio::sync::{Mutex, MutexGuard}", "uuid::Uuid", f"{crate}::database::drop_tables")
    if auth == "jwt":
        uses.add("jsonwebtoken::{EncodingKey, Header, encode}", "std::time::{SystemTime, UNIX_EPOCH}")

    credentials = [
        auth == "apiKey" and "        api_keys: vec![TEST_API_KEY.to_string()],",
        auth == "jwt" and "        jwt_secret: TEST_JWT_SECRET.to_string(),",
    ]
    if context.sea_orm:
        settings = [
            rs_doc("Turns on a shared database: one test at a time, each with the tables dropped first."),
            "static TURN: Mutex<()> = Mutex::const_new(());",
            "",
            rs_doc(
                "Settings of the application under test. TEST_DATABASE_URL runs the tests on that database, emptied "
                "first;\nwithout it, each test has its own SQLite file."
            ),
            "async fn settings() -> (Settings, Option<MutexGuard<'static, ()>>) {",
            '    let shared = std::env::var("TEST_DATABASE_URL").unwrap_or_default();',
            "    let (database_url, turn) = if shared.is_empty() {",
            '        let file = std::env::temp_dir().join(format!("api-test-{}.db", Uuid::new_v4()));',
            '        (format!("sqlite://{}?mode=rwc", file.display()), None)',
            "    } else {",
            "        let turn = TURN.lock().await;",
            '        let database = sea_orm::Database::connect(&shared).await.expect("the test database answers");',
            '        drop_tables(&database).await.expect("the tables can be dropped");',
            "        database.close().await.ok();",
            "        (shared, Some(turn))",
            "    };",
            "    let settings = Settings {",
            "        database_url,",
            credentials,
            "        ..Default::default()",
            "    };",
            "    (settings, turn)",
            "}",
        ]
    else:
        settings = [
            rs_doc("Settings of the application under test."),
            "fn settings() -> Settings {\n    Settings::default()\n}"
            if auth == "none"
            else [
                "fn settings() -> Settings {",
                "    Settings {",
                credentials,
                "        ..Default::default()",
                "    }",
                "}",
            ],
        ]

    builders: list[str] = []
    for resource in spec["resources"]:
        if not creatable(spec, resource):
            continue
        name = names(resource)
        create = find_endpoint(resource, "create")
        first = sample_body(spec, resource, 0)["sample"]
        second = sample_body(spec, resource, 1)["sample"]
        fills = []
        for reference in first["references"]:
            target = next(item for item in spec["resources"] if item["name"] == reference["resource"])
            fills.append(
                f"        body = with(body, {rs_string(_pointer(reference['path']))}, "
                f"self.create_{names(target)['one']}(0).await[{rs_string(key_wire(target))}].clone());"
            )
        builders.append(
            lines(
                f"    /// A valid body to create {article(resource['singular'])}, with the items it refers to created first.",
                f"    pub async fn {name['one']}_payload(&self, variant: usize) -> Value {{",
                f"        let {'mut ' if fills else ''}body = if variant == 0 {{ {_json(first['body'])} }} else {{ {_json(second['body'])} }};",
                fills,
                "        body",
                "    }",
                "",
                f"    /// Creates {article(resource['singular'])} and returns it as the API answers.",
                f"    pub async fn create_{name['one']}(&self, variant: usize) -> Value {{",
                f"        let payload = self.{name['one']}_payload(variant).await;",
                f"        let response = self.post({rs_string(create['path'])}, &payload, &headers()).await;",
                f"        response.assert_status({number_text(create['status'])});",
                "        response.json",
                "    }",
            )
        )

    roles = ", ".join(rs_string(role) for role in spec["roles"])
    headers = {
        "none": "pub fn headers() -> Vec<(&'static str, String)> {\n    Vec::new()\n}",
        "apiKey": "pub fn headers() -> Vec<(&'static str, String)> {\n"
        '    vec![("x-api-key", TEST_API_KEY.to_string())]\n}',
        "jwt": [
            "pub fn headers() -> Vec<(&'static str, String)> {",
            f'    vec![("authorization", format!("Bearer {{}}", token(&[{roles}])))]',
            "}",
            "",
            rs_doc("Headers of a client with a valid token but no role."),
            "pub fn headers_without_roles() -> Vec<(&'static str, String)> {",
            '    vec![("authorization", format!("Bearer {}", token(&[])))]',
            "}",
            "",
            rs_doc("A token signed with the test secret, valid for one hour."),
            "pub fn token(roles: &[&str]) -> String {",
            '    let now = SystemTime::now().duration_since(UNIX_EPOCH).expect("the clock is after 1970").as_secs();',
            '    let claims = serde_json::json!({ "sub": "tests", "roles": roles, "exp": now + 3600 });',
            '    encode(&Header::default(), &claims, &EncodingKey::from_secret(TEST_JWT_SECRET.as_bytes())).expect("the token is signed")',
            "}",
        ],
    }[auth]

    content = lines(
        "//! Base of the tests: a new application for each test, so each one starts with empty storage.",
        "",
        "// Each test module uses only some of these helpers",
        "#![allow(dead_code)]",
        "",
        uses.render(),
        "",
        auth == "apiKey" and [f"pub const TEST_API_KEY: &str = {rs_string(TEST_API_KEY)};", ""],
        auth == "jwt" and [f"pub const TEST_JWT_SECRET: &str = {rs_string(TEST_JWT_SECRET)};", ""],
        settings,
        "",
        rs_doc("Headers of a client allowed to call every endpoint."),
        headers,
        "",
        rs_doc("The application under test, called through its router."),
        "pub struct Api {",
        "    router: Router,",
        context.sea_orm and "    _turn: Option<MutexGuard<'static, ()>>,",
        "}",
        "",
        rs_doc("The answer of a request in a test: its status and its JSON body (null when it has none)."),
        "pub struct TestResponse {",
        "    pub status: u16,",
        "    pub text: String,",
        "    pub json: Value,",
        "}",
        "",
        "impl TestResponse {",
        "    pub fn assert_status(&self, expected: u16) {",
        '        assert_eq!(expected, self.status, "{}", self.text);',
        "    }",
        "}",
        "",
        "impl Api {",
        "    pub async fn new() -> Self {",
        [
            "        let (settings, turn) = settings().await;",
            '        let router = build(settings).await.expect("the API starts");',
            "        Self { router, _turn: turn }",
        ]
        if context.sea_orm
        else ['        let router = build(settings()).await.expect("the API starts");', "        Self { router }"],
        "    }",
        "",
        "    pub async fn get(&self, path: &str, headers: &[(&'static str, String)]) -> TestResponse {",
        '        self.send("GET", path, None, headers).await',
        "    }",
        "",
        "    pub async fn post(&self, path: &str, body: &Value, headers: &[(&'static str, String)]) -> TestResponse {",
        '        self.send("POST", path, Some(body), headers).await',
        "    }",
        "",
        "    pub async fn put(&self, path: &str, body: &Value, headers: &[(&'static str, String)]) -> TestResponse {",
        '        self.send("PUT", path, Some(body), headers).await',
        "    }",
        "",
        "    pub async fn patch(&self, path: &str, body: &Value, headers: &[(&'static str, String)]) -> TestResponse {",
        '        self.send("PATCH", path, Some(body), headers).await',
        "    }",
        "",
        "    pub async fn delete(&self, path: &str, headers: &[(&'static str, String)]) -> TestResponse {",
        '        self.send("DELETE", path, None, headers).await',
        "    }",
        "",
        "    /// Sends a request, with a JSON body when there is one.",
        "    pub async fn send(&self, method: &str, path: &str, body: Option<&Value>, headers: &[(&'static str, String)]) -> TestResponse {",
        "        let mut request = Request::builder().method(method).uri(path);",
        "        for (name, value) in headers {",
        "            request = request.header(*name, value);",
        "        }",
        "        let request = match body {",
        '            Some(body) => request.header("content-type", "application/json").body(Body::from(body.to_string())),',
        "            None => request.body(Body::empty()),",
        "        }",
        '        .expect("the request is valid");',
        '        let response = self.router.clone().oneshot(request).await.expect("the router answers");',
        "        let status = response.status().as_u16();",
        '        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX).await.expect("the body can be read");',
        "        let text = String::from_utf8_lossy(&bytes).into_owned();",
        "        let json = serde_json::from_str(&text).unwrap_or(Value::Null);",
        "        TestResponse { status, text, json }",
        "    }",
        bool(builders) and ["", "\n\n".join(builders)],
        "}",
        "",
        rs_doc("A JSON value from its text."),
        "pub fn parse(text: &str) -> Value {",
        '    serde_json::from_str(text).expect("the JSON of the test is valid")',
        "}",
        "",
        rs_doc("The text of a key in a JSON answer, for a path."),
        "pub fn text(value: &Value) -> String {",
        "    value.as_str().map(String::from).unwrap_or_else(|| value.to_string())",
        "}",
        "",
        rs_doc('A copy of a JSON value with another value at a JSON pointer: "/lines/0/productId".'),
        "pub fn with(mut value: Value, pointer: &str, new: Value) -> Value {",
        "    let (parent, last) = pointer.rsplit_once('/').expect(\"the pointer starts with /\");",
        '    let last = last.replace("~1", "/").replace("~0", "~");',
        "    match value.pointer_mut(parent) {",
        "        Some(Value::Object(map)) => {",
        "            map.insert(last, new);",
        "        }",
        "        Some(Value::Array(items)) => {",
        "            if let Some(item) = last.parse::<usize>().ok().and_then(|index| items.get_mut(index)) {",
        "                *item = new;",
        "            }",
        "        }",
        "        _ => {}",
        "    }",
        "    value",
        "}",
        "",
        rs_doc("A copy of a JSON object without a field."),
        "pub fn without(mut value: Value, field: &str) -> Value {",
        "    if let Some(map) = value.as_object_mut() {",
        "        map.remove(field);",
        "    }",
        "    value",
        "}",
    )
    return {"path": "tests/api/support.rs", "content": file_text(content)}


def _assert_value(value, actual: str) -> str:
    """An assertion that a value of a JSON answer equals a sample value."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        text = number_text(value)
        return f"assert_eq!(Some({text + '.0' if float(value).is_integer() else text}), {actual}.as_f64());"
    return f"assert_eq!({_json(value)}, {actual});"


_HELPERS = {
    "Api": re.compile(r"\bApi::new\("),
    "headers": re.compile(r"\bheaders\("),
    "headers_without_roles": re.compile(r"\bheaders_without_roles\("),
    "parse": re.compile(r"\bparse\("),
    "text": re.compile(r"\btext\("),
    "with": re.compile(r"\bwith\("),
    "without": re.compile(r"\bwithout\("),
}


def _resource_test_file(context: AxumContext, resource: dict) -> dict:
    spec = context.spec
    auth = context.settings["auth"]
    name = names(resource)
    key = key_wire(resource)
    tests: list[str] = []
    can_create = creatable(spec, resource)
    problem = sample_body(spec, resource, 0)["problem"]
    get = find_endpoint(resource, "get")
    create = find_endpoint(resource, "create")
    listing = find_endpoint(resource, "list")
    used: set[str] = set()

    def test(title: str, body: list, skip: str | None = None) -> None:
        fn = _test_name(title)
        n = 2
        while fn in used:
            fn = f"{_test_name(title)}_{n}"
            n += 1
        used.add(fn)
        if skip:
            tests.append(lines("#[test]", f"#[ignore = {rs_string(skip)}]", f"fn {fn}() {{", *body, "}"))
        else:
            tests.append(lines("#[tokio::test]", f"async fn {fn}() {{", "    let api = Api::new().await;", *body, "}"))

    created_key = [
        f"    let created = api.create_{name['one']}(0).await;",
        f"    let key = text(&created[{rs_string(key)}]);",
    ]
    code = 'response.json["error"]["code"]'

    if context.pending:
        for endpoint in [item for item in (listing, get) if item]:
            test(
                f"{endpoint['name']} answers 501 until the storage is written",
                [
                    f"    let response = api.get({rs_string(fixed_path(endpoint, resource, missing_key(resource)))}, &headers()).await;",
                    "",
                    "    response.assert_status(501);",
                    f'    assert_eq!({code}, "not_implemented");',
                ],
            )
    else:
        if create and not can_create:
            test(
                f"creates {article(resource['singular'])}",
                [f"    // TODO: {problem or 'write a body with the items it refers to'}"],
                problem or "An item it refers to cannot be created through the API.",
            )
        if can_create:
            sent = sample_body(spec, resource, 0)["sample"]["body"]
            test(
                f"creates {article(resource['singular'])}",
                [
                    f"    let payload = api.{name['one']}_payload(0).await;",
                    "",
                    f"    let response = api.post({rs_string(create['path'])}, &payload, &headers()).await;",
                    "",
                    f"    response.assert_status({number_text(create['status'])});",
                    f"    assert!(response.json.get({rs_string(key)}).is_some());",
                    [
                        f"    assert_eq!(payload[{rs_string(wire)}], response.json[{rs_string(wire)}]);"
                        for wire in comparable_fields(resource, sent)
                    ],
                ],
            )
            required = required_field(resource)
            if required:
                wire = rs_string(required["wire"])
                test(
                    f"rejects {article(resource['singular'])} without {required['wire']}",
                    [
                        f"    let payload = without(api.{name['one']}_payload(0).await, {wire});",
                        "",
                        f"    let response = api.post({rs_string(create['path'])}, &payload, &headers()).await;",
                        "",
                        "    response.assert_status(400);",
                        f'    assert_eq!({code}, "validation_error");',
                        '    let details = response.json["error"]["details"].as_array().cloned().unwrap_or_default();',
                        f'    assert!(details.iter().any(|detail| detail["field"] == {wire}));',
                    ],
                )
            if resource["key"]["generated"] is None:
                test(
                    f"rejects a second {resource['singular']} with the same key",
                    [
                        f"    let created = api.create_{name['one']}(0).await;",
                        f"    let payload = with(api.{name['one']}_payload(0).await, {rs_string(_pointer([key]))}, created[{rs_string(key)}].clone());",
                        "",
                        f"    let response = api.post({rs_string(create['path'])}, &payload, &headers()).await;",
                        "",
                        "    response.assert_status(409);",
                    ],
                )
        if get:
            if can_create:
                test(
                    f"gets {article(resource['singular'])}",
                    [
                        *created_key,
                        "",
                        f"    let response = api.get({_url(get, resource)}, &headers()).await;",
                        "",
                        "    response.assert_status(200);",
                        "    assert_eq!(created, response.json);",
                    ],
                )
            test(
                f"answers 404 for a missing {resource['singular']}",
                [
                    f"    let response = api.get({rs_string(fixed_path(get, resource, missing_key(resource)))}, &headers()).await;",
                    "",
                    "    response.assert_status(404);",
                    f'    assert_eq!({code}, "not_found");',
                ],
            )
        if listing:
            distinct = sample_keys_differ(spec, resource)
            count = (2 if distinct else 1) if can_create else 0
            test(
                f"lists {resource['plural']}",
                [
                    can_create and f"    api.create_{name['one']}(0).await;",
                    can_create and distinct and f"    api.create_{name['one']}(1).await;",
                    "",
                    f"    let response = api.get({rs_string(listing['path'])}, &headers()).await;",
                    "",
                    "    response.assert_status(200);",
                    [f'    assert_eq!(response.json["total"], {count});', '    assert_eq!(response.json["page"], 1);']
                    if listing["pagination"]
                    else f"    assert_eq!(response.json.as_array().map(Vec::len), Some({count}));",
                ],
            )
            if listing["pagination"] and can_create and distinct:
                test(
                    f"lists {resource['plural']} by page",
                    [
                        f"    api.create_{name['one']}(0).await;",
                        f"    api.create_{name['one']}(1).await;",
                        "",
                        f"    let response = api.get({rs_string(listing['path'] + '?page=2&size=1')}, &headers()).await;",
                        "",
                        "    response.assert_status(200);",
                        '    assert_eq!(response.json["total"], 2);',
                        '    assert_eq!(response.json["items"].as_array().map(Vec::len), Some(1));',
                        '    assert_eq!(response.json["page"], 2);',
                    ],
                )
            if listing["pagination"]:
                test(
                    "rejects a page that does not exist",
                    [
                        f"    let response = api.get({rs_string(listing['path'] + '?page=0')}, &headers()).await;",
                        "",
                        "    response.assert_status(400);",
                    ],
                )
        replace = find_endpoint(resource, "replace")
        if replace and can_create:
            compared = [
                wire
                for wire in comparable_fields(resource, sample_body(spec, resource, 1)["sample"]["body"])
                if wire != key
            ]
            test(
                f"replaces {article(resource['singular'])}",
                [
                    *created_key,
                    f"    let payload = with(api.{name['one']}_payload(1).await, {rs_string(_pointer([key]))}, created[{rs_string(key)}].clone());"
                    if resource["key"]["generated"] is None
                    else f"    let payload = api.{name['one']}_payload(1).await;",
                    "",
                    f"    let response = api.put({_url(replace, resource)}, &payload, &headers()).await;",
                    "",
                    "    response.assert_status(200);",
                    [
                        f"    assert_eq!(payload[{rs_string(wire)}], response.json[{rs_string(wire)}]);"
                        for wire in compared
                    ],
                ],
            )
        update = find_endpoint(resource, "update")
        field = updatable_field(resource)
        if update and can_create and field:
            value = sample_body(spec, resource, 1)["sample"]["body"].get(field["wire"])
            actual = f"response.json[{rs_string(field['wire'])}]"
            test(
                f"updates part of {article(resource['singular'])}",
                [
                    *created_key,
                    "",
                    f"    let response = api.patch({_url(update, resource)}, &{_json({field['wire']: value})}, &headers()).await;",
                    "",
                    "    response.assert_status(200);",
                    f"    {_assert_value(value, actual)}",
                ],
            )
            if not field["nullable"]:
                test(
                    f"rejects null for {field['wire']}",
                    [
                        *created_key,
                        "",
                        f"    let response = api.patch({_url(update, resource)}, &{_json({field['wire']: None})}, &headers()).await;",
                        "",
                        "    response.assert_status(400);",
                    ],
                )
        remove = find_endpoint(resource, "delete")
        if remove and can_create:
            test(
                f"deletes {article(resource['singular'])}",
                [
                    *created_key,
                    "",
                    f"    let response = api.delete({_url(remove, resource)}, &headers()).await;",
                    "",
                    f"    response.assert_status({number_text(remove['status'])});",
                    get and f"    api.get({_url(get, resource)}, &headers()).await.assert_status(404);",
                ],
            )
        for endpoint in resource["endpoints"]:
            if endpoint["operation"] != "custom":
                continue
            needs_item = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            if (needs_item or endpoint["input"] == "resource") and not can_create:
                continue
            if endpoint["input"] == "none":
                body = "None"
            elif endpoint["input"] == "partial":
                body = 'Some(&parse("{}"))'
            else:
                body = f"Some(&api.{name['one']}_payload(0).await)"
            path = _url(endpoint, resource) if needs_item else rs_string(fixed_path(endpoint, resource, "sample"))
            test(
                f"{endpoint['name']} answers 501 until it is written",
                [
                    needs_item and created_key,
                    "    // TODO: replace this test when the operation is written",
                    f"    let response = api.send({rs_string(endpoint['method'])}, {path}, {body}, &headers()).await;",
                    "",
                    "    response.assert_status(501);",
                ],
            )
    guarded = protected_endpoint(resource, auth)
    if guarded:
        test(
            f"{guarded['name']} needs credentials",
            [
                f"    let response = api.get({rs_string(fixed_path(guarded, resource, missing_key(resource)))}, &[]).await;",
                "",
                "    response.assert_status(401);",
                f'    assert_eq!({code}, "unauthorized");',
            ],
        )
    with_roles = role_endpoint(resource, auth)
    if with_roles:
        test(
            f"{with_roles['name']} needs a role",
            [
                f"    let response = api.get({rs_string(fixed_path(with_roles, resource, missing_key(resource)))}, &headers_without_roles()).await;",
                "",
                "    response.assert_status(403);",
            ],
        )
    body = "\n\n".join(tests)
    helpers = [helper for helper, pattern in _HELPERS.items() if pattern.search(body)]
    content = lines(
        f"//! Tests of the {resource['plural']} endpoints.",
        "",
        bool(helpers) and [f"use crate::support::{{{', '.join(helpers)}}};", ""],
        body if tests else ["#[test]", "fn has_no_endpoints() {}"],
    )
    return {"path": f"tests/api/{name['test']}.rs", "content": file_text(content)}


def test_files(context: AxumContext) -> list[dict]:
    return [
        _main_file(context),
        _support_file(context),
        *(_resource_test_file(context, resource) for resource in context.spec["resources"]),
    ]
