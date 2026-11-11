/**
 * Tests of the Ktor project (kotlin.test on JUnit 5, with ktor-server-test-host). They call every enabled
 * endpoint the way a client would, with the same cases as every other framework (common/testing.ts). Each test
 * starts the application anew, so it starts with empty storage and can count items exactly.
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
import { fileText, lines } from '../../common/text.ts'
import { KtImports, ktDoc, ktHeader, ktString } from '../../languages/kotlin/kotlin.ts'
import { article, commonPackage, names, sourcePath, type KtorContext } from './context.ts'

/** A Kotlin expression for a path whose key is the variable `key`. */
function url(endpoint: SpecEndpoint, resource: SpecResource): string {
  const [before, after] = pathWithKey(endpoint, resource).split('{key}')
  if (after === undefined) return ktString(before)
  return [ktString(before), 'key', after ? ktString(after) : null].filter(Boolean).join(' + ')
}

/** A path in a body for `with`: `listOf("lines", 0, "productId")`. */
function pathList(path: SampleReference['path']): string {
  return `listOf(${path.map((part) => (typeof part === 'number' ? String(part) : ktString(part))).join(', ')})`
}

/** A JSON value written in Kotlin: parsed from its text. */
function json(value: JsonValue): string {
  return `Json.parseToJsonElement(${ktString(JSON.stringify(value))})`
}

