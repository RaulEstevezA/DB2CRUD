/**
 * Files of the Vapor project that do not belong to one resource: the entry point and the wiring of the app, the
 * error format and its middleware, JSON, the reading of request bodies with their rules, list queries, query
 * strings, the clock, the settings read from the environment, authentication and the database connection.
 */
import { GENERAL_ERROR_CODES } from '../../../openapi/build.ts'
import { referencedResources } from '../../common/references.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines, type Lines } from '../../common/text.ts'
import { swDoc, swHeader, swString } from '../../languages/swift/swift.ts'
import { names, type VaporContext } from './context.ts'

/** Default database URL of each database, for a database on this computer. */
export const DATABASE_URLS: Record<string, string> = {
  postgresql: 'postgres://api:change-me@localhost:5432/api',
  mysql: 'mysql://api:change-me@localhost:3306/api',
  mariadb: 'mysql://api:change-me@localhost:3306/api',
  sqlite: 'sqlite://app.db',
}

/** The lines of a block of Swift written as one text, without its first line break. */
export function block(text: string): string[] {
  return (text.startsWith('\n') ? text.slice(1) : text).split('\n')
}

function file(name: string, doc: string, imports: string[], body: Lines[]): GeneratedFile {
  return { path: `Sources/App/Common/${name}.swift`, content: fileText(lines(...swHeader(doc, imports), ...body)) }
}

const API_ERROR = String.raw`
/// Where the request is wrong and why.
struct ErrorDetail: Codable, Sendable {
    let field: String
    let message: String
}

/// An error the API answers with a status, a code and a message (see openapi.yaml).
struct ApiError: Error, Sendable {
    let status: HTTPStatus
    let code: String
    let message: String
    var details: [ErrorDetail] = []

    /// A request that breaks its rules, with each problem.
    static func invalidBody(_ details: [ErrorDetail]) -> ApiError {
        ApiError(status: .badRequest, code: "validation_error", message: "The request is not valid", details: details)
    }

    static func invalid(_ field: String, _ message: String) -> ApiError {
        invalidBody([ErrorDetail(field: field, message: message)])
    }

    static func notFound(_ what: String) -> ApiError {
        ApiError(status: .notFound, code: "not_found", message: "No \(what) has this key")
    }

    static func conflict(_ message: String) -> ApiError {
        ApiError(status: .conflict, code: "conflict", message: message)
    }

    static func unauthorized() -> ApiError {
        ApiError(status: .unauthorized, code: "unauthorized", message: "Missing or invalid credentials")
    }

    static func forbidden() -> ApiError {
        ApiError(status: .forbidden, code: "forbidden", message: "The credentials do not allow this operation")
    }

    /// Code still to write: the API answers 501.
    static func notImplemented(_ message: String) -> ApiError {
        ApiError(status: .notImplemented, code: "not_implemented", message: message)
    }`

const MIDDLEWARE_TAIL = String.raw`
    /// The error as the API answers it.
    private func errorResponse(_ error: ApiError) -> Response {
        let body = ErrorEnvelope(error: ErrorBody(code: error.code, message: error.message, details: error.details.isEmpty ? nil : error.details))
        return (try? jsonResponse(error.status, body)) ?? Response(status: error.status)
    }

    /// Whether a route takes this path with another method.
    private func acceptsOtherMethod(_ request: Request) -> Bool {
        let parts = request.url.path.split(separator: "/").map(String.init)
        return request.application.routes.all.contains { route in
            route.method != request.method && matches(route.path, parts)
        }
    }

    private func matches(_ path: [PathComponent], _ parts: [String]) -> Bool {
        guard path.count == parts.count else { return false }
        for (component, part) in zip(path, parts) {
            switch component {
            case .constant(let text) where text != part:
                return false
            case .catchall:
                return true
            default:
                continue
            }
        }
        return true
    }
}

private struct ErrorEnvelope: Encodable {
    let error: ErrorBody
}

private struct ErrorBody: Encodable {
    let code: String
    let message: String
    let details: [ErrorDetail]?
}`

