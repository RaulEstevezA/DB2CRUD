/**
 * Files of the Ktor project that do not belong to one resource: the entry point and the application module,
 * the error format and its handlers (StatusPages), the reading of request bodies with their rules, the JSON
 * format and its serializers, list queries, the settings read from the environment, authentication and the
 * database connection.
 */
import type { SpecResource } from '../../../api/spec.ts'
import { GENERAL_ERROR_CODES } from '../../../openapi/build.ts'
import { referencedResources } from '../../common/references.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines, type Lines } from '../../common/text.ts'
import { KtImports, ktDoc, ktHeader, ktString } from '../../languages/kotlin/kotlin.ts'
import { commonPackage, names, sourcePath, type KtorContext } from './context.ts'

/** Default JDBC URL of each database, for a database on this computer. */
export const JDBC_URLS: Record<string, string> = {
  postgresql: 'jdbc:postgresql://localhost:5432/api',
  mysql: 'jdbc:mysql://localhost:3306/api',
  mariadb: 'jdbc:mariadb://localhost:3306/api',
  sqlite: 'jdbc:sqlite:app.db',
}

function commonFile(context: KtorContext, name: string, imports: string[], body: Lines[]): GeneratedFile {
  const pkg = commonPackage(context)
  return { path: sourcePath(pkg, name), content: fileText(lines(...ktHeader(pkg, new KtImports(pkg).add(...imports)), ...body)) }
}

