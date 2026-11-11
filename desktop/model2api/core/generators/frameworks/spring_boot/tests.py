"""Tests of the Spring Boot project (JUnit 5 + MockMvc on the real application context). They call every enabled
endpoint the way a client would, with the same cases as every other framework (common/testing.py). Tests do not
depend on each other: lists check counts with "at least". Mirrors
web/src/core/generators/frameworks/springBoot/tests.ts.
"""

from ....js import js_string
from ...common.samples import sample_body, updatable_field
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
from ...languages.java.java import java_doc, java_json, java_name, java_string
from .common import application_class
from .context import SpringContext, names, source_path
from .model import article


def _json_path(path: list) -> str:
    """A JsonPath to a place in a body: $.lines[0].productId."""
    return "$" + "".join(f"[{part}]" if isinstance(part, int) else f"['{part}']" for part in path)


def _url(endpoint: dict, resource: dict) -> str:
    """A Java expression for a path whose key is the variable key."""
    parts = path_with_key(endpoint, resource).split("{key}")
    if len(parts) == 1:
        return java_string(parts[0])
    return f"{java_string(parts[0])} + key + {java_string(parts[1])}"


def _upper_first(text: str) -> str:
    return text[:1].upper() + text[1:]


def _wire_path(wire: str) -> str:
    return java_string(f"$['{wire}']")


def _test_data_file(context: SpringContext) -> dict:
    package = context.base
    spec = context.spec
    blocks: list[str] = []
    for resource in spec["resources"]:
        if not creatable(spec, resource):
            continue
        name = names(resource)
        create = find_endpoint(resource, "create")
        first = sample_body(spec, resource, 0)["sample"]
        second = sample_body(spec, resource, 1)["sample"]
        # Tests share the application, so a key the client chooses must be new each time
        key_field = next(field for field in resource["fields"] if field["name"] == resource["key"]["field"])
        constraints = key_field["constraints"]
        unique = False
        if (
            resource["key"].get("generated") is None
            and not constraints.get("pattern")
            and not constraints.get("format")
            and constraints.get("maxLength") is None
        ):
            scalar = resource["key"]["type"]["scalar"]
            if scalar == "integer":
                unique = f"        body.set({_wire_path(key_wire(resource))}, NEXT_KEY.incrementAndGet());"
            elif scalar == "string":
                unique = f'        body.set({_wire_path(key_wire(resource))}, "key-" + NEXT_KEY.incrementAndGet());'
        fills = []
        for reference in first["references"]:
            target = next(item for item in spec["resources"] if item["name"] == reference["resource"])
            fills.append(
                f"        body.set({java_string(_json_path(reference['path']))}, key(create{names(target)['type']}(mvc, headers), {java_string(key_wire(target))}));"
            )
        blocks.append(
            lines(
                f"    /** A valid body to create {article(resource['singular'])}, with the items it refers to created first. */",
                f"    static String {name['one']}Payload(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {{",
                f"        DocumentContext body = JsonPath.parse(variant == 0 ? {java_json(first['body'])} : {java_json(second['body'])});",
                fills,
                unique,
                "        return body.jsonString();",
                "    }",
                "",
                f"    /** Creates {article(resource['singular'])} and returns the JSON the API answers. */",
                f"    static String create{name['type']}(MockMvc mvc, HttpHeaders headers) throws Exception {{",
                f"        return create{name['type']}(mvc, headers, 0);",
                "    }",
                "",
                f"    static String create{name['type']}(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {{",
                f"        return mvc.perform(post({java_string(create['path'])}).headers(headers).contentType(MediaType.APPLICATION_JSON).content({name['one']}Payload(mvc, headers, variant)))",
                f"                .andExpect(status().is({create['status']}))",
                "                .andReturn().getResponse().getContentAsString();",
                "    }",
            )
        )
    auth = context.settings["auth"]
    content = lines(
        f"package {package};",
        "",
        "import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;",
        "import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;",
        "",
        auth == "jwt"
        and [
            "import com.nimbusds.jose.JWSAlgorithm;",
            "import com.nimbusds.jose.JWSHeader;",
            "import com.nimbusds.jose.crypto.MACSigner;",
            "import com.nimbusds.jwt.JWTClaimsSet;",
            "import com.nimbusds.jwt.SignedJWT;",
        ],
        "import com.jayway.jsonpath.DocumentContext;",
        "import com.jayway.jsonpath.JsonPath;",
        "import java.util.concurrent.atomic.AtomicLong;",
        auth == "jwt"
        and [
            "import java.nio.charset.StandardCharsets;",
            "import java.time.Instant;",
            "import java.util.Date;",
            "import java.util.List;",
        ],
        "import org.springframework.http.HttpHeaders;",
        "import org.springframework.http.MediaType;",
        "import org.springframework.test.web.servlet.MockMvc;",
        "",
        java_doc("Credentials, builders of valid request bodies, and helpers that create items through the API."),
        "final class TestData {",
        "",
        "    /** Keys for items whose key the client chooses: new for every item, as tests share the application. */",
        "    private static final AtomicLong NEXT_KEY = new AtomicLong(1000);",
        "",
        "    private TestData() {",
        "    }",
        "",
        "    /** Headers of a client allowed to call every endpoint. */",
        "    static HttpHeaders headers() throws Exception {",
        "        HttpHeaders headers = new HttpHeaders();",
        auth == "apiKey" and f'        headers.set("X-API-Key", {java_string(TEST_API_KEY)});',
        auth == "jwt"
        and f"        headers.setBearerAuth(token(List.of({', '.join(java_string(role) for role in spec['roles'])})));",
        "        return headers;",
        "    }",
        auth == "jwt"
        and [
            "",
            "    /** Headers of a client with a valid token but no role. */",
            "    static HttpHeaders headersWithoutRoles() throws Exception {",
            "        HttpHeaders headers = new HttpHeaders();",
            "        headers.setBearerAuth(token(List.of()));",
            "        return headers;",
            "    }",
            "",
            "    /** A token signed with the test secret (src/test/resources/application.properties), valid for one hour. */",
            "    static String token(List<String> roles) throws Exception {",
            '        JWTClaimsSet claims = new JWTClaimsSet.Builder().subject("tests").claim("roles", roles).expirationTime(Date.from(Instant.now().plusSeconds(3600))).build();',
            "        SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);",
            f"        jwt.sign(new MACSigner({java_string(TEST_JWT_SECRET)}.getBytes(StandardCharsets.UTF_8)));",
            "        return jwt.serialize();",
            "    }",
        ],
        "",
        "    /** The value of a field of a JSON answer. */",
        "    static Object key(String json, String field) {",
        '        return JsonPath.read(json, "$[\'" + field + "\']");',
        "    }",
        len(blocks) > 0 and ["", "\n\n".join(blocks)],
        "}",
    )
    return {"path": source_path(package, "TestData", True), "content": file_text(content)}


