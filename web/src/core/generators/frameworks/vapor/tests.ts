/**
 * Tests of the Vapor project (Swift Testing with VaporTesting, in Tests/AppTests/). They call every enabled endpoint
 * through the app, the way a client would, with the same cases as every other framework (common/testing.ts). Each
 * test builds the application anew, so it starts with empty storage and can count items exactly.
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
import { swDoc, swHeader, swString } from '../../languages/swift/swift.ts'
import { block } from './common.ts'
import { article, names, type VaporContext } from './context.ts'

/** A Swift expression for a path whose key is the variable `key`. */
function url(endpoint: SpecEndpoint, resource: SpecResource): string {
  return swString(pathWithKey(endpoint, resource)).replace('{key}', '\\(key)')
}

/** A JSON pointer to a place in a body: `/lines/0/productId`. */
function pointer(path: SampleReference['path']): string {
  return path.map((part) => `/${String(part).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('')
}

/** A JSON value written in Swift: parsed from its text. */
function json(value: JsonValue): string {
  return `parse(${swString(JSON.stringify(value))})`
}

/** A Swift function name from a test title. */
function testName(title: string): string {
  const words = title
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  const name = words
    .map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join('')
  return /^[0-9]/.test(name) ? `test${name}` : name || 'test'
}

const SUPPORT = String.raw`
/// One test at a time on a shared database.
actor TestLock {
    static let shared = TestLock()
    private var busy = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if busy {
            await withCheckedContinuation { waiting.append($0) }
        } else {
            busy = true
        }
    }

    func release() {
        if waiting.isEmpty {
            busy = false
        } else {
            waiting.removeFirst().resume()
        }
    }
}`

const CLIENT = String.raw`
/// The answer of a request in a test: its status and its JSON body (null when it has none).
struct TestResponse {
    let status: UInt
    let text: String
    let json: JSONValue
}

/// The application under test, called through its router.
struct Api {
    let app: Application

    func get(_ path: String, _ headers: HTTPHeaders) async throws -> TestResponse {
        try await send(.GET, path, nil, headers)
    }

    func post(_ path: String, _ body: JSONValue, _ headers: HTTPHeaders) async throws -> TestResponse {
        try await send(.POST, path, body, headers)
    }

    func put(_ path: String, _ body: JSONValue, _ headers: HTTPHeaders) async throws -> TestResponse {
        try await send(.PUT, path, body, headers)
    }

    func patch(_ path: String, _ body: JSONValue, _ headers: HTTPHeaders) async throws -> TestResponse {
        try await send(.PATCH, path, body, headers)
    }

    func delete(_ path: String, _ headers: HTTPHeaders) async throws -> TestResponse {
        try await send(.DELETE, path, nil, headers)
    }

    /// Sends a request, with a JSON body when there is one.
    func send(_ method: HTTPMethod, _ path: String, _ body: JSONValue?, _ headers: HTTPHeaders) async throws -> TestResponse {
        var headers = headers
        var buffer: ByteBuffer?
        if let body {
            headers.contentType = .json
            buffer = ByteBuffer(bytes: try JSONCoding.encoder().encode(body))
        }
        let response = try await app.testing().sendRequest(method, path, headers: headers, body: buffer)
        let text = response.body.string
        let json = (try? JSONCoding.decoder().decode(JSONValue.self, from: Data(text.utf8))) ?? .null
        return TestResponse(status: response.status.code, text: text, json: json)
    }
}`

const HELPERS = String.raw`
extension JSONValue {
    /// The value of a field of an object; null when it is not there.
    subscript(field: String) -> JSONValue {
        if case .object(let object) = self { return object[field] ?? .null }
        return .null
    }

    func has(_ field: String) -> Bool {
        if case .object(let object) = self { return object[field] != nil }
        return false
    }

    /// How many items a list has; nil when it is not a list.
    var count: Int? {
        if case .array(let items) = self { return items.count }
        return nil
    }

    var number: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// The text of a key, for a path.
    var text: String {
        switch self {
        case .string(let value): return value
        case .number(let value): return value.rounded() == value ? String(Int64(value)) : String(value)
        default: return ""
        }
    }
}

/// A JSON value from its text.
func parse(_ text: String) -> JSONValue {
    (try? JSONCoding.decoder().decode(JSONValue.self, from: Data(text.utf8))) ?? .null
}

/// A copy of a JSON value with another value at a JSON pointer: "/lines/0/productId".
func with(_ value: JSONValue, _ pointer: String, _ new: JSONValue) -> JSONValue {
    let steps = pointer.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map {
        $0.replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~")
    }
    return replacing(value, ArraySlice(steps), new)
}

private func replacing(_ value: JSONValue, _ steps: ArraySlice<String>, _ new: JSONValue) -> JSONValue {
    guard let step = steps.first else { return new }
    switch value {
    case .object(var object):
        object[step] = replacing(object[step] ?? .object([:]), steps.dropFirst(), new)
        return .object(object)
    case .array(var items):
        if let index = Int(step), items.indices.contains(index) {
            items[index] = replacing(items[index], steps.dropFirst(), new)
        }
        return .array(items)
    default:
        return value
    }
}

/// A copy of a JSON object without a field.
func without(_ value: JSONValue, _ field: String) -> JSONValue {
    guard case .object(var object) = value else { return value }
    object[field] = nil
    return .object(object)
}`

/** The base of the tests: a new application for each test, the client, credentials and builders of valid bodies. */
function supportFile(context: VaporContext): GeneratedFile {
  const { auth } = context.settings
  const imports = ['App', 'Foundation', 'Testing', 'VaporTesting']
  if (auth === 'jwt') imports.push('JWT')
  const configures = [
    context.fluent && '    let shared = ProcessInfo.processInfo.environment["TEST_DATABASE_URL"] ?? ""',
    auth === 'apiKey' && '    settings.apiKeys = [testAPIKey]',
    auth === 'jwt' && '    settings.jwtSecret = testJWTSecret',
    context.fluent && [
      '    // TEST_DATABASE_URL runs the tests on that database, emptied first; without it, each test has its own SQLite file',
      '    settings.databaseURL = shared.isEmpty ? "sqlite://\\(NSTemporaryDirectory())api-test-\\(UUID().uuidString).db" : shared',
      '    if !shared.isEmpty {',
      '        await TestLock.shared.acquire()',
      '    }',
    ],
  ]
  const mutates = context.fluent || auth !== 'none'
  const withApi: Lines[] = [
    swDoc('Runs a test on a new application, so each one starts with empty storage.'),
    'func withApi(_ test: (Api) async throws -> Void) async throws {',
    `    ${mutates ? 'var' : 'let'} settings = Settings()`,
    configures,
    '    let app = try await Application.make(.testing)',
    '    do {',
    '        try await configure(app, settings: settings)',
    context.fluent && [
      '        if !shared.isEmpty {',
      '            try await app.autoRevert()',
      '            try await app.autoMigrate()',
      '        }',
    ],
    '        try await test(Api(app: app))',
    '    } catch {',
    '        try? await app.asyncShutdown()',
    context.fluent && '        if !shared.isEmpty { await TestLock.shared.release() }',
    '        throw error',
    '    }',
    '    try await app.asyncShutdown()',
    context.fluent && '    if !shared.isEmpty { await TestLock.shared.release() }',
    '}',
  ]
  const headers: Lines[] =
    auth === 'none'
      ? ['func headers() async throws -> HTTPHeaders {', '    HTTPHeaders()', '}']
      : auth === 'apiKey'
        ? ['func headers() async throws -> HTTPHeaders {', '    ["x-api-key": testAPIKey]', '}']
        : [
            'func headers() async throws -> HTTPHeaders {',
            `    ["authorization": "Bearer \\(try await token([${context.spec.roles.map(swString).join(', ')}]))"]`,
            '}',
            '',
            swDoc('Headers of a client with a valid token but no role.'),
            'func headersWithoutRoles() async throws -> HTTPHeaders {',
            '    ["authorization": "Bearer \\(try await token([]))"]',
            '}',
            '',
            swDoc('A token signed with the test secret, valid for one hour.'),
            'func token(_ roles: [String]) async throws -> String {',
            '    let keys = JWTKeyCollection()',
            '    await keys.add(hmac: HMACKey(from: testJWTSecret), digestAlgorithm: .sha256)',
            '    return try await keys.sign(Claims(exp: ExpirationClaim(value: Date().addingTimeInterval(3600)), roles: roles))',
            '}',
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
      return `        body = with(body, ${swString(pointer(reference.path))}, try await create${names(target).type}()[${swString(keyWire(target))}])`
    })
    builders.push(
      lines(
        `    /// A valid body to create ${article(resource.singular)}, with the items it refers to created first.`,
        `    func ${name.one}Payload(_ variant: Int = 0) async throws -> JSONValue {`,
        `        ${fills.length > 0 ? 'var' : 'let'} body = variant == 0 ? ${json(first.body as JsonValue)} : ${json(second.body as JsonValue)}`,
        fills,
        '        return body',
        '    }',
        '',
        `    /// Creates ${article(resource.singular)} and returns it as the API answers.`,
        `    func create${name.type}(_ variant: Int = 0) async throws -> JSONValue {`,
        `        let response = try await post(${swString(create.path)}, ${name.one}Payload(variant), headers())`,
        `        #expect(response.status == ${create.status}, "\\(response.text)")`,
        '        return response.json',
        '    }',
      ),
    )
  }
  const content = lines(
    ...swHeader('Base of the tests: a new application for each test, so each one starts with empty storage.', []),
    imports.map((item) => (item === 'App' ? '@testable import App' : `import ${item}`)),
    '',
    auth === 'apiKey' && [`let testAPIKey = ${swString(TEST_API_KEY)}`, ''],
    auth === 'jwt' && [`let testJWTSecret = ${swString(TEST_JWT_SECRET)}`, ''],
    context.fluent && [block(SUPPORT), ''],
    withApi,
    '',
    swDoc('Headers of a client allowed to call every endpoint.'),
    headers,
    '',
    block(CLIENT),
    builders.length > 0 && ['', 'extension Api {', builders.join('\n\n'), '}'],
    '',
    block(HELPERS),
  )
  return { path: 'Tests/AppTests/Support.swift', content: fileText(content) }
}