export function commonFiles(context: KtorContext): GeneratedFile[] {
  const { auth } = context.settings
  return [
    commonFile(
      context,
      'ApiException',
      ['kotlinx.serialization.Serializable'],
      [
        ktDoc('An error the API answers with a status, a code and a message (see openapi.yaml).'),
        'class ApiException(',
        '    val status: Int,',
        '    val code: String,',
        '    override val message: String,',
        '    val details: List<ErrorDetail> = emptyList(),',
        ') : RuntimeException(message) {',
        '    companion object {',
        '        fun invalid(field: String, message: String) =',
        '            ApiException(400, "validation_error", "The request is not valid", listOf(ErrorDetail(field, message)))',
        '',
        '        fun notFound(what: String) = ApiException(404, "not_found", "No $what has this key")',
        '',
        '        fun conflict(message: String) = ApiException(409, "conflict", message)',
        '    }',
        '}',
        '',
        ktDoc('The body of every error: {"error": {"code", "message", "details"}}.'),
        '@Serializable',
        'data class ErrorResponse(val error: ErrorBody) {',
        '    companion object {',
        '        fun of(code: String, message: String, details: List<ErrorDetail> = emptyList()) =',
        '            ErrorResponse(ErrorBody(code, message, details.ifEmpty { null }))',
        '    }',
        '}',
        '',
        ktDoc('What went wrong; the details only when there are some.'),
        '@Serializable',
        'data class ErrorBody(val code: String, val message: String, val details: List<ErrorDetail>? = null)',
        '',
        ktDoc('Where the request is wrong and why.'),
        '@Serializable',
        'data class ErrorDetail(val field: String, val message: String)',
      ],
    ),
    commonFile(
      context,
      'Errors',
      [
        'io.ktor.http.HttpStatusCode',
        'io.ktor.server.application.Application',
        'io.ktor.server.application.ApplicationCall',
        'io.ktor.server.application.install',
        'io.ktor.server.application.log',
        'io.ktor.server.plugins.BadRequestException',
        'io.ktor.server.plugins.statuspages.StatusPages',
        'io.ktor.server.response.respond',
        ...(context.exposed ? ['org.jetbrains.exposed.v1.exceptions.ExposedSQLException'] : []),
      ],
      [
        ktDoc('Answers with an error body and its status.'),
        'suspend fun ApplicationCall.respondError(status: Int, code: String, message: String, details: List<ErrorDetail> = emptyList()) {',
        '    respond(HttpStatusCode.fromValue(status), ErrorResponse.of(code, message, details))',
        '}',
        '',
        ktDoc('Answers every error with the format of openapi.yaml.'),
        'fun Application.installErrors() {',
        '    install(StatusPages) {',
        '        exception<ApiException> { call, error -> call.respondError(error.status, error.code, error.message, error.details) }',
        '        exception<NotImplementedError> { call, error ->',
        '            call.respondError(501, "not_implemented", error.message ?: "The logic of this operation is not written yet")',
        '        }',
        '        exception<BadRequestException> { call, _ -> call.respondError(400, "validation_error", "The request is not valid") }',
        context.exposed && [
          '        exception<ExposedSQLException> { call, error ->',
          '            // A key already used, or an item other items still refer to. The cause stays in the log',
          '            call.application.log.warn("Integrity error: {}", error.message)',
          '            call.respondError(409, "conflict", "The change conflicts with the stored data")',
          '        }',
        ],
        '        exception<Throwable> { call, error ->',
        '            call.application.log.error("Unexpected error", error)',
        `            call.respondError(500, ${ktString(GENERAL_ERROR_CODES[1])}, "Something went wrong on the server")`,
        '        }',
        '        status(HttpStatusCode.NotFound) { call, _ -> call.respondError(404, "not_found", "No route matches this request") }',
        '        status(HttpStatusCode.MethodNotAllowed) { call, _ ->',
        `            call.respondError(405, ${ktString(GENERAL_ERROR_CODES[0])}, "This path does not accept this method")`,
        '        }',
        auth !== 'none' && [
          '        status(HttpStatusCode.Unauthorized) { call, _ -> call.respondError(401, "unauthorized", "Missing or invalid credentials") }',
        ],
        '    }',
        '}',
      ],
    ),
    commonFile(
      context,
      'Bodies',
      [
        'io.ktor.server.application.ApplicationCall',
        'io.ktor.server.request.receiveText',
        'kotlinx.serialization.KSerializer',
        'kotlinx.serialization.SerializationException',
        'kotlinx.serialization.json.JsonArray',
        'kotlinx.serialization.json.JsonElement',
        'kotlinx.serialization.json.JsonNull',
        'kotlinx.serialization.json.JsonObject',
        'kotlinx.serialization.json.JsonPrimitive',
        'kotlinx.serialization.json.booleanOrNull',
        'java.math.BigDecimal',
      ],
      [
        ktDoc('A request body: its values, and the JSON names it carried (a field sent as null is there, a missing one is not).'),
        'class Body<T>(val value: T, private val sent: Set<String>) {',
        '    fun has(field: String): Boolean = field in sent',
        '}',
        '',
        ktDoc('The kinds of JSON value a field can hold.'),
        'enum class JsonKind { TEXT, WHOLE, NUMBER, BOOLEAN, LIST, OBJECT }',
        '',
        ktDoc('The problems of a request body, by field. Embedded objects add their path: `address.street`.'),
        'class Checks(private val problems: MutableList<ErrorDetail> = mutableListOf(), private val prefix: String = "") {',
        '    val details: List<ErrorDetail> get() = problems',
        '',
        '    fun fail(field: String, message: String) {',
        '        problems += ErrorDetail("$prefix$field", message)',
        '    }',
        '',
        '    fun required(json: JsonObject, field: String) {',
        '        if (field !in json) fail(field, "The field is required")',
        '    }',
        '',
        '    fun notNull(json: JsonObject, field: String) {',
        '        if (json[field] is JsonNull) fail(field, "The field must not be null")',
        '    }',
        '',
        '    /** The value has the kind of the field; null is left to notNull. */',
        '    fun kind(json: JsonObject, field: String, kind: JsonKind) {',
        '        val value = json[field] ?: return',
        '        if (value is JsonNull) return',
        '        val primitive = value as? JsonPrimitive',
        '        val number = primitive?.takeUnless { it.isString }?.content?.toBigDecimalOrNull()',
        '        val valid = when (kind) {',
        '            JsonKind.TEXT -> primitive != null && primitive.isString',
        '            JsonKind.WHOLE -> number != null && number.stripTrailingZeros().scale() <= 0',
        '            JsonKind.NUMBER -> number != null',
        '            JsonKind.BOOLEAN -> primitive != null && !primitive.isString && primitive.booleanOrNull != null',
        '            JsonKind.LIST -> value is JsonArray',
        '            JsonKind.OBJECT -> value is JsonObject',
        '        }',
        '        if (!valid) fail(field, "Must be ${kind.name.lowercase()}")',
        '    }',
        '',
        '    fun length(json: JsonObject, field: String, min: Int?, max: Int?) {',
        '        val text = text(json[field]) ?: return',
        '        if ((min != null && text.length < min) || (max != null && text.length > max)) fail(field, "Has a length out of its limits")',
        '    }',
        '',
        '    fun count(json: JsonObject, field: String, min: Int?, max: Int?) {',
        '        val list = json[field] as? JsonArray ?: return',
        '        if ((min != null && list.size < min) || (max != null && list.size > max)) fail(field, "Has a number of items out of its limits")',
        '    }',
        '',
        '    fun range(json: JsonObject, field: String, min: String?, max: String?, minExclusive: Boolean, maxExclusive: Boolean) {',
        '        val primitive = json[field] as? JsonPrimitive ?: return',
        '        if (primitive.isString) return',
        '        val number = primitive.content.toBigDecimalOrNull() ?: return',
        '        val low = min?.let { number.compareTo(BigDecimal(it)) }',
        '        val high = max?.let { number.compareTo(BigDecimal(it)) }',
        '        val below = low != null && (low < 0 || (minExclusive && low == 0))',
        '        val above = high != null && (high > 0 || (maxExclusive && high == 0))',
        '        if (below || above) fail(field, "Is out of its range")',
        '    }',
        '',
        '    /** The text matches the expression somewhere, as "pattern" reads it in openapi.yaml. */',
        '    fun pattern(json: JsonObject, field: String, regex: Regex) {',
        '        val text = text(json[field]) ?: return',
        '        if (!regex.containsMatchIn(text)) fail(field, "Has the wrong format")',
        '    }',
        '',
        '    fun email(json: JsonObject, field: String) {',
        '        val text = text(json[field]) ?: return',
        '        if (!EMAIL.matches(text)) fail(field, "Must be an email address")',
        '    }',
        '',
        '    /** The rules of an embedded object, with its path before each field. */',
        '    fun nested(json: JsonObject, field: String, rules: (Checks, JsonObject) -> Unit) {',
        '        val inner = json[field] as? JsonObject ?: return',
        '        rules(Checks(problems, "$prefix$field."), inner)',
        '    }',
        '',
        '    /** The rules of each embedded object of a list. */',
        '    fun each(json: JsonObject, field: String, rules: (Checks, JsonObject) -> Unit) {',
        '        val list = json[field] as? JsonArray ?: return',
        '        list.forEachIndexed { index, item ->',
        '            if (item is JsonObject) rules(Checks(problems, "$prefix$field[$index]."), item)',
        '        }',
        '    }',
        '',
        '    private fun text(value: JsonElement?): String? = (value as? JsonPrimitive)?.takeIf { it.isString }?.content',
        '',
        '    private companion object {',
        '        val EMAIL = Regex("^[^@\\\\s]+@[^@\\\\s]+$")',
        '    }',
        '}',
        '',
        ktDoc(
          'Reads a request body: a JSON object that meets its rules (with every problem reported) and has no field the\ncontract does not describe.',
        ),
        'suspend fun <T> ApplicationCall.receiveBody(serializer: KSerializer<T>, rules: (Checks, JsonObject) -> Unit): Body<T> {',
        '    val json = try {',
        '        JsonFormat.parseToJsonElement(receiveText())',
        '    } catch (error: SerializationException) {',
        '        throw ApiException(400, "validation_error", "The body is not valid JSON")',
        '    }',
        '    if (json !is JsonObject) throw ApiException(400, "validation_error", "The body must be a JSON object")',
        '    val checks = Checks()',
        '    rules(checks, json)',
        '    if (checks.details.isNotEmpty()) throw ApiException(400, "validation_error", "The request is not valid", checks.details)',
        '    val value = try {',
        '        JsonFormat.decodeFromJsonElement(serializer, json)',
        '    } catch (error: SerializationException) {',
        '        throw ApiException.invalid("", error.message ?: "The body has a value of the wrong type or an unknown field")',
        '    } catch (error: IllegalArgumentException) {',
        '        throw ApiException.invalid("", error.message ?: "The body has a value of the wrong type")',
        '    }',
        '    return Body(value, json.keys)',
        '}',
      ],
    ),
    commonFile(
      context,
      'JsonFormat',
      [
        'kotlinx.serialization.KSerializer',
        'kotlinx.serialization.Serializable',
        'kotlinx.serialization.SerializationException',
        'kotlinx.serialization.descriptors.PrimitiveKind',
        'kotlinx.serialization.descriptors.PrimitiveSerialDescriptor',
        'kotlinx.serialization.descriptors.SerialDescriptor',
        'kotlinx.serialization.encoding.Decoder',
        'kotlinx.serialization.encoding.Encoder',
        'kotlinx.serialization.json.Json',
        'kotlinx.serialization.json.JsonDecoder',
        'kotlinx.serialization.json.JsonEncoder',
        'kotlinx.serialization.json.JsonPrimitive',
        'kotlinx.serialization.json.longOrNull',
        'java.math.BigDecimal',
        'java.time.Instant',
        'java.time.LocalDate',
        'java.time.OffsetDateTime',
        'java.time.format.DateTimeParseException',
        'java.util.UUID',
      ],
      [
        ktDoc(
          'How the API reads and writes JSON: a field the contract does not describe is an error, and an optional field\nwithout a value is left out of answers (its default is null).',
        ),
        'val JsonFormat = Json {',
        '    ignoreUnknownKeys = false',
        '    encodeDefaults = false',
        '}',
        '',
        ktDoc('A decimal number, written in JSON as a number.'),
        'typealias JsonDecimal = @Serializable(with = DecimalSerializer::class) BigDecimal',
        '',
        ktDoc('A date, written in JSON as "2024-01-15".'),
        'typealias JsonDate = @Serializable(with = DateSerializer::class) LocalDate',
        '',
        ktDoc('A moment, written in JSON in ISO 8601 ("2024-01-15T10:30:00Z").'),
        'typealias JsonDateTime = @Serializable(with = DateTimeSerializer::class) Instant',
        '',
        ktDoc('A UUID, written in JSON as text.'),
        'typealias JsonUuid = @Serializable(with = UuidSerializer::class) UUID',
        '',
        ktDoc('The JSON text of a value, which must be a string.'),
        'private fun Decoder.jsonText(what: String): String {',
        '    val element = (this as JsonDecoder).decodeJsonElement()',
        '    if (element !is JsonPrimitive || !element.isString) throw SerializationException("Must be $what")',
        '    return element.content',
        '}',
        '',
        'object DecimalSerializer : KSerializer<BigDecimal> {',
        '    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("Decimal", PrimitiveKind.DOUBLE)',
        '',
        '    override fun deserialize(decoder: Decoder): BigDecimal {',
        '        val element = (decoder as JsonDecoder).decodeJsonElement()',
        '        if (element !is JsonPrimitive || element.isString) throw SerializationException("Must be a number")',
        '        return element.content.toBigDecimalOrNull() ?: throw SerializationException("Must be a number")',
        '    }',
        '',
        '    // Without trailing zeros and never in scientific notation: 2.50 is 2.5, 100 is 100',
        '    override fun serialize(encoder: Encoder, value: BigDecimal) =',
        '        (encoder as JsonEncoder).encodeJsonElement(JsonPrimitive(BigDecimal(value.stripTrailingZeros().toPlainString())))',
        '}',
        '',
        'object DateSerializer : KSerializer<LocalDate> {',
        '    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("Date", PrimitiveKind.STRING)',
        '',
        '    override fun deserialize(decoder: Decoder): LocalDate = try {',
        '        LocalDate.parse(decoder.jsonText("a date"))',
        '    } catch (error: DateTimeParseException) {',
        '        throw SerializationException("Must be a date (YYYY-MM-DD)")',
        '    }',
        '',
        '    override fun serialize(encoder: Encoder, value: LocalDate) = encoder.encodeString(value.toString())',
        '}',
        '',
        'object DateTimeSerializer : KSerializer<Instant> {',
        '    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("DateTime", PrimitiveKind.STRING)',
        '',
        '    override fun deserialize(decoder: Decoder): Instant = try {',
        '        OffsetDateTime.parse(decoder.jsonText("a date-time")).toInstant()',
        '    } catch (error: DateTimeParseException) {',
        '        throw SerializationException("Must be a date-time in ISO 8601")',
        '    }',
        '',
        '    override fun serialize(encoder: Encoder, value: Instant) = encoder.encodeString(value.toString())',
        '}',
        '',
        'object UuidSerializer : KSerializer<UUID> {',
        '    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("Uuid", PrimitiveKind.STRING)',
        '',
        '    override fun deserialize(decoder: Decoder): UUID = try {',
        '        UUID.fromString(decoder.jsonText("a UUID"))',
        '    } catch (error: IllegalArgumentException) {',
        '        throw SerializationException("Must be a UUID")',
        '    }',
        '',
        '    override fun serialize(encoder: Encoder, value: UUID) = encoder.encodeString(value.toString())',
        '}',
        '',
        ktDoc('Reads and writes an enum as its number in JSON; a number no entry has is an error.'),
        'open class NumberEnumSerializer<T : Enum<T>>(name: String, private val entries: List<T>, private val number: (T) -> Long) : KSerializer<T> {',
        '    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor(name, PrimitiveKind.LONG)',
        '',
        '    override fun deserialize(decoder: Decoder): T {',
        '        val element = (decoder as JsonDecoder).decodeJsonElement()',
        '        val value = (element as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull',
        '        return entries.firstOrNull { number(it) == value }',
        '            ?: throw SerializationException("Must be one of: ${entries.joinToString { number(it).toString() }}")',
        '    }',
        '',
        '    override fun serialize(encoder: Encoder, value: T) = encoder.encodeLong(number(value))',
        '}',
      ],
    ),
    commonFile(
      context,
      'ListQuery',
      ['kotlinx.serialization.Serializable', 'java.math.BigDecimal'],
      [
        ktDoc('What a list asks a repository for: equality filters by JSON field name, an order and a window.'),
        'data class ListQuery(',
        '    val filters: Map<String, Any>,',
        '    val sortField: String?,',
        '    val descending: Boolean,',
        '    val offset: Int,',
        '    val limit: Int?,',
        ') {',
        '    companion object {',
        '        /** "-createdAt" sorts by createdAt in descending order. */',
        '        fun of(filters: Map<String, Any>, sort: String?, offset: Int = 0, limit: Int? = null): ListQuery {',
        '            if (sort.isNullOrEmpty()) return ListQuery(filters, null, false, offset, limit)',
        '            val descending = sort.startsWith("-")',
        '            return ListQuery(filters, if (descending) sort.substring(1) else sort, descending, offset, limit)',
        '        }',
        '    }',
        '}',
        '',
        ktDoc('A window of items and how many match, whatever the window.'),
        'data class ListResult<T>(val items: List<T>, val total: Long)',
        '',
        ktDoc('One page of a list, as the API returns it.'),
        '@Serializable',
        'data class PageResponse<T>(val items: List<T>, val total: Long, val page: Int, val size: Int)',
        '',
        ktDoc('Whether two values are the same for a filter: decimals compare by value (2.5 is 2.50).'),
        'fun sameValue(a: Any?, b: Any?): Boolean = if (a is BigDecimal && b is BigDecimal) a.compareTo(b) == 0 else a == b',
        '',
        ktDoc('Orders two values of a field; both are of the same type.'),
        '@Suppress("UNCHECKED_CAST")',
        'fun compareFieldValues(a: Any?, b: Any?): Int = compareValues(a as Comparable<Any>?, b as Comparable<Any>?)',
      ],
    ),
    commonFile(
      context,
      'Requests',
      ['io.ktor.server.application.ApplicationCall', 'java.time.LocalDate', 'java.time.OffsetDateTime', 'java.util.UUID'],
      [
        ktDoc('Keys in paths and values in query strings are text: they are read with their type, and a malformed one is a 400.'),
        'fun ApplicationCall.longKey(name: String): Long =',
        '    parameters[name]?.toLongOrNull() ?: throw ApiException.invalid(name, "Must be a whole number")',
        '',
        'fun ApplicationCall.uuidKey(name: String): UUID = parameters[name]?.let(::parseUuid) ?: throw ApiException.invalid(name, "Must be a UUID")',
        '',
        'fun ApplicationCall.textKey(name: String): String = parameters[name] ?: throw ApiException.invalid(name, "Is missing")',
        '',
        ktDoc('A whole number of the query string within its limits; the default when it is not there.'),
        'fun ApplicationCall.intQuery(name: String, default: Int, min: Int, max: Int? = null): Int {',
        '    val text = request.queryParameters[name] ?: return default',
        '    val value = text.toIntOrNull()',
        '    if (value == null || value < min || (max != null && value > max)) throw ApiException.invalid(name, "Must be a whole number within its limits")',
        '    return value',
        '}',
        '',
        ktDoc('A filter of the query string read with its type, or null when it is not there; a malformed one is a 400.'),
        'fun <T : Any> ApplicationCall.filter(name: String, parse: (String) -> T?): T? {',
        '    val text = request.queryParameters[name] ?: return null',
        '    return parse(text) ?: throw ApiException.invalid(name, "Has the wrong format")',
        '}',
        '',
        ktDoc('A value of the query string that must be one of the choices.'),
        'fun ApplicationCall.choiceQuery(name: String, choices: List<String>): String? {',
        '    val text = request.queryParameters[name] ?: return null',
        '    if (text !in choices) throw ApiException.invalid(name, "Must be one of: ${choices.joinToString()}")',
        '    return text',
        '}',
        '',
        'private val UUID_TEXT = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")',
        '',
        'fun parseUuid(text: String): UUID? = if (UUID_TEXT.matches(text)) UUID.fromString(text) else null',
        '',
        'fun parseDate(text: String): LocalDate? = runCatching { LocalDate.parse(text) }.getOrNull()',
        '',
        'fun parseDateTime(text: String): java.time.Instant? = runCatching { OffsetDateTime.parse(text).toInstant() }.getOrNull()',
      ],
    ),
    commonFile(
      context,
      'Clock',
      ['java.time.Instant', 'java.time.LocalDate', 'java.time.ZoneOffset', 'java.time.temporal.ChronoUnit'],
      [
        ktDoc('The time the server writes, in UTC.'),
        'object Clock {',
        '    /** Now, to the microsecond: what databases keep, so a later read gives the same value. */',
        '    fun now(): Instant = Instant.now().truncatedTo(ChronoUnit.MICROS)',
        '',
        '    fun today(): LocalDate = LocalDate.now(ZoneOffset.UTC)',
        '',
        '    /** Now as ISO 8601 text, for a text field the server fills. */',
        '    fun text(): String = Instant.now().truncatedTo(ChronoUnit.MILLIS).toString()',
        '}',
      ],
    ),
    settingsFile(context),
  ]
}