def _resource_tests(context: SpringContext, resource: dict) -> dict:
    package = context.base
    spec = context.spec
    name = names(resource)
    class_name = f"{name['type']}ApiTest"
    key = key_wire(resource)
    tests: list[str] = []
    can_create = creatable(spec, resource)
    problem = sample_body(spec, resource, 0)["problem"]
    get = find_endpoint(resource, "get")
    create = find_endpoint(resource, "create")
    listing = find_endpoint(resource, "list")
    client_key = resource["key"].get("generated") is None

    def test(method: str, body: list) -> None:
        tests.append(lines("    @Test", f"    void {method}() throws Exception {{", *body, "    }"))

    def json(text: str) -> str:
        return f".contentType(MediaType.APPLICATION_JSON).content({text})"

    def key_of(variable: str) -> str:
        return f"        Object key = TestData.key({variable}, {java_string(key)});"

    created = f"        String created = TestData.create{name['type']}(mvc, TestData.headers());"

    if context.pending:
        for endpoint in (item for item in (listing, get) if item):
            test(
                f"{java_name(endpoint['name'])}AnswersNotImplemented",
                [
                    f"        mvc.perform(get({java_string(fixed_path(endpoint, resource, missing_key(resource)))}).headers(TestData.headers()))",
                    "                .andExpect(status().is(501))",
                    '                .andExpect(jsonPath("$.error.code").value("not_implemented"));',
                ],
            )
    else:
        if create and not can_create:
            reason = problem if problem is not None else "An item it refers to cannot be created through the API."
            todo = problem if problem is not None else "write a body with the items it refers to"
            tests.append(
                lines(
                    f"    @Disabled({java_string(reason)})",
                    "    @Test",
                    f"    void create{name['type']}() {{",
                    f"        // TODO: {todo}",
                    "    }",
                )
            )
        if can_create:
            sent = sample_body(spec, resource, 0)["sample"]["body"]
            test(
                f"create{name['type']}",
                [
                    f"        String payload = TestData.{name['one']}Payload(mvc, TestData.headers(), 0);",
                    f"        mvc.perform(post({java_string(create['path'])}).headers(TestData.headers()){json('payload')})",
                    f"                .andExpect(status().is({create['status']}))",
                    f"                .andExpect(jsonPath({_wire_path(key)}).exists())",
                    [
                        f"                .andExpect(jsonPath({_wire_path(wire)}).value(JsonPath.<Object>read(payload, {_wire_path(wire)})))"
                        for wire in comparable_fields(resource, sent)
                    ],
                    "                ;",
                ],
            )
            required = required_field(resource)
            if required:
                test(
                    f"reject{name['type']}Without{_upper_first(java_name(required['wire']))}",
                    [
                        f"        String payload = JsonPath.parse(TestData.{name['one']}Payload(mvc, TestData.headers(), 0)).delete({_wire_path(required['wire'])}).jsonString();",
                        f"        mvc.perform(post({java_string(create['path'])}).headers(TestData.headers()){json('payload')})",
                        "                .andExpect(status().is(400))",
                        '                .andExpect(jsonPath("$.error.code").value("validation_error"));',
                    ],
                )
            if client_key:
                test(
                    f"reject{name['type']}WithTheSameKey",
                    [
                        created,
                        f"        String payload = JsonPath.parse(TestData.{name['one']}Payload(mvc, TestData.headers(), 0)).set({_wire_path(key)}, TestData.key(created, {java_string(key)})).jsonString();",
                        f"        mvc.perform(post({java_string(create['path'])}).headers(TestData.headers()){json('payload')})",
                        "                .andExpect(status().is(409));",
                    ],
                )
        if get:
            if can_create:
                test(
                    f"get{name['type']}",
                    [
                        created,
                        key_of("created"),
                        f"        mvc.perform(get({_url(get, resource)}).headers(TestData.headers()))",
                        "                .andExpect(status().is(200))",
                        "                .andExpect(content().json(created));",
                    ],
                )
            test(
                f"answerNotFoundForAMissing{name['type']}",
                [
                    f"        mvc.perform(get({java_string(fixed_path(get, resource, missing_key(resource)))}).headers(TestData.headers()))",
                    "                .andExpect(status().is(404))",
                    '                .andExpect(jsonPath("$.error.code").value("not_found"));',
                ],
            )
        if listing:
            distinct = sample_keys_differ(spec, resource)
            least = 1 if can_create else 0
            list_name = java_name(listing["name"])
            test(
                list_name,
                [
                    can_create and f"        TestData.create{name['type']}(mvc, TestData.headers());",
                    f"        mvc.perform(get({java_string(listing['path'])}).headers(TestData.headers()))",
                    "                .andExpect(status().is(200))",
                    [
                        f'                .andExpect(jsonPath("$.total").value(greaterThanOrEqualTo({least})))',
                        '                .andExpect(jsonPath("$.page").value(1));',
                    ]
                    if listing.get("pagination")
                    else f'                .andExpect(jsonPath("$.length()").value(greaterThanOrEqualTo({least})));',
                ],
            )
            if listing.get("pagination") and can_create and distinct:
                test(
                    f"{list_name}ByPage",
                    [
                        f"        TestData.create{name['type']}(mvc, TestData.headers(), 0);",
                        f"        TestData.create{name['type']}(mvc, TestData.headers(), 1);",
                        f'        mvc.perform(get({java_string(listing["path"])}).param("page", "2").param("size", "1").headers(TestData.headers()))',
                        "                .andExpect(status().is(200))",
                        '                .andExpect(jsonPath("$.items.length()").value(1))',
                        '                .andExpect(jsonPath("$.page").value(2));',
                    ],
                )
            if listing.get("pagination"):
                test(
                    f"rejectAPageThatDoesNotExistIn{_upper_first(list_name)}",
                    [
                        f'        mvc.perform(get({java_string(listing["path"])}).param("page", "0").headers(TestData.headers()))',
                        "                .andExpect(status().is(400));",
                    ],
                )
        replace = find_endpoint(resource, "replace")
        if replace and can_create:
            test(
                f"replace{name['type']}",
                [
                    created,
                    key_of("created"),
                    f"        String payload = JsonPath.parse(TestData.{name['one']}Payload(mvc, TestData.headers(), 1)).set({_wire_path(key)}, key).jsonString();"
                    if client_key
                    else f"        String payload = TestData.{name['one']}Payload(mvc, TestData.headers(), 1);",
                    f"        mvc.perform(put({_url(replace, resource)}).headers(TestData.headers()){json('payload')})",
                    "                .andExpect(status().is(200));",
                ],
            )
        update = find_endpoint(resource, "update")
        field = updatable_field(resource)
        if update and can_create and field:
            value = sample_body(spec, resource, 1)["sample"]["body"].get(field["wire"])
            expected = java_string(value) if isinstance(value, str) else js_string(value)
            test(
                f"update{name['type']}",
                [
                    created,
                    key_of("created"),
                    f"        mvc.perform(patch({_url(update, resource)}).headers(TestData.headers()){json(java_json({field['wire']: value}))})",
                    "                .andExpect(status().is(200))",
                    f"                .andExpect(jsonPath({_wire_path(field['wire'])}).value({expected}));",
                ],
            )
            if not field["nullable"]:
                test(
                    f"rejectNullFor{_upper_first(java_name(field['wire']))}In{name['type']}",
                    [
                        created,
                        key_of("created"),
                        f"        mvc.perform(patch({_url(update, resource)}).headers(TestData.headers()){json(java_json({field['wire']: None}))})",
                        "                .andExpect(status().is(400));",
                    ],
                )
        remove = find_endpoint(resource, "delete")
        if remove and can_create:
            test(
                f"delete{name['type']}",
                [
                    created,
                    key_of("created"),
                    f"        mvc.perform(delete({_url(remove, resource)}).headers(TestData.headers()))",
                    f"                .andExpect(status().is({remove['status']}));",
                    get
                    and f"        mvc.perform(get({_url(get, resource)}).headers(TestData.headers())).andExpect(status().is(404));",
                ],
            )
        for endpoint in resource["endpoints"]:
            if endpoint["operation"] != "custom":
                continue
            needs_item = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            if (needs_item or endpoint["input"] == "resource") and not can_create:
                continue
            if endpoint["input"] == "none":
                body = ""
            elif endpoint["input"] == "partial":
                body = json('"{}"')
            else:
                body = json(f"TestData.{name['one']}Payload(mvc, TestData.headers(), 0)")
            target = _url(endpoint, resource) if needs_item else java_string(fixed_path(endpoint, resource, "sample"))
            test(
                f"{java_name(endpoint['name'])}AnswersNotImplemented",
                [
                    needs_item and [created, key_of("created")],
                    "        // TODO: replace this test when the operation is written",
                    f"        mvc.perform(request(HttpMethod.{endpoint['method']}, {target}).headers(TestData.headers()){body})",
                    "                .andExpect(status().is(501));",
                ],
            )
    guarded = protected_endpoint(resource, context.settings["auth"])
    if guarded:
        test(
            f"{java_name(guarded['name'])}NeedsCredentials",
            [
                f"        mvc.perform(get({java_string(fixed_path(guarded, resource, missing_key(resource)))}))",
                "                .andExpect(status().is(401))",
                '                .andExpect(jsonPath("$.error.code").value("unauthorized"));',
            ],
        )
    with_roles = role_endpoint(resource, context.settings["auth"])
    if with_roles:
        test(
            f"{java_name(with_roles['name'])}NeedsARole",
            [
                f"        mvc.perform(get({java_string(fixed_path(with_roles, resource, missing_key(resource)))}).headers(TestData.headersWithoutRoles()))",
                "                .andExpect(status().is(403));",
            ],
        )
    body = "\n\n".join(tests)
    content = lines(
        f"package {package};",
        "",
        "greaterThanOrEqualTo(" in body and "import static org.hamcrest.Matchers.greaterThanOrEqualTo;",
        "import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;",
        "import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;",
        "import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;",
        "import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;",
        "import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;",
        "import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;",
        "import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;",
        "import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;",
        "import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;",
        context.security
        and "import static org.springframework.security.test.web.servlet.setup.SecurityMockMvcConfigurers.springSecurity;",
        "",
        "import com.jayway.jsonpath.JsonPath;",
        "import org.junit.jupiter.api.BeforeEach;",
        "@Disabled" in body and "import org.junit.jupiter.api.Disabled;",
        "import org.junit.jupiter.api.Test;",
        "import org.springframework.beans.factory.annotation.Autowired;",
        "import org.springframework.boot.test.context.SpringBootTest;",
        "import org.springframework.http.HttpMethod;",
        "import org.springframework.http.MediaType;",
        "import org.springframework.test.web.servlet.MockMvc;",
        "import org.springframework.test.web.servlet.setup.MockMvcBuilders;",
        "import org.springframework.web.context.WebApplicationContext;",
        "",
        java_doc(f"Tests of the {resource['plural']} endpoints."),
        f"@SpringBootTest(classes = {application_class(context)}.class)",
        f"class {class_name} {{",
        "",
        "    @Autowired",
        "    private WebApplicationContext context;",
        "",
        "    private MockMvc mvc;",
        "",
        "    @BeforeEach",
        "    void setUp() {",
        "        mvc = MockMvcBuilders.webAppContextSetup(context).apply(springSecurity()).build();"
        if context.security
        else "        mvc = MockMvcBuilders.webAppContextSetup(context).build();",
        "    }",
        "",
        body if body else "    @Test\n    void hasNoEndpoints() {\n    }",
        "}",
    )
    return {"path": source_path(package, class_name, True), "content": file_text(content)}


def test_files(context: SpringContext) -> list[dict]:
    return [_test_data_file(context), *(_resource_tests(context, resource) for resource in context.spec["resources"])]