/** An expectation that a value of a JSON answer equals a sample value. */
function expectValue(value: JsonValue, actual: string): string {
  if (typeof value === 'number') return `#expect(${actual}.number == ${Number.isInteger(value) ? `${value}.0` : value})`
  return `#expect(${actual} == ${json(value)})`
}

function resourceTestFile(context: VaporContext, resource: SpecResource): GeneratedFile {
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
    for (let n = 2; used.has(fn); n++) fn = `${testName(title)}${n}`
    used.add(fn)
    tests.push(
      skip
        ? lines(`    @Test(${swString(title)}, .disabled(${swString(skip)}))`, `    func ${fn}() {`, ...body.map((line) => line), '    }')
        : lines(
            `    @Test(${swString(title)})`,
            `    func ${fn}() async throws {`,
            '        try await withApi { api in',
            ...body,
            '        }',
            '    }',
          ),
    )
  }
  const createdKey = [
    `            let created = try await api.create${name.type}()`,
    `            let key = created[${swString(key)}].text`,
  ]
  const code = 'response.json["error"]["code"]'
  const status = (expected: number) => `            #expect(response.status == ${expected}, "\\(response.text)")`

  if (context.pending) {
    for (const endpoint of [list, get].filter(Boolean) as SpecEndpoint[]) {
      test(`${endpoint.name} answers 501 until the storage is written`, [
        `            let response = try await api.get(${swString(fixedPath(endpoint, resource, missingKey(resource)))}, headers())`,
        '',
        status(501),
        `            #expect(${code} == .string("not_implemented"))`,
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
        `            let payload = try await api.${name.one}Payload()`,
        '',
        `            let response = try await api.post(${swString(create!.path)}, payload, headers())`,
        '',
        status(create!.status),
        `            #expect(response.json.has(${swString(key)}))`,
        comparableFields(resource, sent).map(
          (wire) => `            #expect(payload[${swString(wire)}] == response.json[${swString(wire)}])`,
        ),
      ])
      const required = requiredField(resource)
      if (required) {
        test(`rejects ${article(resource.singular)} without ${required.wire}`, [
          `            let payload = without(try await api.${name.one}Payload(), ${swString(required.wire)})`,
          '',
          `            let response = try await api.post(${swString(create!.path)}, payload, headers())`,
          '',
          status(400),
          `            #expect(${code} == .string("validation_error"))`,
          '            guard case .array(let details) = response.json["error"]["details"] else {',
          '                Issue.record("The error has no details")',
          '                return',
          '            }',
          `            #expect(details.contains { $0["field"] == .string(${swString(required.wire)}) })`,
        ])
      }
      if (resource.key.generated === null) {
        test(`rejects a second ${resource.singular} with the same key`, [
          `            let created = try await api.create${name.type}()`,
          `            let payload = with(try await api.${name.one}Payload(), ${swString(pointer([key]))}, created[${swString(key)}])`,
          '',
          `            let response = try await api.post(${swString(create!.path)}, payload, headers())`,
          '',
          status(409),
        ])
      }
    }
    if (get) {
      if (canCreate) {
        test(`gets ${article(resource.singular)}`, [
          ...createdKey,
          '',
          `            let response = try await api.get(${url(get, resource)}, headers())`,
          '',
          status(200),
          '            #expect(created == response.json)',
        ])
      }
      test(`answers 404 for a missing ${resource.singular}`, [
        `            let response = try await api.get(${swString(fixedPath(get, resource, missingKey(resource)))}, headers())`,
        '',
        status(404),
        `            #expect(${code} == .string("not_found"))`,
      ])
    }
    if (list) {
      const distinct = sampleKeysDiffer(context.spec, resource)
      const count = canCreate ? (distinct ? 2 : 1) : 0
      test(`lists ${resource.plural}`, [
        canCreate && `            _ = try await api.create${name.type}()`,
        canCreate && distinct && `            _ = try await api.create${name.type}(1)`,
        '',
        `            let response = try await api.get(${swString(list.path)}, headers())`,
        '',
        status(200),
        list.pagination
          ? [`            #expect(response.json["total"] == .number(${count}))`, '            #expect(response.json["page"] == .number(1))']
          : `            #expect(response.json.count == ${count})`,
      ])
      if (list.pagination && canCreate && distinct) {
        test(`lists ${resource.plural} by page`, [
          `            _ = try await api.create${name.type}()`,
          `            _ = try await api.create${name.type}(1)`,
          '',
          `            let response = try await api.get(${swString(`${list.path}?page=2&size=1`)}, headers())`,
          '',
          status(200),
          '            #expect(response.json["total"] == .number(2))',
          '            #expect(response.json["items"].count == 1)',
          '            #expect(response.json["page"] == .number(2))',
        ])
      }
      if (list.pagination) {
        test('rejects a page that does not exist', [
          `            let response = try await api.get(${swString(`${list.path}?page=0`)}, headers())`,
          '',
          status(400),
        ])
      }
    }
    const replace = findEndpoint(resource, 'replace')
    if (replace && canCreate) {
      const compared = comparableFields(resource, sampleBody(context.spec, resource, 1).sample.body).filter((wire) => wire !== key)
      test(`replaces ${article(resource.singular)}`, [
        ...createdKey,
        resource.key.generated === null
          ? `            let payload = with(try await api.${name.one}Payload(1), ${swString(pointer([key]))}, created[${swString(key)}])`
          : `            let payload = try await api.${name.one}Payload(1)`,
        '',
        `            let response = try await api.put(${url(replace, resource)}, payload, headers())`,
        '',
        status(200),
        compared.map((wire) => `            #expect(payload[${swString(wire)}] == response.json[${swString(wire)}])`),
      ])
    }
    const update = findEndpoint(resource, 'update')
    const field = updatableField(resource)
    if (update && canCreate && field) {
      const value = sampleBody(context.spec, resource, 1).sample.body[field.wire] ?? null
      test(`updates part of ${article(resource.singular)}`, [
        ...createdKey,
        '',
        `            let response = try await api.patch(${url(update, resource)}, ${json({ [field.wire]: value })}, headers())`,
        '',
        status(200),
        `            ${expectValue(value, `response.json[${swString(field.wire)}]`)}`,
      ])
      if (!field.nullable) {
        test(`rejects null for ${field.wire}`, [
          ...createdKey,
          '',
          `            let response = try await api.patch(${url(update, resource)}, ${json({ [field.wire]: null })}, headers())`,
          '',
          status(400),
        ])
      }
    }
    const remove = findEndpoint(resource, 'delete')
    if (remove && canCreate) {
      test(`deletes ${article(resource.singular)}`, [
        ...createdKey,
        '',
        `            let response = try await api.delete(${url(remove, resource)}, headers())`,
        '',
        status(remove.status),
        get && `            #expect(try await api.get(${url(get, resource)}, headers()).status == 404)`,
      ])
    }
    for (const endpoint of resource.endpoints.filter((item) => item.operation === 'custom')) {
      const needsItem = endpoint.pathParams.some((param) => param.name === resource.key.param)
      if ((needsItem || endpoint.input === 'resource') && !canCreate) continue
      const body = endpoint.input === 'none' ? 'nil' : endpoint.input === 'partial' ? 'parse("{}")' : `try await api.${name.one}Payload()`
      const path = needsItem ? url(endpoint, resource) : swString(fixedPath(endpoint, resource, 'sample'))
      test(`${endpoint.name} answers 501 until it is written`, [
        needsItem && createdKey,
        '            // TODO: replace this test when the operation is written',
        `            let response = try await api.send(.${endpoint.method}, ${path}, ${body}, headers())`,
        '',
        status(501),
      ])
    }
  }
  const guarded = protectedEndpoint(resource, context.settings.auth)
  if (guarded) {
    test(`${guarded.name} needs credentials`, [
      `            let response = try await api.get(${swString(fixedPath(guarded, resource, missingKey(resource)))}, HTTPHeaders())`,
      '',
      status(401),
      `            #expect(${code} == .string("unauthorized"))`,
    ])
  }
  const withRoles = roleEndpoint(resource, context.settings.auth)
  if (withRoles) {
    test(`${withRoles.name} needs a role`, [
      `            let response = try await api.get(${swString(fixedPath(withRoles, resource, missingKey(resource)))}, headersWithoutRoles())`,
      '',
      status(403),
    ])
  }
  const content = lines(
    ...swHeader(`Tests of the ${resource.plural} endpoints.`, []),
    '@testable import App',
    'import Testing',
    'import VaporTesting',
    '',
    `@Suite(${swString(`${name.plural} API`)})`,
    `struct ${name.tests} {`,
    tests.length > 0 ? tests.join('\n\n') : ['    @Test("has no endpoints")', '    func hasNoEndpoints() {}'],
    '}',
  )
  return { path: `Tests/AppTests/${name.tests}.swift`, content: fileText(content) }
}

export function testFiles(context: VaporContext): GeneratedFile[] {
  return [supportFile(context), ...context.spec.resources.map((resource) => resourceTestFile(context, resource))]
}