/** A test name from its title, as Kotlin writes it between backticks. */
function testName(title: string): string {
  return title
    .replace(/[^A-Za-z0-9 _-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The base of the tests: a new application for each test, the client helpers and the JSON helpers. */
function apiTestFile(context: KtorContext): GeneratedFile {
  const pkg = context.base
  const imports = new KtImports(pkg).add(
    'io.ktor.client.HttpClient',
    'io.ktor.client.request.header',
    'io.ktor.client.request.request',
    'io.ktor.client.request.setBody',
    'io.ktor.client.statement.bodyAsText',
    'io.ktor.http.ContentType',
    'io.ktor.http.HttpMethod',
    'io.ktor.http.contentType',
    'io.ktor.server.testing.testApplication',
    'kotlinx.serialization.json.Json',
    'kotlinx.serialization.json.JsonArray',
    'kotlinx.serialization.json.JsonElement',
    'kotlinx.serialization.json.JsonObject',
    'kotlinx.serialization.json.jsonArray',
    'kotlinx.serialization.json.jsonObject',
    'kotlin.test.assertEquals',
  )
  const content = lines(
    ...ktHeader(pkg, imports),
    ktDoc('Base of the tests: a new application for each test, so each one starts with empty storage.'),
    'abstract class ApiTest {',
    '    protected fun api(test: suspend Api.() -> Unit) = testApplication {',
    '        application { module(testSettings()) }',
    '        Api(client).test()',
    '    }',
    '}',
    '',
    ktDoc('Calls the application under test with JSON.'),
    'class Api(private val client: HttpClient) {',
    '    suspend fun get(path: String, headers: Map<String, String> = emptyMap()) = send(HttpMethod.Get, path, null, headers)',
    '',
    '    suspend fun post(path: String, body: JsonElement?, headers: Map<String, String> = emptyMap()) =',
    '        send(HttpMethod.Post, path, body, headers)',
    '',
    '    suspend fun put(path: String, body: JsonElement?, headers: Map<String, String> = emptyMap()) =',
    '        send(HttpMethod.Put, path, body, headers)',
    '',
    '    suspend fun patch(path: String, body: JsonElement?, headers: Map<String, String> = emptyMap()) =',
    '        send(HttpMethod.Patch, path, body, headers)',
    '',
    '    suspend fun delete(path: String, headers: Map<String, String> = emptyMap()) = send(HttpMethod.Delete, path, null, headers)',
    '',
    '    /** Sends a request, with a JSON body when there is one. */',
    '    suspend fun send(method: HttpMethod, path: String, body: JsonElement?, headers: Map<String, String>): TestResponse {',
    '        val response = client.request(path) {',
    '            this.method = method',
    '            for ((name, value) in headers) header(name, value)',
    '            if (body != null) {',
    '                contentType(ContentType.Application.Json)',
    '                setBody(body.toString())',
    '            }',
    '        }',
    '        return TestResponse(response.status.value, response.bodyAsText())',
    '    }',
    '}',
    '',
    ktDoc('The answer of a request in a test: its status, and its JSON body or a value inside it ("error.code").'),
    'class TestResponse(val status: Int, private val text: String) {',
    '    val json: JsonElement? = if (text.isEmpty()) null else Json.parseToJsonElement(text)',
    '',
    '    fun assertStatus(expected: Int) = assertEquals(expected, status, text)',
    '',
    '    fun at(path: String): JsonElement? = path.split(".").fold(json) { node, part -> (node as? JsonObject)?.get(part) }',
    '}',
    '',
    ktDoc('A copy of a JSON value with another value at a path: listOf("lines", 0, "productId").'),
    'fun JsonElement.with(path: List<Any>, value: JsonElement): JsonElement {',
    '    if (path.isEmpty()) return value',
    '    val rest = path.drop(1)',
    '    return when (val step = path.first()) {',
    '        is String -> JsonObject(jsonObject + (step to (jsonObject[step] ?: JsonObject(emptyMap())).with(rest, value)))',
    '        else -> JsonArray(jsonArray.mapIndexed { index, item -> if (index == step) item.with(rest, value) else item })',
    '    }',
    '}',
    '',
    ktDoc('A copy of a JSON object without a field.'),
    'fun JsonObject.without(field: String) = JsonObject(this - field)',
  )
  return { path: sourcePath(pkg, 'ApiTest', true), content: fileText(content) }
}

/** Credentials, settings, builders of valid request bodies, and helpers that create items through the API. */
function testDataFile(context: KtorContext): GeneratedFile {
  const pkg = context.base
  const common = commonPackage(context)
  const { auth, database } = context.settings
  const imports = new KtImports(pkg).add(
    'kotlinx.serialization.json.Json',
    'kotlinx.serialization.json.JsonObject',
    'kotlinx.serialization.json.jsonObject',
    `${common}.Settings`,
  )
  if (auth === 'jwt') imports.add('com.auth0.jwt.JWT', 'com.auth0.jwt.algorithms.Algorithm', 'java.util.Date')
  if (context.exposed)
    imports.add(
      'org.jetbrains.exposed.v1.jdbc.Database',
      'org.jetbrains.exposed.v1.jdbc.SchemaUtils',
      'org.jetbrains.exposed.v1.jdbc.transactions.transaction',
      `${context.base}.database.TABLES`,
      'java.util.UUID',
    )
  const blocks: string[] = []
  for (const resource of context.spec.resources) {
    if (!creatable(context.spec, resource)) continue
    const name = names(resource)
    const create = findEndpoint(resource, 'create')!
    const first = sampleBody(context.spec, resource, 0).sample
    const second = sampleBody(context.spec, resource, 1).sample
    const fills = first.references.map((reference) => {
      const target = context.spec.resources.find((item) => item.name === reference.resource)!
      return `    body = body.with(${pathList(reference.path)}, create${names(target).type}().getValue(${ktString(keyWire(target))}))`
    })
    blocks.push(
      lines(
        `/** A valid body to create ${article(resource.singular)}, with the items it refers to created first. */`,
        `suspend fun Api.${name.one}Payload(variant: Int = 0): JsonObject {`,
        `    ${fills.length > 0 ? 'var' : 'val'} body = if (variant == 0) ${json(first.body as JsonValue)} else ${json(second.body as JsonValue)}`,
        fills,
        '    return body.jsonObject',
        '}',
        '',
        `/** Creates ${article(resource.singular)} and returns it as the API answers. */`,
        `suspend fun Api.create${name.type}(variant: Int = 0): JsonObject {`,
        `    val response = post(${ktString(create.path)}, ${name.one}Payload(variant), headers())`,
        `    response.assertStatus(${create.status})`,
        '    return response.json!!.jsonObject',
        '}',
      ),
    )
  }
  const settings = [
    context.exposed && '    databaseUrl = url,',
    context.exposed && database !== 'sqlite' && ['    databaseUser = user,', '    databasePassword = password,'],
    auth === 'apiKey' && '    apiKeys = listOf(TEST_API_KEY),',
    auth === 'jwt' && '    jwtSecret = TEST_JWT_SECRET,',
  ]
  const content = lines(
    ...ktHeader(pkg, imports),
    auth === 'apiKey' && [`const val TEST_API_KEY = ${ktString(TEST_API_KEY)}`, ''],
    auth === 'jwt' && [`const val TEST_JWT_SECRET = ${ktString(TEST_JWT_SECRET)}`, ''],
    ktDoc('Settings of the application under test.'),
    context.exposed
      ? [
          'fun testSettings(): Settings {',
          '    // TEST_DATABASE_URL runs the tests on that database, emptied first; without it, each test has its own',
          '    val shared = System.getenv("TEST_DATABASE_URL").orEmpty()',
          database !== 'sqlite' && [
            '    val user = System.getenv("TEST_DATABASE_USER").orEmpty()',
            '    val password = System.getenv("TEST_DATABASE_PASSWORD").orEmpty()',
          ],
          '    val url = if (shared.isEmpty()) {',
          database === 'sqlite'
            ? '        "jdbc:sqlite:${System.getProperty("java.io.tmpdir")}/api-test-${UUID.randomUUID()}.db"'
            : '        "jdbc:h2:mem:test-${UUID.randomUUID()}"',
          '    } else {',
          `        val database = Database.connect(shared${database !== 'sqlite' ? ', user = user, password = password' : ''})`,
          '        transaction(database) { SchemaUtils.drop(*TABLES) }',
          '        shared',
          '    }',
          '    return Settings(',
          settings,
          '    )',
          '}',
        ]
      : auth === 'none'
        ? 'fun testSettings() = Settings()'
        : ['fun testSettings() = Settings(', settings, ')'],
    '',
    ktDoc('Headers of a client allowed to call every endpoint.'),
    auth === 'none' && 'fun headers(): Map<String, String> = emptyMap()',
    auth === 'apiKey' && 'fun headers(): Map<String, String> = mapOf("X-API-Key" to TEST_API_KEY)',
    auth === 'jwt' && [
      `fun headers(): Map<String, String> = mapOf("Authorization" to "Bearer \${token(listOf(${context.spec.roles.map(ktString).join(', ')}))}")`,
      '',
      ktDoc('Headers of a client with a valid token but no role.'),
      'fun headersWithoutRoles(): Map<String, String> = mapOf("Authorization" to "Bearer ${token(emptyList())}")',
      '',
      ktDoc('A token signed with the test secret, valid for one hour.'),
      'fun token(roles: List<String>): String = JWT.create()',
      '    .withSubject("tests")',
      '    .withClaim("roles", roles)',
      '    .withExpiresAt(Date(System.currentTimeMillis() + 3_600_000))',
      '    .sign(Algorithm.HMAC256(TEST_JWT_SECRET))',
    ],
    blocks.length > 0 && ['', blocks.join('\n\n')],
  )
  return { path: sourcePath(pkg, 'TestData', true), content: fileText(content) }
}

/** A kotlin.test assertion that a value of a JSON answer equals a sample value. */
function assertValue(value: JsonValue, actual: string): string {
  if (typeof value === 'number') return `assertEquals(${Number.isInteger(value) ? `${value}.0` : value}, ${actual}!!.jsonPrimitive.double)`
  if (typeof value === 'string') return `assertEquals(${ktString(value)}, ${actual}!!.jsonPrimitive.content)`
  if (typeof value === 'boolean') return `assertEquals(${value}, ${actual}!!.jsonPrimitive.boolean)`
  return `assertEquals(${json(value)}, ${actual})`
}

function resourceTestFile(context: KtorContext, resource: SpecResource): GeneratedFile {
  const pkg = context.base
  const name = names(resource)
  const key = keyWire(resource)
  const tests: string[] = []
  const canCreate = creatable(context.spec, resource)
  const problem = sampleBody(context.spec, resource, 0).problem
  const get = findEndpoint(resource, 'get')
  const create = findEndpoint(resource, 'create')
  const list = findEndpoint(resource, 'list')
  const used = new Set<string>()
  const test = (title: string, body: (string | false | null | undefined | string[])[], skip?: string) => {
    let method = testName(title)
    for (let n = 2; used.has(method); n++) method = `${testName(title)} ${n}`
    used.add(method)
    tests.push(
      skip
        ? lines(`    @Ignore(${ktString(skip)})`, '    @Test', `    fun \`${method}\`() {`, ...body, '    }')
        : lines('    @Test', `    fun \`${method}\`() = api {`, ...body, '    }'),
    )
  }
  const createdKey = [
    `        val created = create${name.type}()`,
    `        val key = created.getValue(${ktString(key)}).jsonPrimitive.content`,
  ]
  const code = 'response.at("error.code")?.jsonPrimitive?.content'

  if (context.pending) {
    for (const endpoint of [list, get].filter(Boolean) as SpecEndpoint[]) {
      test(`${endpoint.name} answers 501 until the storage is written`, [
        `        val response = get(${ktString(fixedPath(endpoint, resource, missingKey(resource)))}, headers())`,
        '',
        '        response.assertStatus(501)',
        `        assertEquals("not_implemented", ${code})`,
      ])
    }
  } else {
    if (create && !canCreate) {
      test(
        `creates ${article(resource.singular)}`,
        [`        // TODO: ${problem ?? 'write a body with the items it refers to'}`],
        problem ?? 'An item it refers to cannot be created through the API.',
      )
    }
    if (canCreate) {
      const sent = sampleBody(context.spec, resource, 0).sample.body
      test(`creates ${article(resource.singular)}`, [
        `        val payload = ${name.one}Payload()`,
        '',
        `        val response = post(${ktString(create!.path)}, payload, headers())`,
        '',
        `        response.assertStatus(${create!.status})`,
        '        val body = response.json!!.jsonObject',
        `        assertTrue(${ktString(key)} in body)`,
        comparableFields(resource, sent).map((wire) => `        assertEquals(payload[${ktString(wire)}], body[${ktString(wire)}])`),
      ])
      const required = requiredField(resource)
      if (required) {
        test(`rejects ${article(resource.singular)} without ${required.wire}`, [
          `        val payload = ${name.one}Payload().without(${ktString(required.wire)})`,
          '',
          `        val response = post(${ktString(create!.path)}, payload, headers())`,
          '',
          '        response.assertStatus(400)',
          `        assertEquals("validation_error", ${code})`,
          `        assertTrue(response.at("error.details")!!.jsonArray.any { it.jsonObject["field"]?.jsonPrimitive?.content == ${ktString(required.wire)} })`,
        ])
      }
      if (resource.key.generated === null) {
        test(`rejects a second ${resource.singular} with the same key`, [
          `        val created = create${name.type}()`,
          `        val payload = ${name.one}Payload().with(listOf(${ktString(key)}), created.getValue(${ktString(key)}))`,
          '',
          `        val response = post(${ktString(create!.path)}, payload, headers())`,
          '',
          '        response.assertStatus(409)',
        ])
      }
    }
    if (get) {
      if (canCreate) {
        test(`gets ${article(resource.singular)}`, [
          ...createdKey,
          '',
          `        val response = get(${url(get, resource)}, headers())`,
          '',
          '        response.assertStatus(200)',
          '        assertEquals(created, response.json)',
        ])
      }
      test(`answers 404 for a missing ${resource.singular}`, [
        `        val response = get(${ktString(fixedPath(get, resource, missingKey(resource)))}, headers())`,
        '',
        '        response.assertStatus(404)',
        `        assertEquals("not_found", ${code})`,
      ])
    }
    if (list) {
      const distinct = sampleKeysDiffer(context.spec, resource)
      const count = canCreate ? (distinct ? 2 : 1) : 0
      test(`lists ${resource.plural}`, [
        canCreate && `        create${name.type}()`,
        canCreate && distinct && `        create${name.type}(1)`,
        '',
        `        val response = get(${ktString(list.path)}, headers())`,
        '',
        '        response.assertStatus(200)',
        list.pagination
          ? [
              `        assertEquals(${count}, response.at("total")!!.jsonPrimitive.int)`,
              '        assertEquals(1, response.at("page")!!.jsonPrimitive.int)',
            ]
          : `        assertEquals(${count}, response.json!!.jsonArray.size)`,
      ])
      if (list.pagination && canCreate && distinct) {
        test(`lists ${resource.plural} by page`, [
          `        create${name.type}()`,
          `        create${name.type}(1)`,
          '',
          `        val response = get(${ktString(`${list.path}?page=2&size=1`)}, headers())`,
          '',
          '        response.assertStatus(200)',
          '        assertEquals(2, response.at("total")!!.jsonPrimitive.int)',
          '        assertEquals(1, response.at("items")!!.jsonArray.size)',
          '        assertEquals(2, response.at("page")!!.jsonPrimitive.int)',
        ])
      }
      if (list.pagination) {
        test('rejects a page that does not exist', [
          `        val response = get(${ktString(`${list.path}?page=0`)}, headers())`,
          '',
          '        response.assertStatus(400)',
        ])
      }
    }
    const replace = findEndpoint(resource, 'replace')
    if (replace && canCreate) {
      const compared = comparableFields(resource, sampleBody(context.spec, resource, 1).sample.body).filter((wire) => wire !== key)
      test(`replaces ${article(resource.singular)}`, [
        ...createdKey,
        resource.key.generated === null
          ? `        val payload = ${name.one}Payload(1).with(listOf(${ktString(key)}), created.getValue(${ktString(key)})).jsonObject`
          : `        val payload = ${name.one}Payload(1)`,
        '',
        `        val response = put(${url(replace, resource)}, payload, headers())`,
        '',
        '        response.assertStatus(200)',
        compared.length > 0 && '        val body = response.json!!.jsonObject',
        compared.map((wire) => `        assertEquals(payload[${ktString(wire)}], body[${ktString(wire)}])`),
      ])
    }
    const update = findEndpoint(resource, 'update')
    const field = updatableField(resource)
    if (update && canCreate && field) {
      const value = sampleBody(context.spec, resource, 1).sample.body[field.wire] ?? null
      test(`updates part of ${article(resource.singular)}`, [
        ...createdKey,
        '',
        `        val response = patch(${url(update, resource)}, ${json({ [field.wire]: value })}, headers())`,
        '',
        '        response.assertStatus(200)',
        `        ${assertValue(value, `response.json!!.jsonObject[${ktString(field.wire)}]`)}`,
      ])
      if (!field.nullable) {
        test(`rejects null for ${field.wire}`, [
          ...createdKey,
          '',
          `        val response = patch(${url(update, resource)}, ${json({ [field.wire]: null })}, headers())`,
          '',
          '        response.assertStatus(400)',
        ])
      }
    }
    const remove = findEndpoint(resource, 'delete')
    if (remove && canCreate) {
      test(`deletes ${article(resource.singular)}`, [
        ...createdKey,
        '',
        `        val response = delete(${url(remove, resource)}, headers())`,
        '',
        `        response.assertStatus(${remove.status})`,
        get && `        get(${url(get, resource)}, headers()).assertStatus(404)`,
      ])
    }
    for (const endpoint of resource.endpoints.filter((item) => item.operation === 'custom')) {
      const needsItem = endpoint.pathParams.some((param) => param.name === resource.key.param)
      if ((needsItem || endpoint.input === 'resource') && !canCreate) continue
      const body = endpoint.input === 'none' ? 'null' : endpoint.input === 'partial' ? 'JsonObject(emptyMap())' : `${name.one}Payload()`
      const path = needsItem ? url(endpoint, resource) : ktString(fixedPath(endpoint, resource, 'sample'))
      test(`${endpoint.name} answers 501 until it is written`, [
        needsItem && createdKey,
        '        // TODO: replace this test when the operation is written',
        `        val response = send(HttpMethod(${ktString(endpoint.method)}), ${path}, ${body}, headers())`,
        '',
        '        response.assertStatus(501)',
      ])
    }
  }
  const guarded = protectedEndpoint(resource, context.settings.auth)
  if (guarded) {
    test(`${guarded.name} needs credentials`, [
      `        val response = get(${ktString(fixedPath(guarded, resource, missingKey(resource)))})`,
      '',
      '        response.assertStatus(401)',
      `        assertEquals("unauthorized", ${code})`,
    ])
  }
  const withRoles = roleEndpoint(resource, context.settings.auth)
  if (withRoles) {
    test(`${withRoles.name} needs a role`, [
      `        val response = get(${ktString(fixedPath(withRoles, resource, missingKey(resource)))}, headersWithoutRoles())`,
      '',
      '        response.assertStatus(403)',
    ])
  }
  const body = tests.join('\n\n')
  const imports = new KtImports(pkg).add('kotlin.test.Test', 'kotlin.test.assertEquals')
  const uses = (text: string, ...items: string[]) => body.includes(text) && imports.add(...items)
  uses('@Ignore', 'kotlin.test.Ignore')
  uses('assertTrue', 'kotlin.test.assertTrue')
  uses('jsonPrimitive', 'kotlinx.serialization.json.jsonPrimitive')
  uses('jsonObject', 'kotlinx.serialization.json.jsonObject')
  uses('jsonArray', 'kotlinx.serialization.json.jsonArray')
  uses('.int)', 'kotlinx.serialization.json.int')
  uses('.double)', 'kotlinx.serialization.json.double')
  uses('.boolean)', 'kotlinx.serialization.json.boolean')
  uses('Json.parseToJsonElement', 'kotlinx.serialization.json.Json')
  uses('JsonObject(', 'kotlinx.serialization.json.JsonObject')
  uses('HttpMethod(', 'io.ktor.http.HttpMethod')
  const content = lines(
    ...ktHeader(pkg, imports),
    ktDoc(`Tests of the ${resource.plural} endpoints.`),
    `class ${name.type}ApiTest : ApiTest() {`,
    tests.length > 0 ? body : ['    @Test', '    fun `has no endpoints`() {', '    }'],
    '}',
  )
  return { path: sourcePath(pkg, `${name.type}ApiTest`, true), content: fileText(content) }
}

export function testFiles(context: KtorContext): GeneratedFile[] {
  return [apiTestFile(context), testDataFile(context), ...context.spec.resources.map((resource) => resourceTestFile(context, resource))]
}