const JSON = String.raw`
/// Any JSON value: request bodies are checked on it before they are decoded.
enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

/// The JSON of the API: date-times in ISO 8601 with milliseconds, keys in order.
enum JSONCoding {
    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(formatDateTime(date))
        }
        return encoder
    }

    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = parseDateTime(text) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not an ISO 8601 date-time")
            }
            return date
        }
        return decoder
    }
}

/// A date-time as ISO 8601 text, to the nearest millisecond: a database that keeps dates as doubles may read back a
/// hair less than it stored.
func formatDateTime(_ date: Date) -> String {
    let rounded = Date(timeIntervalSince1970: (date.timeIntervalSince1970 * 1000).rounded() / 1000)
    return rounded.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
}

/// A date-time written in ISO 8601, with or without fractions of a second.
func parseDateTime(_ text: String) -> Date? {
    (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text)) ?? (try? Date.ISO8601FormatStyle().parse(text))
}

/// UUIDs are written in lower case.
func jsonUUID(_ value: UUID?) -> String? {
    value?.uuidString.lowercased()
}

func jsonUUIDs(_ values: [UUID]?) -> [String]? {
    values?.map { $0.uuidString.lowercased() }
}

/// A value stored as JSON text, and back.
func jsonText<T: Encodable>(_ value: T?) -> String? {
    guard let value, let data = try? JSONCoding.encoder().encode(value) else { return nil }
    return String(decoding: data, as: UTF8.self)
}

func jsonValue<T: Decodable>(_ text: String?, as type: T.Type) -> T? {
    guard let text else { return nil }
    return try? JSONCoding.decoder().decode(type, from: Data(text.utf8))
}

/// A JSON answer with a status.
func jsonResponse(_ status: HTTPStatus, _ value: some Encodable) throws -> Response {
    var headers = HTTPHeaders()
    headers.contentType = .json
    return Response(status: status, headers: headers, body: .init(data: try JSONCoding.encoder().encode(value)))
}`