/** Settings of the API, read from the environment; the tests build their own. */
function settingsFile(context: KtorContext): GeneratedFile {
  const { auth, database } = context.settings
  const fields = [
    context.exposed && [
      `    val databaseUrl: String = ${ktString(JDBC_URLS[database ?? 'postgresql'])},`,
      database !== 'sqlite' && ['    val databaseUser: String = "api",', '    val databasePassword: String = "",'],
    ],
    auth === 'apiKey' && '    val apiKeys: List<String> = emptyList(),',
    auth === 'jwt' && ['    val jwtSecret: String = "",', '    val jwtAudience: String = "",', '    val jwtIssuer: String = "",'],
  ]
  const reads = [
    context.exposed && [
      `                databaseUrl = env["DATABASE_URL"] ?: ${ktString(JDBC_URLS[database ?? 'postgresql'])},`,
      database !== 'sqlite' && [
        '                databaseUser = env["DATABASE_USER"] ?: "api",',
        '                databasePassword = env["DATABASE_PASSWORD"] ?: "",',
      ],
    ],
    auth === 'apiKey' && '                apiKeys = (env["API_KEYS"] ?: "").split(",").map { it.trim() }.filter { it.isNotEmpty() },',
    auth === 'jwt' && [
      '                jwtSecret = env["JWT_SECRET"] ?: "",',
      '                jwtAudience = env["JWT_AUDIENCE"] ?: "",',
      '                jwtIssuer = env["JWT_ISSUER"] ?: "",',
    ],
  ]
  const empty = !context.exposed && auth === 'none'
  return commonFile(
    context,
    'Settings',
    [],
    [
      ktDoc('Settings of the API, read from the environment (see .env.example). The tests build their own.'),
      empty ? 'class Settings {' : ['data class Settings(', fields, ') {'],
      '    companion object {',
      empty
        ? '        fun fromEnvironment() = Settings()'
        : [
            '        fun fromEnvironment(): Settings {',
            '            val env = System.getenv()',
            '            return Settings(',
            reads,
            '            )',
            '        }',
          ],
      '    }',
      '}',
    ],
  )
}

