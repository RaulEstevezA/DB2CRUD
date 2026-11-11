/**
 * Tests of the Spring Boot project (JUnit 5 + MockMvc on the real application context). They call every
 * enabled endpoint the way a client would, with the same cases as every other framework
 * (common/testing.ts). Tests do not depend on each other: lists check counts with "at least".
 */
import type { SpecEndpoint, SpecResource } from '../../../api/spec.ts'
import { sampleBody, updatableField, type JsonValue } from '../../common/samples.ts'
import {
  TEST_JWT_SECRET,
  TEST_API_KEY,
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
import { fileText, lines } from '../../common/text.ts'
import { javaDoc, javaJson, javaName, javaString } from '../../languages/java/java.ts'
import { applicationClass } from './common.ts'
import { names, sourcePath, type SpringContext } from './context.ts'

/** A JsonPath to a place in a body: `$.lines[0].productId`. */
function jsonPath(path: (string | number)[]): string {
  return `$${path.map((part) => (typeof part === 'number' ? `[${part}]` : `['${part}']`)).join('')}`
}

/** A Java expression for a path whose key is the variable `key`. */
function url(endpoint: SpecEndpoint, resource: SpecResource): string {
  const [before, after] = pathWithKey(endpoint, resource).split('{key}')
  return after === undefined ? javaString(before) : `${javaString(before)} + key + ${javaString(after)}`
}

function testDataFile(context: SpringContext): GeneratedFile {
  const pkg = context.base
  const blocks: string[] = []
  for (const resource of context.spec.resources) {
    if (!creatable(context.spec, resource)) continue
    const name = names(resource)
    const create = findEndpoint(resource, 'create')!
    const first = sampleBody(context.spec, resource, 0).sample
    const second = sampleBody(context.spec, resource, 1).sample
    // Tests share the application, so a key the client chooses must be new each time
    const keyField = resource.fields.find((field) => field.name === resource.key.field)!
    const unique =
      resource.key.generated === null &&
      !keyField.constraints.pattern &&
      !keyField.constraints.format &&
      keyField.constraints.maxLength === undefined
        ? resource.key.type.scalar === 'integer'
          ? `        body.set(${javaString(`$['${keyWire(resource)}']`)}, NEXT_KEY.incrementAndGet());`
          : resource.key.type.scalar === 'string'
            ? `        body.set(${javaString(`$['${keyWire(resource)}']`)}, "key-" + NEXT_KEY.incrementAndGet());`
            : false
        : false
    const fills = first.references.map((reference) => {
      const target = context.spec.resources.find((item) => item.name === reference.resource)!
      return `        body.set(${javaString(jsonPath(reference.path))}, key(create${names(target).type}(mvc, headers), ${javaString(keyWire(target))}));`
    })
    blocks.push(
      lines(
        `    /** A valid body to create ${article(resource.singular)}, with the items it refers to created first. */`,
        `    static String ${name.one}Payload(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {`,
        `        DocumentContext body = JsonPath.parse(variant == 0 ? ${javaJson(first.body as JsonValue)} : ${javaJson(second.body as JsonValue)});`,
        fills,
        unique,
        '        return body.jsonString();',
        '    }',
        '',
        `    /** Creates ${article(resource.singular)} and returns the JSON the API answers. */`,
        `    static String create${name.type}(MockMvc mvc, HttpHeaders headers) throws Exception {`,
        `        return create${name.type}(mvc, headers, 0);`,
        '    }',
        '',
        `    static String create${name.type}(MockMvc mvc, HttpHeaders headers, int variant) throws Exception {`,
        `        return mvc.perform(post(${javaString(create.path)}).headers(headers).contentType(MediaType.APPLICATION_JSON).content(${name.one}Payload(mvc, headers, variant)))`,
        `                .andExpect(status().is(${create.status}))`,
        '                .andReturn().getResponse().getContentAsString();',
        '    }',
      ),
    )
  }
  const { auth } = context.settings
  const content = lines(
    `package ${pkg};`,
    '',
    'import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;',
    'import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;',
    '',
    auth === 'jwt' && [
      'import com.nimbusds.jose.JWSAlgorithm;',
      'import com.nimbusds.jose.JWSHeader;',
      'import com.nimbusds.jose.crypto.MACSigner;',
      'import com.nimbusds.jwt.JWTClaimsSet;',
      'import com.nimbusds.jwt.SignedJWT;',
    ],
    'import com.jayway.jsonpath.DocumentContext;',
    'import com.jayway.jsonpath.JsonPath;',
    'import java.util.concurrent.atomic.AtomicLong;',
    auth === 'jwt' && [
      'import java.nio.charset.StandardCharsets;',
      'import java.time.Instant;',
      'import java.util.Date;',
      'import java.util.List;',
    ],
    'import org.springframework.http.HttpHeaders;',
    'import org.springframework.http.MediaType;',
    'import org.springframework.test.web.servlet.MockMvc;',
    '',
    javaDoc('Credentials, builders of valid request bodies, and helpers that create items through the API.'),
    'final class TestData {',
    '',
    '    /** Keys for items whose key the client chooses: new for every item, as tests share the application. */',
    '    private static final AtomicLong NEXT_KEY = new AtomicLong(1000);',
    '',
    '    private TestData() {',
    '    }',
    '',
    '    /** Headers of a client allowed to call every endpoint. */',
    '    static HttpHeaders headers() throws Exception {',
    '        HttpHeaders headers = new HttpHeaders();',
    auth === 'apiKey' && `        headers.set("X-API-Key", ${javaString(TEST_API_KEY)});`,
    auth === 'jwt' && `        headers.setBearerAuth(token(List.of(${context.spec.roles.map(javaString).join(', ')})));`,
    '        return headers;',
    '    }',
    auth === 'jwt' && [
      '',
      '    /** Headers of a client with a valid token but no role. */',
      '    static HttpHeaders headersWithoutRoles() throws Exception {',
      '        HttpHeaders headers = new HttpHeaders();',
      '        headers.setBearerAuth(token(List.of()));',
      '        return headers;',
      '    }',
      '',
      '    /** A token signed with the test secret (src/test/resources/application.properties), valid for one hour. */',
      '    static String token(List<String> roles) throws Exception {',
      '        JWTClaimsSet claims = new JWTClaimsSet.Builder().subject("tests").claim("roles", roles).expirationTime(Date.from(Instant.now().plusSeconds(3600))).build();',
      '        SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);',
      `        jwt.sign(new MACSigner(${javaString(TEST_JWT_SECRET)}.getBytes(StandardCharsets.UTF_8)));`,
      '        return jwt.serialize();',
      '    }',
    ],
    '',
    '    /** The value of a field of a JSON answer. */',
    '    static Object key(String json, String field) {',
    '        return JsonPath.read(json, "$[\'" + field + "\']");',
    '    }',
    blocks.length > 0 && ['', blocks.join('\n\n')],
    '}',
  )
  return { path: sourcePath(pkg, 'TestData', true), content: fileText(content) }
}

function article(text: string): string {
  return /^[aeiou]/i.test(text) ? `an ${text}` : `a ${text}`
}

function resourceTests(context: SpringContext, resource: SpecResource): GeneratedFile {
  const pkg = context.base
  const name = names(resource)
  const className = `${name.type}ApiTest`
  const key = keyWire(resource)
  const tests: string[] = []
  const canCreate = creatable(context.spec, resource)
  const problem = sampleBody(context.spec, resource, 0).problem
  const get = findEndpoint(resource, 'get')
  const create = findEndpoint(resource, 'create')
  const list = findEndpoint(resource, 'list')
  const test = (method: string, body: (string | false | null | undefined | string[])[]) =>
    tests.push(lines('    @Test', `    void ${method}() throws Exception {`, ...body, '    }'))
  const json = (text: string) => `.contentType(MediaType.APPLICATION_JSON).content(${text})`
  const keyOf = (variable: string) => `        Object key = TestData.key(${variable}, ${javaString(key)});`

  if (context.pending) {
    for (const endpoint of [list, get].filter(Boolean) as SpecEndpoint[]) {
      test(`${javaName(endpoint.name)}AnswersNotImplemented`, [
        `        mvc.perform(get(${javaString(fixedPath(endpoint, resource, missingKey(resource)))}).headers(TestData.headers()))`,
        '                .andExpect(status().is(501))',
        '                .andExpect(jsonPath("$.error.code").value("not_implemented"));',
      ])
    }
  } else {
    if (create && !canCreate) {
      tests.push(
        lines(
          `    @Disabled(${javaString(problem ?? 'An item it refers to cannot be created through the API.')})`,
          '    @Test',
          `    void create${name.type}() {`,
          `        // TODO: ${problem ?? 'write a body with the items it refers to'}`,
          '    }',
        ),
      )
    }
    if (canCreate) {
      const sent = sampleBody(context.spec, resource, 0).sample.body
      test(`create${name.type}`, [
        `        String payload = TestData.${name.one}Payload(mvc, TestData.headers(), 0);`,
        `        mvc.perform(post(${javaString(create!.path)}).headers(TestData.headers())${json('payload')})`,
        `                .andExpect(status().is(${create!.status}))`,
        `                .andExpect(jsonPath(${javaString(`$['${key}']`)}).exists())`,
        comparableFields(resource, sent).map(
          (wire) =>
            `                .andExpect(jsonPath(${javaString(`$['${wire}']`)}).value(JsonPath.<Object>read(payload, ${javaString(`$['${wire}']`)})))`,
        ),
        '                ;',
      ])
      const required = requiredField(resource)
      if (required) {
        test(`reject${name.type}Without${javaName(required.wire).charAt(0).toUpperCase()}${javaName(required.wire).slice(1)}`, [
          `        String payload = JsonPath.parse(TestData.${name.one}Payload(mvc, TestData.headers(), 0)).delete(${javaString(`$['${required.wire}']`)}).jsonString();`,
          `        mvc.perform(post(${javaString(create!.path)}).headers(TestData.headers())${json('payload')})`,
          '                .andExpect(status().is(400))',
          '                .andExpect(jsonPath("$.error.code").value("validation_error"));',
        ])
      }
      if (resource.key.generated === null) {
        test(`reject${name.type}WithTheSameKey`, [
          `        String created = TestData.create${name.type}(mvc, TestData.headers());`,
          `        String payload = JsonPath.parse(TestData.${name.one}Payload(mvc, TestData.headers(), 0)).set(${javaString(`$['${key}']`)}, TestData.key(created, ${javaString(key)})).jsonString();`,
          `        mvc.perform(post(${javaString(create!.path)}).headers(TestData.headers())${json('payload')})`,
          '                .andExpect(status().is(409));',
        ])
      }
    }
    if (get) {
      if (canCreate) {
        test(`get${name.type}`, [
          `        String created = TestData.create${name.type}(mvc, TestData.headers());`,
          keyOf('created'),
          `        mvc.perform(get(${url(get, resource)}).headers(TestData.headers()))`,
          '                .andExpect(status().is(200))',
          '                .andExpect(content().json(created));',
        ])
      }
      test(`answerNotFoundForAMissing${name.type}`, [
        `        mvc.perform(get(${javaString(fixedPath(get, resource, missingKey(resource)))}).headers(TestData.headers()))`,
        '                .andExpect(status().is(404))',
        '                .andExpect(jsonPath("$.error.code").value("not_found"));',
      ])
    }
    if (list) {
      const distinct = sampleKeysDiffer(context.spec, resource)
      test(javaName(list.name), [
        canCreate && `        TestData.create${name.type}(mvc, TestData.headers());`,
        `        mvc.perform(get(${javaString(list.path)}).headers(TestData.headers()))`,
        '                .andExpect(status().is(200))',
        list.pagination
          ? [
              `                .andExpect(jsonPath("$.total").value(greaterThanOrEqualTo(${canCreate ? 1 : 0})))`,
              '                .andExpect(jsonPath("$.page").value(1));',
            ]
          : `                .andExpect(jsonPath("$.length()").value(greaterThanOrEqualTo(${canCreate ? 1 : 0})));`,
      ])
      if (list.pagination && canCreate && distinct) {
        test(`${javaName(list.name)}ByPage`, [
          `        TestData.create${name.type}(mvc, TestData.headers(), 0);`,
          `        TestData.create${name.type}(mvc, TestData.headers(), 1);`,
          `        mvc.perform(get(${javaString(list.path)}).param("page", "2").param("size", "1").headers(TestData.headers()))`,
          '                .andExpect(status().is(200))',
          '                .andExpect(jsonPath("$.items.length()").value(1))',
          '                .andExpect(jsonPath("$.page").value(2));',
        ])
      }
      if (list.pagination) {
        test(`rejectAPageThatDoesNotExistIn${javaName(list.name).charAt(0).toUpperCase()}${javaName(list.name).slice(1)}`, [
          `        mvc.perform(get(${javaString(list.path)}).param("page", "0").headers(TestData.headers()))`,
          '                .andExpect(status().is(400));',
        ])
      }
    }
    const replace = findEndpoint(resource, 'replace')
    if (replace && canCreate) {
      test(`replace${name.type}`, [
        `        String created = TestData.create${name.type}(mvc, TestData.headers());`,
        keyOf('created'),
        resource.key.generated === null
          ? `        String payload = JsonPath.parse(TestData.${name.one}Payload(mvc, TestData.headers(), 1)).set(${javaString(`$['${key}']`)}, key).jsonString();`
          : `        String payload = TestData.${name.one}Payload(mvc, TestData.headers(), 1);`,
        `        mvc.perform(put(${url(replace, resource)}).headers(TestData.headers())${json('payload')})`,
        '                .andExpect(status().is(200));',
      ])
    }
    const update = findEndpoint(resource, 'update')
    const field = updatableField(resource)
    if (update && canCreate && field) {
      const value = sampleBody(context.spec, resource, 1).sample.body[field.wire] ?? null
      test(`update${name.type}`, [
        `        String created = TestData.create${name.type}(mvc, TestData.headers());`,
        keyOf('created'),
        `        mvc.perform(patch(${url(update, resource)}).headers(TestData.headers())${json(javaJson({ [field.wire]: value }))})`,
        '                .andExpect(status().is(200))',
        `                .andExpect(jsonPath(${javaString(`$['${field.wire}']`)}).value(${typeof value === 'string' ? javaString(value) : String(value)}));`,
      ])
      if (!field.nullable) {
        test(`rejectNullFor${javaName(field.wire).charAt(0).toUpperCase()}${javaName(field.wire).slice(1)}In${name.type}`, [
          `        String created = TestData.create${name.type}(mvc, TestData.headers());`,
          keyOf('created'),
          `        mvc.perform(patch(${url(update, resource)}).headers(TestData.headers())${json(javaJson({ [field.wire]: null }))})`,
          '                .andExpect(status().is(400));',
        ])
      }
    }
    const remove = findEndpoint(resource, 'delete')
    if (remove && canCreate) {
      test(`delete${name.type}`, [
        `        String created = TestData.create${name.type}(mvc, TestData.headers());`,
        keyOf('created'),
        `        mvc.perform(delete(${url(remove, resource)}).headers(TestData.headers()))`,
        `                .andExpect(status().is(${remove.status}));`,
        get && `        mvc.perform(get(${url(get, resource)}).headers(TestData.headers())).andExpect(status().is(404));`,
      ])
    }
    for (const endpoint of resource.endpoints.filter((item) => item.operation === 'custom')) {
      const needsItem = endpoint.pathParams.some((param) => param.name === resource.key.param)
      if ((needsItem || endpoint.input === 'resource') && !canCreate) continue
      const body =
        endpoint.input === 'none'
          ? ''
          : endpoint.input === 'partial'
            ? json('"{}"')
            : json(`TestData.${name.one}Payload(mvc, TestData.headers(), 0)`)
      test(`${javaName(endpoint.name)}AnswersNotImplemented`, [
        needsItem && [`        String created = TestData.create${name.type}(mvc, TestData.headers());`, keyOf('created')],
        `        // TODO: replace this test when the operation is written`,
        `        mvc.perform(request(HttpMethod.${endpoint.method}, ${needsItem ? url(endpoint, resource) : javaString(fixedPath(endpoint, resource, 'sample'))}).headers(TestData.headers())${body})`,
        '                .andExpect(status().is(501));',
      ])
    }
  }
  const guarded = protectedEndpoint(resource, context.settings.auth)
  if (guarded) {
    test(`${javaName(guarded.name)}NeedsCredentials`, [
      `        mvc.perform(get(${javaString(fixedPath(guarded, resource, missingKey(resource)))}))`,
      '                .andExpect(status().is(401))',
      '                .andExpect(jsonPath("$.error.code").value("unauthorized"));',
    ])
  }
  const withRoles = roleEndpoint(resource, context.settings.auth)
  if (withRoles) {
    test(`${javaName(withRoles.name)}NeedsARole`, [
      `        mvc.perform(get(${javaString(fixedPath(withRoles, resource, missingKey(resource)))}).headers(TestData.headersWithoutRoles()))`,
      '                .andExpect(status().is(403));',
    ])
  }
  const body = tests.join('\n\n')
  const content = lines(
    `package ${pkg};`,
    '',
    body.includes('greaterThanOrEqualTo(') && 'import static org.hamcrest.Matchers.greaterThanOrEqualTo;',
    'import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;',
    'import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;',
    'import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;',
    'import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;',
    'import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;',
    'import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;',
    'import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;',
    'import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;',
    'import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;',
    context.security && 'import static org.springframework.security.test.web.servlet.setup.SecurityMockMvcConfigurers.springSecurity;',
    '',
    'import com.jayway.jsonpath.JsonPath;',
    'import org.junit.jupiter.api.BeforeEach;',
    body.includes('@Disabled') && 'import org.junit.jupiter.api.Disabled;',
    'import org.junit.jupiter.api.Test;',
    'import org.springframework.beans.factory.annotation.Autowired;',
    'import org.springframework.boot.test.context.SpringBootTest;',
    'import org.springframework.http.HttpMethod;',
    'import org.springframework.http.MediaType;',
    'import org.springframework.test.web.servlet.MockMvc;',
    'import org.springframework.test.web.servlet.setup.MockMvcBuilders;',
    'import org.springframework.web.context.WebApplicationContext;',
    '',
    javaDoc(`Tests of the ${resource.plural} endpoints.`),
    `@SpringBootTest(classes = ${applicationClass(context)}.class)`,
    `class ${className} {`,
    '',
    '    @Autowired',
    '    private WebApplicationContext context;',
    '',
    '    private MockMvc mvc;',
    '',
    '    @BeforeEach',
    '    void setUp() {',
    context.security
      ? '        mvc = MockMvcBuilders.webAppContextSetup(context).apply(springSecurity()).build();'
      : '        mvc = MockMvcBuilders.webAppContextSetup(context).build();',
    '    }',
    '',
    body.length > 0 ? body : '    @Test\n    void hasNoEndpoints() {\n    }',
    '}',
  )
  return { path: sourcePath(pkg, className, true), content: fileText(content) }
}

export function testFiles(context: SpringContext): GeneratedFile[] {
  return [testDataFile(context), ...context.spec.resources.map((resource) => resourceTests(context, resource))]
}