const BODY = String.raw`
/// A request body: its values, and the JSON names it carried (a field sent as null is there, a missing one is not).
struct Body<T: Sendable>: Sendable {
    let value: T
    let sent: Set<String>

    func has(_ field: String) -> Bool {
        sent.contains(field)
    }
}

/// The kinds of JSON value a field can hold.
enum JsonKind: String {
    case text
    case whole = "whole number"
    case number
    case boolean
    case list
    case object
}

/// The rules of a body or an embedded object, run on its JSON.
typealias Rules = (inout Checks, [String: JSONValue]) -> Void

/// The problems of a request body, by field. Embedded objects add their path: address.street.
struct Checks {
    private(set) var problems: [ErrorDetail] = []
    private var prefix = ""

    mutating func fail(_ field: String, _ message: String) {
        problems.append(ErrorDetail(field: prefix + field, message: message))
    }

    /// Every field is one the contract describes.
    mutating func only(_ json: [String: JSONValue], _ fields: Set<String>) {
        for field in json.keys.sorted() where !fields.contains(field) {
            fail(field, "The field is not part of the contract")
        }
    }

    mutating func required(_ json: [String: JSONValue], _ field: String) {
        if json[field] == nil {
            fail(field, "The field is required")
        }
    }

    mutating func notNull(_ json: [String: JSONValue], _ field: String) {
        if json[field] == .null {
            fail(field, "The field must not be null")
        }
    }

    /// The value has the kind of the field; null is left to notNull.
    mutating func kind(_ json: [String: JSONValue], _ field: String, _ kind: JsonKind) {
        guard let value = json[field], value != .null else { return }
        let valid: Bool
        switch (kind, value) {
        case (.text, .string), (.number, .number), (.boolean, .bool), (.list, .array), (.object, .object):
            valid = true
        case (.whole, .number(let number)):
            valid = number.rounded() == number
        default:
            valid = false
        }
        if !valid {
            fail(field, "Must be \(kind.rawValue)")
        }
    }

    mutating func length(_ json: [String: JSONValue], _ field: String, min: Int?, max: Int?) {
        guard case .string(let text)? = json[field] else { return }
        // Counted as JavaScript counts: in UTF-16 units
        let length = text.utf16.count
        if min.map({ length < $0 }) ?? false || max.map({ length > $0 }) ?? false {
            fail(field, "Has a length out of its limits")
        }
    }

    mutating func count(_ json: [String: JSONValue], _ field: String, min: Int?, max: Int?) {
        guard case .array(let list)? = json[field] else { return }
        if min.map({ list.count < $0 }) ?? false || max.map({ list.count > $0 }) ?? false {
            fail(field, "Has a number of items out of its limits")
        }
    }

    mutating func range(_ json: [String: JSONValue], _ field: String, min: Double?, max: Double?, minExclusive: Bool, maxExclusive: Bool) {
        guard case .number(let number)? = json[field] else { return }
        let below = min.map { number < $0 || (minExclusive && number == $0) } ?? false
        let above = max.map { number > $0 || (maxExclusive && number == $0) } ?? false
        if below || above {
            fail(field, "Is out of its range")
        }
    }

    /// The text matches the expression somewhere, as "pattern" reads it in openapi.yaml.
    mutating func pattern(_ json: [String: JSONValue], _ field: String, _ pattern: String) {
        // An expression this engine cannot read checks nothing, rather than reject every value
        guard case .string(let text)? = json[field], let regex = try? NSRegularExpression(pattern: pattern) else { return }
        if regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) == nil {
            fail(field, "Has the wrong format")
        }
    }

    mutating func email(_ json: [String: JSONValue], _ field: String) {
        guard case .string(let text)? = json[field] else { return }
        let parts = text.split(separator: "@", omittingEmptySubsequences: false)
        let valid = parts.count == 2 && !parts[0].isEmpty && !parts[1].isEmpty && !text.contains(where: \.isWhitespace)
        if !valid {
            fail(field, "Must be an email address")
        }
    }

    /// The rules of an embedded object, with its path before each field.
    mutating func nested(_ json: [String: JSONValue], _ field: String, _ rules: Rules) {
        if case .object(let inner)? = json[field] {
            run(prefix + field + ".", inner, rules)
        }
    }

    /// The rules of each embedded object of a list.
    mutating func each(_ json: [String: JSONValue], _ field: String, _ rules: Rules) {
        guard case .array(let list)? = json[field] else { return }
        for (index, item) in list.enumerated() {
            if case .object(let inner) = item {
                run(prefix + field + "[\(index)].", inner, rules)
            }
        }
    }

    private mutating func run(_ prefix: String, _ json: [String: JSONValue], _ rules: Rules) {
        var inner = Checks()
        inner.prefix = prefix
        rules(&inner, json)
        problems.append(contentsOf: inner.problems)
    }
}

/// Reads a request body: a JSON object that meets its rules (with every problem reported) and has no field the
/// contract does not describe.
func readBody<T: Decodable & Sendable>(_ request: Request, as type: T.Type, rules: Rules) throws -> Body<T> {
    let data = request.body.data.map { Data(buffer: $0) } ?? Data()
    guard let json = try? JSONCoding.decoder().decode(JSONValue.self, from: data) else {
        throw ApiError.invalid("", "The body is not valid JSON")
    }
    guard case .object(let object) = json else {
        throw ApiError.invalid("", "The body must be a JSON object")
    }
    var checks = Checks()
    rules(&checks, object)
    if !checks.problems.isEmpty {
        throw ApiError.invalidBody(checks.problems)
    }
    guard let value = try? JSONCoding.decoder().decode(type, from: data) else {
        throw ApiError.invalid("", "The body does not match its type")
    }
    return Body(value: value, sent: Set(object.keys))
}`

const LIST = String.raw`
/// A list: the filters of its resource, an order by a JSON field name and a window.
struct ListQuery<F: Sendable>: Sendable {
    let filters: F
    let sortField: String?
    let descending: Bool
    let offset: Int
    let limit: Int?

    /// "-createdAt" sorts by createdAt in descending order.
    init(filters: F, sort: String?, offset: Int, limit: Int?) {
        self.filters = filters
        descending = sort?.hasPrefix("-") ?? false
        sortField = sort.map { $0.hasPrefix("-") ? String($0.dropFirst()) : $0 }
        self.offset = offset
        self.limit = limit
    }
}

/// A window of items and how many match, whatever the window.
struct ListResult<T: Sendable>: Sendable {
    let items: [T]
    let total: Int
}

/// One page of a list, as the API returns it.
struct PageResponse<T: Encodable & Sendable>: Encodable, Sendable {
    let items: [T]
    let total: Int
    let page: Int
    let size: Int
}

/// Whether a value of a field goes before another: the ones without a value go last, whatever the order. Nil when
/// they are equal.
func comesFirst<T: Comparable>(_ a: T?, _ b: T?, descending: Bool) -> Bool? {
    switch (a, b) {
    case let (a?, b?):
        if a == b { return nil }
        return descending ? a > b : a < b
    case (.some, .none):
        return true
    case (.none, .some):
        return false
    case (.none, .none):
        return nil
    }
}`