/** Authentication: API key or JWT, and the check of roles. */
export function securityFiles(context: KtorContext): GeneratedFile[] {
  const { auth } = context.settings
  if (auth === 'none') return []
  const pkg = `${context.base}.security`
  const common = commonPackage(context)
  const imports = new KtImports(pkg).add(
    'io.ktor.server.application.Application',
    'io.ktor.server.application.install',
    'io.ktor.server.auth.Authentication',
    `${common}.Settings`,
    `${common}.respondError`,
  )
  if (auth === 'apiKey')
    imports.add(
      'io.ktor.server.auth.AuthenticationContext',
      'io.ktor.server.auth.AuthenticationFailedCause',
      'io.ktor.server.auth.AuthenticationProvider',
      'io.ktor.server.auth.UserIdPrincipal',
      'java.security.MessageDigest',
    )
  else
    imports.add(
      'com.auth0.jwt.JWT',
      'com.auth0.jwt.algorithms.Algorithm',
      'io.ktor.server.application.ApplicationCall',
      'io.ktor.server.auth.jwt.JWTPrincipal',
      'io.ktor.server.auth.jwt.jwt',
      'io.ktor.server.auth.principal',
      `${common}.ApiException`,
      'java.security.SecureRandom',
    )
  const content = lines(
    ...ktHeader(pkg, imports),
    ktDoc('Name of the authentication every protected route uses.'),
    'const val AUTH = "api"',
    '',
    auth === 'apiKey'
      ? [
          ktDoc(
            'API key authentication: a request with one of the keys in API_KEYS (header X-API-Key) is authenticated.\nWithout API_KEYS, no request is.',
          ),
          'fun Application.installSecurity(settings: Settings) {',
          '    install(Authentication) {',
          '        register(ApiKeyProvider(settings.apiKeys))',
          '    }',
          '}',
          '',
          'private class ApiKeyProvider(private val keys: List<String>) : AuthenticationProvider(Config(AUTH)) {',
          '    class Config(name: String) : AuthenticationProvider.Config(name)',
          '',
          '    override suspend fun onAuthenticate(context: AuthenticationContext) {',
          '        val key = context.call.request.headers["X-API-Key"]',
          '        if (key != null && keys.any { same(it, key) }) {',
          '            context.principal(UserIdPrincipal("api-key"))',
          '            return',
          '        }',
          '        context.challenge(AUTH, AuthenticationFailedCause.InvalidCredentials) { challenge, call ->',
          '            call.respondError(401, "unauthorized", "Missing or invalid credentials")',
          '            challenge.complete()',
          '        }',
          '    }',
          '',
          '    /** Compares in constant time, so the answer time says nothing about the key. */',
          '    private fun same(a: String, b: String) = MessageDigest.isEqual(a.toByteArray(), b.toByteArray())',
          '}',
        ]
      : [
          ktDoc(
            'Bearer token authentication. Tokens are issued by your identity provider; this API only verifies them with\nJWT_SECRET (HS256, and JWT_AUDIENCE / JWT_ISSUER when set), requires an expiry and reads the roles from the\n"roles" claim.',
          ),
          'fun Application.installSecurity(settings: Settings) {',
          '    // Without JWT_SECRET no token is valid: the key is random and nobody knows it',
          '    val secret = settings.jwtSecret.ifEmpty { SecureRandom().nextLong().toString() + SecureRandom().nextLong() }',
          '    val verifier = JWT.require(Algorithm.HMAC256(secret)).apply {',
          '        if (settings.jwtAudience.isNotEmpty()) withAudience(settings.jwtAudience)',
          '        if (settings.jwtIssuer.isNotEmpty()) withIssuer(settings.jwtIssuer)',
          '    }.build()',
          '    install(Authentication) {',
          '        jwt(AUTH) {',
          '            verifier(verifier)',
          '            validate { credential -> if (credential.payload.expiresAt != null) JWTPrincipal(credential.payload) else null }',
          '            challenge { _, _ -> call.respondError(401, "unauthorized", "Missing or invalid credentials") }',
          '        }',
          '    }',
          '}',
          '',
          ktDoc('Rejects the call with 403 unless its token holds one of the roles.'),
          'fun ApplicationCall.requireRoles(vararg roles: String) {',
          '    val granted = principal<JWTPrincipal>()?.payload?.getClaim("roles")?.asList(String::class.java).orEmpty()',
          '    if (roles.none { it in granted }) throw ApiException(403, "forbidden", "The credentials do not allow this operation")',
          '}',
        ],
  )
  return [{ path: sourcePath(pkg, 'Security'), content: fileText(content) }]
}