const QUERY = String.raw`
/// A whole number key of the path.
func intKey(_ request: Request, _ name: String) throws -> Int64 {
    guard let value = request.parameters.get(name).flatMap({ Int64($0) }) else {
        throw ApiError.invalid(name, "Must be a whole number")
    }
    return value
}

func uuidKey(_ request: Request, _ name: String) throws -> UUID {
    guard let value = request.parameters.get(name).flatMap(parseUUID) else {
        throw ApiError.invalid(name, "Must be a UUID")
    }
    return value
}

func textKey(_ request: Request, _ name: String) throws -> String {
    guard let value = request.parameters.get(name) else {
        throw ApiError.invalid(name, "Is missing")
    }
    return value
}

/// A whole number of the query string within its limits; the default when it is not there.
func intQuery(_ request: Request, _ name: String, default value: Int, min: Int, max: Int?) throws -> Int {
    guard let text = request.query[String.self, at: name] else { return value }
    guard let number = Int(text), number >= min, max.map({ number <= $0 }) ?? true else {
        throw ApiError.invalid(name, "Must be a whole number within its limits")
    }
    return number
}

/// A filter of the query string read with its type, or nil when it is not there; a malformed one is a 400.
func queryFilter<T>(_ request: Request, _ name: String, _ parse: (String) -> T?) throws -> T? {
    guard let text = request.query[String.self, at: name] else { return nil }
    guard let value = parse(text) else {
        throw ApiError.invalid(name, "Has the wrong format")
    }
    return value
}

/// A value of the query string that must be one of the choices.
func choiceQuery(_ request: Request, _ name: String, _ choices: [String]) throws -> String? {
    guard let text = request.query[String.self, at: name] else { return nil }
    guard choices.contains(text) else {
        throw ApiError.invalid(name, "Must be one of: \(choices.joined(separator: ", "))")
    }
    return text
}

/// A UUID written as 8-4-4-4-12 hexadecimal digits.
func parseUUID(_ text: String) -> UUID? {
    let canonical = text.count == 36 && text.enumerated().allSatisfy { index, char in
        [8, 13, 18, 23].contains(index) ? char == "-" : char.isHexDigit
    }
    return canonical ? UUID(uuidString: text) : nil
}

/// A date without time: ISO 8601 text, kept as it is.
func parseDate(_ text: String) -> String? {
    text.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil ? text : nil
}

func parseBool(_ text: String) -> Bool? {
    text == "true" ? true : text == "false" ? false : nil
}`

const CLOCK = String.raw`
/// The time the server writes, in UTC.
enum ServerClock {
    /// Now, to the millisecond: what the API writes, so a later read gives the same value.
    static func now() -> Date {
        Date(timeIntervalSince1970: (Date().timeIntervalSince1970 * 1000).rounded(.down) / 1000)
    }

    /// Today as ISO 8601 text.
    static func today() -> String {
        Date().formatted(Date.ISO8601FormatStyle().year().month().day())
    }

    /// Now as ISO 8601 text, for a text field the server fills.
    static func text() -> String {
        formatDateTime(now())
    }
}`

export function commonFiles(context: VaporContext): GeneratedFile[] {
  return [
    file(
      'ApiError',
      'The error format of the API: {"error": {"code", "message", "details"}}, with the status of openapi.yaml.',
      ['Vapor'],
      [
        block(API_ERROR),
        '',
        '    static func serverError() -> ApiError {',
        `        ApiError(status: .internalServerError, code: ${swString(GENERAL_ERROR_CODES[1])}, message: "Something went wrong on the server")`,
        '    }',
        '}',
      ],
    ),
    file('ApiErrorMiddleware', 'Every error leaves the API in its error format.', context.fluent ? ['Fluent', 'Vapor'] : ['Vapor'], [
      swDoc('Turns every error into the error format of the API, and tells a wrong method from a missing route.'),
      'struct ApiErrorMiddleware: AsyncMiddleware {',
      '    func respond(to request: Request, chainingTo next: any AsyncResponder) async throws -> Response {',
      '        do {',
      '            return try await next.respond(to: request)',
      '        } catch let error as ApiError {',
      '            return errorResponse(error)',
      context.fluent && [
        '        } catch let error as any DatabaseError where error.isConstraintFailure {',
        '            // A key already used. The cause stays in the log',
        '            request.logger.warning("Integrity error: \\(String(describing: error))")',
        '            return errorResponse(.conflict("The change conflicts with the stored data"))',
      ],
      '        } catch let error as any AbortError where error.status == .notFound {',
      '            if acceptsOtherMethod(request) {',
      `                return errorResponse(ApiError(status: .methodNotAllowed, code: ${swString(GENERAL_ERROR_CODES[0])}, message: "This path does not accept this method"))`,
      '            }',
      '            return errorResponse(ApiError(status: .notFound, code: "not_found", message: "No route matches this request"))',
      '        } catch let error as any AbortError where error.status.code < 500 {',
      '            return errorResponse(ApiError(status: error.status, code: "bad_request", message: error.reason))',
      '        } catch {',
      '            request.logger.error("Unexpected error: \\(String(describing: error))")',
      '            return errorResponse(.serverError())',
      '        }',
      '    }',
      block(MIDDLEWARE_TAIL),
    ]),
    file('JSON', 'JSON values, the JSON coders of the API and JSON answers.', ['Foundation', 'Vapor'], block(JSON)),
    file(
      'Body',
      'Reading request bodies: a JSON object that meets the rules of its type, checked before it is read.',
      ['Foundation', 'Vapor'],
      block(BODY),
    ),
    file('List', 'What a list asks a repository for, and what it gets back.', [], block(LIST)),
    file(
      'Query',
      'Keys in paths and values in query strings are text: they are read with their type, and a malformed one is a 400.',
      ['Foundation', 'Vapor'],
      block(QUERY),
    ),
    file('ServerClock', 'The time the server writes, in UTC.', ['Foundation'], block(CLOCK)),
    settingsFile(context),
  ]
}

/** Settings of the API, read from the environment; the tests build their own. */
function settingsFile(context: VaporContext): GeneratedFile {
  const { auth, database } = context.settings
  const empty = !context.fluent && auth === 'none'
  const fields: Lines[] = [
    context.fluent && [
      '    /// Connection URL of the database (DATABASE_URL)',
      `    var databaseURL = ${swString(DATABASE_URLS[database ?? 'postgresql'])}`,
    ],
    auth === 'apiKey' && ['    /// Accepted API keys (API_KEYS, separated by commas)', '    var apiKeys: [String] = []'],
    auth === 'jwt' && [
      '    /// Secret that signs the tokens (JWT_SECRET); without it every token is rejected',
      '    var jwtSecret = ""',
      '    /// Expected audience and issuer of the tokens, when set',
      '    var jwtAudience = ""',
      '    var jwtIssuer = ""',
    ],
  ]
  const reads: Lines[] = [
    context.fluent && '        if let value = read("DATABASE_URL") { settings.databaseURL = value }',
    auth === 'apiKey' &&
      '        settings.apiKeys = (read("API_KEYS") ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }',
    auth === 'jwt' && [
      '        settings.jwtSecret = read("JWT_SECRET") ?? ""',
      '        settings.jwtAudience = read("JWT_AUDIENCE") ?? ""',
      '        settings.jwtIssuer = read("JWT_ISSUER") ?? ""',
    ],
  ]
  return file('Settings', 'Settings of the API, read from the environment (see .env.example).', empty ? [] : ['Foundation', 'Vapor'], [
    swDoc('Settings of the API. The tests build their own.'),
    empty
      ? ['struct Settings: Sendable {', '    static func fromEnvironment() -> Settings {', '        Settings()', '    }', '}']
      : [
          'struct Settings: Sendable {',
          fields,
          '',
          '    static func fromEnvironment() -> Settings {',
          '        let read = { (name: String) -> String? in Environment.get(name).flatMap { $0.isEmpty ? nil : $0 } }',
          '        var settings = Settings()',
          reads,
          '        return settings',
          '    }',
          '}',
        ],
  ])
}