/** The database: its connection pool and the tables of every resource. */
export function databaseFiles(context: KtorContext): GeneratedFile[] {
  if (!context.exposed) return []
  const pkg = `${context.base}.database`
  const imports = new KtImports(pkg).add(
    'com.zaxxer.hikari.HikariConfig',
    'com.zaxxer.hikari.HikariDataSource',
    'org.jetbrains.exposed.v1.core.Table',
    'org.jetbrains.exposed.v1.jdbc.Database',
    'org.jetbrains.exposed.v1.jdbc.SchemaUtils',
    'org.jetbrains.exposed.v1.jdbc.transactions.transaction',
    `${commonPackage(context)}.Settings`,
  )
  const sqlite = context.settings.database === 'sqlite'
  if (sqlite) imports.add('org.jetbrains.exposed.v1.core.DatabaseConfig', 'java.sql.Connection')
  for (const resource of context.spec.resources) imports.add(`${context.layout.resource(resource, 'repository')}.${names(resource).table}`)
  const content = lines(
    ...ktHeader(pkg, imports),
    ktDoc('The tables of the API, one per resource.'),
    `val TABLES: Array<Table> = arrayOf(${context.spec.resources.map((resource) => names(resource).table).join(', ')})`,
    '',
    ktDoc('A database and the pool of connections it uses.'),
    'class ApiDatabase(val database: Database, private val pool: HikariDataSource) : AutoCloseable {',
    '    override fun close() = pool.close()',
    '}',
    '',
    ktDoc(
      'Connects to the database of DATABASE_URL and creates the tables it does not have, while you develop; use\nmigrations for a real database (Model2DB writes them).',
    ),
    'fun connectDatabase(settings: Settings): ApiDatabase {',
    '    val pool = HikariDataSource(HikariConfig().apply {',
    '        jdbcUrl = settings.databaseUrl',
    !sqlite && ['        username = settings.databaseUser', '        password = settings.databasePassword'],
    sqlite && '        // SQLite allows one writer at a time',
    sqlite && '        maximumPoolSize = 1',
    '    })',
    sqlite
      ? [
          '    // SQLite only supports serializable transactions',
          '    val database = Database.connect(pool, databaseConfig = DatabaseConfig { defaultIsolationLevel = Connection.TRANSACTION_SERIALIZABLE })',
        ]
      : '    val database = Database.connect(pool)',
    '    transaction(database) { SchemaUtils.create(*TABLES) }',
    '    return ApiDatabase(database, pool)',
    '}',
  )
  return [{ path: sourcePath(pkg, 'Database'), content: fileText(content) }]
}