/** Authentication: what a protected handler asks for. */
export function securityFile(context: VaporContext): GeneratedFile | null {
  const { auth } = context.settings
  if (auth === 'none') return null
  const body: Lines[] =
    auth === 'apiKey'
      ? block(String.raw`
/// Who called a protected endpoint.
struct Authenticated: Sendable {}

/// API key authentication: a protected handler only runs with one of the keys in API_KEYS (header X-API-Key).
/// Without API_KEYS, no request is authenticated.
struct Security: Sendable {
    let settings: Settings

    static func make(_ settings: Settings) async -> Security {
        Security(settings: settings)
    }

    func authenticate(_ request: Request) async throws -> Authenticated {
        let key = request.headers.first(name: "x-api-key") ?? ""
        guard !key.isEmpty, settings.apiKeys.contains(where: { same($0, key) }) else {
            throw ApiError.unauthorized()
        }
        return Authenticated()
    }
}

/// Compares in constant time, so the answer time says nothing about the key.
private func same(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8)
    let y = Array(b.utf8)
    return x.count == y.count && zip(x, y).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0
}`)
      : block(String.raw`
/// What the API reads from a token: an expiry is required, the roles are in the "roles" claim.
struct Claims: JWTPayload {
    var exp: ExpirationClaim
    var roles: [String]?
    var aud: AudienceClaim?
    var iss: IssuerClaim?

    func verify(using algorithm: some JWTAlgorithm) async throws {
        try exp.verifyNotExpired()
    }
}

/// Who called a protected endpoint, with the roles of the token.
struct Authenticated: Sendable {
    let roles: [String]

    /// Rejects the call with 403 unless the token holds one of the roles.
    func requireRoles(_ roles: [String]) throws {
        guard roles.contains(where: self.roles.contains) else {
            throw ApiError.forbidden()
        }
    }
}

/// Bearer token authentication. Tokens are issued by your identity provider; this API only verifies them with
/// JWT_SECRET (HS256, and JWT_AUDIENCE / JWT_ISSUER when set).
struct Security: Sendable {
    let settings: Settings
    let keys: JWTKeyCollection

    static func make(_ settings: Settings) async -> Security {
        let keys = JWTKeyCollection()
        if !settings.jwtSecret.isEmpty {
            await keys.add(hmac: HMACKey(from: settings.jwtSecret), digestAlgorithm: .sha256)
        }
        return Security(settings: settings, keys: keys)
    }

    func authenticate(_ request: Request) async throws -> Authenticated {
        guard let token = request.headers.bearerAuthorization?.token, !settings.jwtSecret.isEmpty,
              let claims = try? await keys.verify(token, as: Claims.self) else {
            throw ApiError.unauthorized()
        }
        if !settings.jwtAudience.isEmpty, !(claims.aud?.value.contains(settings.jwtAudience) ?? false) {
            throw ApiError.unauthorized()
        }
        if !settings.jwtIssuer.isEmpty, claims.iss?.value != settings.jwtIssuer {
            throw ApiError.unauthorized()
        }
        return Authenticated(roles: claims.roles ?? [])
    }
}`)
  return {
    path: 'Sources/App/Security/Security.swift',
    content: fileText(
      lines(...swHeader('Authentication of the protected endpoints.', auth === 'jwt' ? ['JWT', 'Vapor'] : ['Vapor']), ...body),
    ),
  }
}

/** The database: connection, migrations and the sort helper of the repositories. */
export function databaseFile(context: VaporContext): GeneratedFile | null {
  if (!context.fluent) return null
  const database = context.settings.database ?? 'postgresql'
  const mysql = database === 'mysql' || database === 'mariadb'
  const imports = ['Fluent', 'FluentSQL', 'FluentSQLiteDriver', 'Vapor']
  if (database === 'postgresql') imports.push('FluentPostgresDriver')
  if (mysql) imports.push('FluentMySQLDriver')
  const migrations = context.spec.resources.map((resource) => `${names(resource).migration}()`)
  return {
    path: 'Sources/App/Database/DatabaseSetup.swift',
    content: fileText(
      lines(
        ...swHeader('The database of the API: its connection and its tables, one per resource.', imports),
        swDoc('A DATABASE_URL this API cannot use.'),
        'struct DatabaseURLError: Error, CustomStringConvertible {',
        '    let description: String',
        '}',
        '',
        swDoc(
          `Connects to the database of DATABASE_URL (${database === 'sqlite' ? 'sqlite://<file>' : mysql ? 'mysql://… or sqlite://<file>' : 'postgres://… or sqlite://<file>'}) and adds the migrations of\nevery table. The application runs them when it starts, while you develop; use your own for a real database.`,
        ),
        'func useDatabase(_ app: Application, url: String) throws {',
        '    if url.hasPrefix("sqlite://") {',
        '        app.databases.use(.sqlite(.file(String(url.dropFirst("sqlite://".count)))), as: .sqlite)',
        database === 'postgresql' && [
          '    } else if url.hasPrefix("postgres://") || url.hasPrefix("postgresql://") {',
          '        try app.databases.use(.postgres(url: url), as: .psql)',
        ],
        mysql && [
          '    } else if url.hasPrefix("mysql://"), var configuration = MySQLConfiguration(url: url) {',
          '        // TLS without certificate checks, as most servers use their own certificate; set your CA for production',
          '        var tls = TLSConfiguration.makeClientConfiguration()',
          '        tls.certificateVerification = .none',
          '        configuration.tlsConfiguration = tls',
          '        app.databases.use(.mysql(configuration: configuration), as: .mysql)',
        ],
        '    } else {',
        '        throw DatabaseURLError(description: "DATABASE_URL is not a database this API uses: \\(url)")',
        '    }',
        `    app.migrations.add(${migrations.join(', ')})`,
        '}',
        '',
        swDoc('Sorts the rows without a value last, whatever the order.'),
        'func nullsLast(_ column: String) -> DatabaseQuery.Sort {',
        '    .sql(SQLBinaryExpression(left: SQLColumn(column), op: SQLBinaryOperator.is, right: SQLLiteral.null))',
        '}',
      ),
    ),
  }
}