/** Application.kt: the entry point and the module that wires JSON, errors, authentication, storage and routes. */
export function applicationFile(context: KtorContext): GeneratedFile {
  const pkg = context.base
  const common = commonPackage(context)
  const imports = new KtImports(pkg).add(
    'io.ktor.serialization.kotlinx.json.json',
    'io.ktor.server.application.Application',
    'io.ktor.server.application.install',
    'io.ktor.server.engine.embeddedServer',
    'io.ktor.server.netty.Netty',
    'io.ktor.server.plugins.contentnegotiation.ContentNegotiation',
    'io.ktor.server.routing.routing',
    `${common}.JsonFormat`,
    `${common}.Settings`,
    `${common}.installErrors`,
  )
  if (context.security) imports.add(`${context.base}.security.installSecurity`)
  if (context.exposed) imports.add('io.ktor.server.application.ApplicationStopped', `${context.base}.database.connectDatabase`)
  const wiring: string[] = []
  const routes: string[] = []
  for (const resource of context.spec.resources) {
    const name = names(resource)
    const repositoryPkg = context.layout.resource(resource, 'repository')
    const implementation = context.pending ? name.pendingRepository : context.exposed ? name.exposedRepository : name.memory
    imports.add(
      `${repositoryPkg}.${implementation}`,
      `${context.layout.resource(resource, 'service')}.${name.service}`,
      `${context.layout.resource(resource, 'routes')}.${name.routesFunction}`,
    )
    wiring.push(`    val ${name.one}Repository = ${implementation}(${context.exposed ? 'database.database' : ''})`)
    routes.push(`        ${name.routesFunction}(${name.one}Service)`)
  }
  const services = context.spec.resources.map((resource) => {
    const name = names(resource)
    const needs = referencedNames(context, resource)
    return `    val ${name.one}Service = ${name.service}(${[`${name.one}Repository`, ...needs.map((item) => `${item}Repository`)].join(', ')})`
  })
  const content = lines(
    ...ktHeader(pkg, imports),
    ktDoc('Starts the API on PORT (8080 by default) with the settings of the environment.'),
    'fun main() {',
    '    val port = System.getenv("PORT")?.toIntOrNull() ?: 8080',
    '    embeddedServer(Netty, port = port) { module(Settings.fromEnvironment()) }.start(wait = true)',
    '}',
    '',
    ktDoc('The API: JSON, errors, authentication, storage and routes.'),
    'fun Application.module(settings: Settings) {',
    '    install(ContentNegotiation) { json(JsonFormat) }',
    '    installErrors()',
    context.security && '    installSecurity(settings)',
    '',
    context.pending
      ? '    // Storage to write: every repository answers 501 until it is implemented'
      : context.exposed
        ? '    // Each repository keeps its items in the database with Exposed'
        : '    // Data kept in memory while the application runs; restarting it (or each test) starts empty',
    context.exposed && ['    val database = connectDatabase(settings)', '    monitor.subscribe(ApplicationStopped) { database.close() }'],
    wiring,
    services,
    '',
    '    routing {',
    routes,
    '    }',
    '}',
  )
  return { path: sourcePath(pkg, 'Application'), content: fileText(content) }
}

/** The variable names of the resources a resource refers to, for its service. */
export function referencedNames(context: KtorContext, resource: SpecResource): string[] {
  return referencedResources(context, resource).map((item) => names(item).one)
}