/** configure.swift: wires errors, storage, services and routes. */
export function configureFile(context: VaporContext): GeneratedFile {
  const repositories: string[] = []
  const services: string[] = []
  const controllers: string[] = []
  for (const resource of context.spec.resources) {
    const name = names(resource)
    const implementation = context.pending
      ? `${name.pendingRepository}()`
      : context.fluent
        ? `${name.fluentRepository}(database: app.db)`
        : `${name.memory}()`
    repositories.push(`    let ${name.one}Repository: any ${name.repository} = ${implementation}`)
    const needs = referencedResources(context, resource).map((item) => `${names(item).one}Repository: ${names(item).one}Repository`)
    services.push(`    let ${name.one}Service = ${name.service}(${[`repository: ${name.one}Repository`, ...needs].join(', ')})`)
    controllers.push(
      `    try app.register(collection: ${name.controller}(service: ${name.one}Service${context.security ? ', security: security' : ''}))`,
    )
  }
  const content = lines(
    ...swHeader('Wires the API: errors, storage, services and routes.', context.fluent ? ['Fluent', 'Vapor'] : ['Vapor']),
    swDoc('Builds the API with its settings: the app that the entry point runs and the tests call.'),
    'func configure(_ app: Application, settings: Settings) async throws {',
    '    app.routes.defaultMaxBodySize = "1mb"',
    "    // The error format of the API replaces Vapor's",
    '    app.middleware = Middlewares()',
    '    app.middleware.use(ApiErrorMiddleware())',
    context.fluent && [
      '    // Creates the tables that are missing, while you develop',
      '    try useDatabase(app, url: settings.databaseURL)',
      '    try await app.autoMigrate()',
    ],
    context.security && '    let security = await Security.make(settings)',
    '',
    repositories,
    services,
    controllers,
    '}',
  )
  return { path: 'Sources/App/configure.swift', content: fileText(content) }
}

/** entrypoint.swift: starts the API on PORT with the settings of the environment. */
export function entrypointFile(): GeneratedFile {
  return {
    path: 'Sources/App/entrypoint.swift',
    content: fileText(
      lines(
        ...swHeader('Starts the API on PORT (8080 by default) with the settings of the environment.', ['Vapor']),
        '@main',
        'enum Entrypoint {',
        '    static func main() async throws {',
        '        var environment = try Environment.detect()',
        '        try LoggingSystem.bootstrap(from: &environment)',
        '        let app = try await Application.make(environment)',
        '        app.http.server.configuration.hostname = "0.0.0.0"',
        '        app.http.server.configuration.port = Environment.get("PORT").flatMap(Int.init) ?? 8080',
        '        do {',
        '            try await configure(app, settings: .fromEnvironment())',
        '            try await app.execute()',
        '        } catch {',
        '            app.logger.report(error: error)',
        '            try? await app.asyncShutdown()',
        '            throw error',
        '        }',
        '        try await app.asyncShutdown()',
        '    }',
        '}',
      ),
    ),
  }
}
