"""Files of the ASP.NET Core project that do not belong to one resource: the entry point (Program.cs), the error
format and the middleware that answers with it, list queries and pages, the base of request bodies, the JSON helpers
(strict enums, copies), authentication (API key or JWT) and the database context. Mirrors
web/src/core/generators/frameworks/aspnetCore/common.ts.
"""

from ....js import number_text
from ....openapi.build import GENERAL_ERROR_CODES
from ...common.text import file_text, lines
from ...languages.csharp.csharp import CsUsings, cs_doc, cs_header, cs_string
from .context import (
    AspNetContext,
    common_namespace,
    data_namespace,
    key_field,
    names,
    namespace_of,
    property_name,
)
from .model import stored_as_json


def _common_file(context: AspNetContext, name: str, usings: list[str], body: list) -> dict:
    namespace = common_namespace(context)
    content = lines(*cs_header(namespace, CsUsings(namespace).add(*usings)), *body)
    return {"path": f"src/{context.root}/Common/{name}.cs", "content": file_text(content)}


def common_files(context: AspNetContext) -> list[dict]:
    return [
        _common_file(
            context,
            "ApiException",
            [],
            [
                cs_doc("An error the API answers with a status, a code and a message (see openapi.yaml)."),
                "public sealed class ApiException(int status, string code, string message, IReadOnlyList<ErrorDetail>? details = null)",
                "    : Exception(message)",
                "{",
                "    public int Status { get; } = status;",
                "",
                "    public string Code { get; } = code;",
                "",
                "    public IReadOnlyList<ErrorDetail> Details { get; } = details ?? [];",
                "",
                "    public static ApiException Invalid(string field, string message) =>",
                '        new(400, "validation_error", "The request is not valid", [new ErrorDetail(field, message)]);',
                "",
                '    public static ApiException NotFound(string what) => new(404, "not_found", $"No {what} has this key");',
                "",
                '    public static ApiException Conflict(string message) => new(409, "conflict", message);',
                "}",
            ],
        ),
        _common_file(
            context,
            "ErrorResponse",
            ["System.Text.Json.Serialization"],
            [
                cs_doc('The body of every error: {"error": {"code", "message", "details"}}.'),
                "public sealed record ErrorResponse(ErrorBody Error)",
                "{",
                "    public static ErrorResponse Of(string code, string message, IReadOnlyList<ErrorDetail>? details = null) =>",
                "        new(new ErrorBody(code, message, details is { Count: > 0 } ? details : null));",
                "}",
                "",
                cs_doc("What went wrong; the details only when there are some."),
                "public sealed record ErrorBody(",
                "    string Code,",
                "    string Message,",
                "    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<ErrorDetail>? Details);",
                "",
                cs_doc("Where the request is wrong and why."),
                "public sealed record ErrorDetail(string Field, string Message);",
            ],
        ),
        _common_file(
            context,
            "ApiErrors",
            ["Microsoft.AspNetCore.Diagnostics", "Microsoft.AspNetCore.Mvc", "Microsoft.AspNetCore.Mvc.ModelBinding"],
            [
                cs_doc("Answers with the error format of openapi.yaml where ASP.NET Core would answer with its own."),
                "public static class ApiErrors",
                "{",
                "    /// <summary>Writes an error body with its status.</summary>",
                "    public static Task Write(HttpContext context, int status, string code, string message, IReadOnlyList<ErrorDetail>? details = null)",
                "    {",
                "        context.Response.StatusCode = status;",
                "        return context.Response.WriteAsJsonAsync(ErrorResponse.Of(code, message, details));",
                "    }",
                "",
                "    /// <summary>The answer to a body or a parameter that breaks its rules: 400 with each problem.</summary>",
                "    public static IActionResult InvalidModelState(ActionContext context)",
                "    {",
                "        var details = context.ModelState",
                "            .Where(entry => entry.Value is { Errors.Count: > 0 })",
                "            .SelectMany(entry => entry.Value!.Errors.Select(error => new ErrorDetail(FieldOf(entry.Key), MessageOf(error))))",
                "            .ToList();",
                '        return new ObjectResult(ErrorResponse.Of("validation_error", "The request is not valid", details)) { StatusCode = 400 };',
                "    }",
                "",
                "    /// <summary>Answers the requests no route takes, which ASP.NET Core leaves without a body.</summary>",
                "    public static Task StatusCodePage(StatusCodeContext context) => context.HttpContext.Response.StatusCode switch",
                "    {",
                '        404 => Write(context.HttpContext, 404, "not_found", "No route matches this request"),',
                f'        405 => Write(context.HttpContext, 405, {cs_string(GENERAL_ERROR_CODES[0])}, "This path does not accept this method"),',
                '        415 => Write(context.HttpContext, 400, "validation_error", "The body must be JSON (Content-Type: application/json)"),',
                "        _ => Task.CompletedTask,",
                "    };",
                "",
                '    // "$.lines[0].quantity" (a value JSON cannot read) and "lines[0].quantity" (a broken rule) are the same field',
                '    private static string FieldOf(string key) => key.StartsWith("$.") ? key[2..] : key == "$" ? "" : key;',
                "",
                "    private static string MessageOf(ModelError error) =>",
                '        string.IsNullOrEmpty(error.ErrorMessage) ? "Has a value of the wrong type" : error.ErrorMessage;',
                "}",
            ],
        ),
        _common_file(
            context,
            "ApiErrorMiddleware",
            ["Microsoft.EntityFrameworkCore"] if context.ef_core else [],
            [
                cs_doc("Turns the exceptions of a request into the error format of openapi.yaml."),
                "public sealed class ApiErrorMiddleware(RequestDelegate next, ILogger<ApiErrorMiddleware> logger)",
                "{",
                "    public async Task InvokeAsync(HttpContext context)",
                "    {",
                "        try",
                "        {",
                "            await next(context);",
                "        }",
                "        catch (ApiException error) when (!context.Response.HasStarted)",
                "        {",
                "            await ApiErrors.Write(context, error.Status, error.Code, error.Message, error.Details);",
                "        }",
                "        catch (NotImplementedException error) when (!context.Response.HasStarted)",
                "        {",
                '            await ApiErrors.Write(context, 501, "not_implemented", error.Message);',
                "        }",
                context.ef_core
                and [
                    "        catch (DbUpdateException error) when (!context.Response.HasStarted)",
                    "        {",
                    "            // A key already used, or an item other items still refer to. The cause stays in the log",
                    '            logger.LogWarning(error, "Integrity error");',
                    '            await ApiErrors.Write(context, 409, "conflict", "The change conflicts with the stored data");',
                    "        }",
                ],
                "        catch (Exception error) when (!context.Response.HasStarted)",
                "        {",
                '            logger.LogError(error, "Unexpected error");',
                f'            await ApiErrors.Write(context, 500, {cs_string(GENERAL_ERROR_CODES[1])}, "Something went wrong on the server");',
                "        }",
                "    }",
                "}",
            ],
        ),
        _common_file(
            context,
            "ListQuery",
            [],
            [
                cs_doc(
                    "What a list asks a repository for: equality filters by JSON field name, an order and a window."
                ),
                "public sealed record ListQuery(IReadOnlyDictionary<string, object> Filters, string? SortField, bool Descending, int Offset, int? Limit)",
                "{",
                '    /// <summary>"-createdAt" sorts by createdAt in descending order.</summary>',
                "    public static ListQuery Of(IReadOnlyDictionary<string, object> filters, string? sort, int offset = 0, int? limit = null)",
                "    {",
                "        if (string.IsNullOrEmpty(sort))",
                "        {",
                "            return new(filters, null, false, offset, limit);",
                "        }",
                "        var descending = sort.StartsWith('-');",
                "        return new(filters, descending ? sort[1..] : sort, descending, offset, limit);",
                "    }",
                "}",
                "",
                cs_doc("A window of items and how many match, whatever the window."),
                "public sealed record ListResult<T>(IReadOnlyList<T> Items, long Total);",
                "",
                cs_doc("One page of a list, as the API returns it."),
                "public sealed record PageResponse<T>(IReadOnlyList<T> Items, long Total, int Page, int Size);",
            ],
        ),
        _common_file(
            context,
            "Payload",
            ["System.ComponentModel.DataAnnotations"],
            [
                cs_doc(
                    "Base of request bodies and embedded objects. System.Text.Json calls a setter only for the properties present in\nthe JSON, so the setters record them: a property sent as null is present, a missing one is not.",
                ),
                "public abstract class Payload : IValidatableObject",
                "{",
                "    private readonly HashSet<string> present = [];",
                "",
                "    /// <summary>Records that the property with this JSON name was sent.</summary>",
                "    protected void Mark(string field) => present.Add(field);",
                "",
                "    /// <summary>Whether the property with this JSON name was sent, even as null.</summary>",
                "    public bool Has(string field) => present.Contains(field);",
                "",
                "    /// <summary>JSON names of the properties the body must carry.</summary>",
                "    protected virtual string[] RequiredFields => [];",
                "",
                "    /// <summary>The properties that cannot be null when they are sent, with their values.</summary>",
                "    protected virtual IEnumerable<(string Field, object? Value)> NonNullValues() => [];",
                "",
                "    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)",
                "    {",
                "        foreach (var field in RequiredFields.Where(field => !Has(field)))",
                "        {",
                '            yield return new ValidationResult("The field is required", [field]);',
                "        }",
                "        foreach (var (field, value) in NonNullValues().Where(item => Has(item.Field) && item.Value is null))",
                "        {",
                '            yield return new ValidationResult("The field must not be null", [field]);',
                "        }",
                "    }",
                "}",
            ],
        ),
        _common_file(
            context,
            "PatternAttribute",
            ["System.ComponentModel.DataAnnotations", "System.Text.RegularExpressions"],
            [
                cs_doc(
                    'A text that matches a regular expression anywhere in it, as "pattern" reads it in openapi.yaml (the\nRegularExpression attribute of .NET only accepts whole matches).',
                ),
                "[AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter)]",
                'public sealed class PatternAttribute(string pattern) : ValidationAttribute("Has the wrong format")',
                "{",
                "    private readonly Regex regex = new(pattern, RegexOptions.None, TimeSpan.FromSeconds(1));",
                "",
                "    public override bool IsValid(object? value) => value is null || (value is string text && regex.IsMatch(text));",
                "}",
            ],
        ),
        _common_file(
            context,
            "EnumConverters",
            ["System.Reflection", "System.Text.Json", "System.Text.Json.Serialization"],
            [
                cs_doc(
                    "Reads and writes an enum as the text each member has in JSON ([JsonStringEnumMemberName]). Any other text, a\nnumber or a different case is an error.",
                ),
                "public sealed class TextEnumConverter<T> : JsonConverter<T> where T : struct, Enum",
                "{",
                "    private static readonly Dictionary<string, T> ByText = typeof(T)",
                "        .GetFields(BindingFlags.Public | BindingFlags.Static)",
                "        .ToDictionary(member => member.GetCustomAttribute<JsonStringEnumMemberNameAttribute>()?.Name ?? member.Name, member => (T)member.GetValue(null)!);",
                "",
                "    private static readonly Dictionary<T, string> ByValue = ByText.ToDictionary(pair => pair.Value, pair => pair.Key);",
                "",
                "    /// <summary>The member with this text, or null when no member has it.</summary>",
                "    public static T? Parse(string text) => ByText.TryGetValue(text, out var value) ? value : null;",
                "",
                "    public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)",
                "    {",
                "        if (reader.TokenType == JsonTokenType.String && ByText.TryGetValue(reader.GetString()!, out var value))",
                "        {",
                "            return value;",
                "        }",
                '        throw new JsonException($"Must be one of: {string.Join(", ", ByText.Keys)}");',
                "    }",
                "",
                "    public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options) =>",
                "        writer.WriteStringValue(ByValue[value]);",
                "}",
                "",
                cs_doc("Reads and writes an enum as its number in JSON; a number no member has is an error."),
                "public sealed class NumberEnumConverter<T> : JsonConverter<T> where T : struct, Enum",
                "{",
                "    private static readonly Dictionary<long, T> ByNumber = Enum.GetValues<T>().ToDictionary(value => Convert.ToInt64(value), value => value);",
                "",
                "    /// <summary>The member with this number, or null when no member has it.</summary>",
                "    public static T? Parse(long number) => ByNumber.TryGetValue(number, out var value) ? value : null;",
                "",
                "    public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)",
                "    {",
                "        if (reader.TokenType == JsonTokenType.Number && reader.TryGetInt64(out var number) && ByNumber.TryGetValue(number, out var value))",
                "        {",
                "            return value;",
                "        }",
                '        throw new JsonException($"Must be one of: {string.Join(", ", ByNumber.Keys)}");',
                "    }",
                "",
                "    public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options) =>",
                "        writer.WriteNumberValue(Convert.ToInt64(value));",
                "}",
            ],
        ),
        _common_file(
            context,
            "JsonValues",
            ["System.Text.Json"],
            [
                cs_doc("JSON helpers of the service and the storage."),
                "public static class JsonValues",
                "{",
                "    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);",
                "",
                "    /// <summary>A value written in JSON, such as the default of a list.</summary>",
                "    public static T Parse<T>(string json) => JsonSerializer.Deserialize<T>(json, Options)!;",
                "",
                "    /// <summary>A copy of a value made through JSON, so a stored item never shares objects with the caller.</summary>",
                "    public static T Copy<T>(T value) => JsonSerializer.Deserialize<T>(JsonSerializer.SerializeToUtf8Bytes(value, Options), Options)!;",
                "}",
            ],
        ),
        _common_file(
            context,
            "Clock",
            [],
            [
                cs_doc("The time the server writes, in UTC."),
                "public static class Clock",
                "{",
                "    /// <summary>Now, to the microsecond: what databases keep, so a later read gives the same value.</summary>",
                "    public static DateTimeOffset Now()",
                "    {",
                "        var now = DateTimeOffset.UtcNow;",
                "        return now.AddTicks(-(now.Ticks % 10));",
                "    }",
                "",
                "    /// <summary>Today, in UTC.</summary>",
                "    public static DateOnly Today() => DateOnly.FromDateTime(DateTime.UtcNow);",
                "",
                "    /// <summary>Now as ISO 8601 text, for a text field the server fills.</summary>",
                "    public static string Text() => Now().UtcDateTime.ToString(\"yyyy-MM-dd'T'HH:mm:ss.fff'Z'\", System.Globalization.CultureInfo.InvariantCulture);",
                "}",
            ],
        ),
    ]


def security_files(context: AspNetContext) -> list[dict]:
    """Authentication: an API key handler, or the JWT bearer setup."""
    namespace = namespace_of(context, "Security")
    auth = context.settings["auth"]
    if auth == "apiKey":
        usings = CsUsings(namespace).add(
            "System.Security.Claims",
            "System.Security.Cryptography",
            "System.Text",
            "System.Text.Encodings.Web",
            "Microsoft.AspNetCore.Authentication",
            "Microsoft.Extensions.Options",
            common_namespace(context),
        )
        content = lines(
            *cs_header(namespace, usings),
            cs_doc(
                "API key authentication: a request with one of the keys in API_KEYS (header X-API-Key) is authenticated.\nWithout API_KEYS, no request is.",
            ),
            "public sealed class ApiKeyAuthenticationHandler(",
            "    IOptionsMonitor<AuthenticationSchemeOptions> options,",
            "    ILoggerFactory logger,",
            "    UrlEncoder encoder,",
            "    IConfiguration configuration) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)",
            "{",
            '    public const string SchemeName = "ApiKey";',
            "",
            "    protected override Task<AuthenticateResult> HandleAuthenticateAsync()",
            "    {",
            '        var key = Request.Headers["X-API-Key"].ToString();',
            '        var keys = (configuration["API_KEYS"] ?? "").Split(\',\', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);',
            "        if (key.Length == 0 || !keys.Any(valid => Same(valid, key)))",
            "        {",
            "            return Task.FromResult(AuthenticateResult.NoResult());",
            "        }",
            '        var identity = new ClaimsIdentity([new Claim(ClaimTypes.Name, "api-key")], SchemeName);',
            "        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName)));",
            "    }",
            "",
            "    protected override Task HandleChallengeAsync(AuthenticationProperties properties) =>",
            '        ApiErrors.Write(Context, 401, "unauthorized", "Missing or invalid credentials");',
            "",
            "    protected override Task HandleForbiddenAsync(AuthenticationProperties properties) =>",
            '        ApiErrors.Write(Context, 403, "forbidden", "The credentials do not allow this operation");',
            "",
            "    /// <summary>Compares in constant time, so the answer time says nothing about the key.</summary>",
            "    private static bool Same(string a, string b) =>",
            "        CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(a), Encoding.UTF8.GetBytes(b));",
            "}",
        )
        return [{"path": f"src/{context.root}/Security/ApiKeyAuthenticationHandler.cs", "content": file_text(content)}]
    if auth == "jwt":
        usings = CsUsings(namespace).add(
            "System.Security.Cryptography",
            "System.Text",
            "Microsoft.AspNetCore.Authentication.JwtBearer",
            "Microsoft.IdentityModel.Tokens",
            common_namespace(context),
        )
        content = lines(
            *cs_header(namespace, usings),
            cs_doc(
                'Bearer token authentication. Tokens are issued by your identity provider; this API only verifies them with\nJWT_SECRET (HS256, and JWT_AUDIENCE / JWT_ISSUER when set), requires an expiry and reads the roles from the\n"roles" claim. Each endpoint says who may call it with [Authorize].',
            ),
            "public static class TokenAuthentication",
            "{",
            "    public static IServiceCollection AddTokenAuthentication(this IServiceCollection services)",
            "    {",
            "        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer();",
            "        // Read when the first request arrives, so the settings of the environment and of the tests apply",
            "        services.AddOptions<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme).Configure<IConfiguration>((options, configuration) =>",
            "        {",
            '            var secret = configuration["JWT_SECRET"] ?? "";',
            '            var audience = configuration["JWT_AUDIENCE"] ?? "";',
            '            var issuer = configuration["JWT_ISSUER"] ?? "";',
            "            options.MapInboundClaims = false;",
            "            options.TokenValidationParameters = new TokenValidationParameters",
            "            {",
            "                // Without JWT_SECRET no token is valid: the key is random and nobody knows it",
            "                IssuerSigningKey = new SymmetricSecurityKey(secret.Length > 0 ? Encoding.UTF8.GetBytes(secret) : RandomNumberGenerator.GetBytes(64)),",
            "                ValidAlgorithms = [SecurityAlgorithms.HmacSha256],",
            "                ValidateIssuer = issuer.Length > 0,",
            "                ValidIssuer = issuer,",
            "                ValidateAudience = audience.Length > 0,",
            "                ValidAudience = audience,",
            "                RequireExpirationTime = true,",
            "                ValidateLifetime = true,",
            '                RoleClaimType = "roles",',
            "            };",
            "            options.Events = new JwtBearerEvents",
            "            {",
            "                OnChallenge = context =>",
            "                {",
            "                    context.HandleResponse();",
            '                    return ApiErrors.Write(context.HttpContext, 401, "unauthorized", "Missing or invalid credentials");',
            "                },",
            '                OnForbidden = context => ApiErrors.Write(context.HttpContext, 403, "forbidden", "The credentials do not allow this operation"),',
            "            };",
            "        });",
            "        return services.AddAuthorization();",
            "    }",
            "}",
        )
        return [{"path": f"src/{context.root}/Security/TokenAuthentication.cs", "content": file_text(content)}]
    return []


def queryable_fields(resource: dict) -> list[dict]:
    """The fields a list can filter and sort by in the database: plain values, enums and single references."""
    return [
        field
        for field in resource["fields"]
        if not stored_as_json(field)
        and not (field["type"]["kind"] == "scalar" and field["type"]["scalar"] == "binary")
        and field["type"]["kind"] in ("scalar", "enum")
    ]


def _text_key_length(resource: dict) -> str:
    length = key_field(resource)["constraints"].get("maxLength")
    return number_text(length if length is not None else 191)


def _entity_configuration(context: AspNetContext, resource: dict) -> list[str]:
    """How EF Core maps each property of a resource: keys, lengths, precision, enums as text, JSON columns."""
    name = names(resource)
    key = property_name(key_field(resource), name["type"])
    statements = [f"entity.ToTable({cs_string(name['table'])});", f"entity.HasKey(item => item.{key});"]
    generated = resource["key"]["generated"]
    key_is_text = resource["key"]["type"]["scalar"] not in ("integer", "uuid")
    on_add = generated == "increment" or (generated == "uuid" and not key_is_text)
    length = f".HasMaxLength({_text_key_length(resource)})" if key_is_text else ""
    statements.append(
        f"entity.Property(item => item.{key}){'.ValueGeneratedOnAdd()' if on_add else '.ValueGeneratedNever()'}{length};"
    )
    for field in resource["fields"]:
        if field["name"] == resource["key"]["field"]:
            continue
        prop = f"entity.Property(item => item.{property_name(field, name['type'])})"
        type_ref = field["type"]
        if stored_as_json(field):
            statements.append(f"{prop}.HasJsonConversion();")
        elif field.get("reference"):
            target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
            if target["key"]["type"]["scalar"] == "string":
                statements.append(f"{prop}.HasMaxLength({_text_key_length(target)});")
        elif type_ref["kind"] == "enum":
            item = next((entry for entry in context.spec["enums"] if entry["name"] == type_ref["name"]), None)
            if item is None or item["valueType"] != "integer":
                statements.append(f"{prop}.HasConversion<string>().HasMaxLength(64);")
        elif type_ref["kind"] == "scalar" and type_ref["scalar"] == "decimal":
            statements.append(f"{prop}.HasPrecision(18, 4);")
        elif (
            type_ref["kind"] == "scalar"
            and type_ref["scalar"] == "string"
            and field["constraints"].get("maxLength") is not None
        ):
            statements.append(f"{prop}.HasMaxLength({number_text(field['constraints']['maxLength'])});")
    return statements


def data_files(context: AspNetContext) -> list[dict]:
    """The database context of Entity Framework Core, with its conversions."""
    if not context.ef_core:
        return []
    namespace = data_namespace(context)
    usings = CsUsings(namespace).add(
        "System.Text.Json",
        "Microsoft.EntityFrameworkCore",
        "Microsoft.EntityFrameworkCore.ChangeTracking",
        "Microsoft.EntityFrameworkCore.Metadata.Builders",
        "Microsoft.EntityFrameworkCore.Storage.ValueConversion",
        common_namespace(context),
    )
    for resource in context.spec["resources"]:
        usings.add(namespace_of(context, context.layout.resource(resource, "model")))
    sets = []
    entities = []
    for resource in context.spec["resources"]:
        name = names(resource)
        sets.append(f"    public DbSet<{name['type']}> {name['set']} => Set<{name['type']}>();")
        entities.append(
            lines(
                f"        model.Entity<{name['type']}>(entity =>",
                "        {",
                [f"            {statement}" for statement in _entity_configuration(context, resource)],
                "        });",
            )
        )
    database = context.settings.get("database")
    mysql = database in ("mysql", "mariadb")
    content = lines(
        *cs_header(namespace, usings),
        cs_doc(
            "The database of the API: one table per resource. Embedded objects and lists are stored as JSON columns."
        ),
        "public sealed class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)",
        "{",
        sets,
        "",
        "    protected override void ConfigureConventions(ModelConfigurationBuilder configuration)",
        "    {",
        "        // Date-times are stored in UTC, so they read back the same on any database and sort as times",
        "        configuration.Properties<DateTimeOffset>().HaveConversion<UtcDateTimeConverter>();",
        database == "sqlite"
        and [
            "        // SQLite cannot compare or sort decimals: they are stored as numbers with a fraction",
            "        configuration.Properties<decimal>().HaveConversion<double>();",
        ],
        mysql
        and [
            "        // The MySQL provider reads dates as DateTime: they are converted on the way in and out",
            '        configuration.Properties<DateOnly>().HaveConversion<DateOnlyConverter>().HaveColumnType("date");',
        ],
        "    }",
        "",
        "    protected override void OnModelCreating(ModelBuilder model)",
        "    {",
        "\n".join(entities),
        "    }",
        "}",
        "",
        cs_doc("A DateTimeOffset as a UTC DateTime: every database keeps it."),
        "public sealed class UtcDateTimeConverter() : ValueConverter<DateTimeOffset, DateTime>(",
        "    value => value.UtcDateTime,",
        "    value => new DateTimeOffset(DateTime.SpecifyKind(value, DateTimeKind.Utc)));",
        "",
        mysql
        and [
            cs_doc("A DateOnly as the DateTime at its midnight, which the MySQL provider reads."),
            "public sealed class DateOnlyConverter() : ValueConverter<DateOnly, DateTime>(",
            "    value => value.ToDateTime(TimeOnly.MinValue),",
            "    value => DateOnly.FromDateTime(value));",
            "",
        ],
        cs_doc("Columns that keep a value as JSON text: embedded objects, lists and maps."),
        "public static class JsonColumns",
        "{",
        "    public static PropertyBuilder<T> HasJsonConversion<T>(this PropertyBuilder<T> property) => property.HasConversion(",
        "        value => JsonSerializer.Serialize(value, JsonValues.Options),",
        "        text => JsonSerializer.Deserialize<T>(text, JsonValues.Options)!,",
        "        new ValueComparer<T>(",
        "            (a, b) => JsonSerializer.Serialize(a, JsonValues.Options) == JsonSerializer.Serialize(b, JsonValues.Options),",
        "            value => JsonSerializer.Serialize(value, JsonValues.Options).GetHashCode(),",
        "            value => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value, JsonValues.Options), JsonValues.Options)!));",
        "}",
    )
    return [{"path": f"src/{context.root}/Data/AppDbContext.cs", "content": file_text(content)}]


def program_file(context: AspNetContext) -> dict:
    """Program.cs: services, storage, authentication and the request pipeline."""
    usings = CsUsings("").add(
        "System.Text.Json.Serialization",
        "Microsoft.AspNetCore.Mvc.ModelBinding.Metadata",
        common_namespace(context),
    )
    auth = context.settings["auth"]
    database = context.settings.get("database")
    if context.ef_core:
        usings.add("Microsoft.EntityFrameworkCore", data_namespace(context))
        if database in ("mysql", "mariadb"):
            usings.add("MySql.EntityFrameworkCore.Extensions")
    if auth == "apiKey":
        usings.add("Microsoft.AspNetCore.Authentication", namespace_of(context, "Security"))
    if auth == "jwt":
        usings.add(namespace_of(context, "Security"))
    registrations = []
    for resource in context.spec["resources"]:
        name = names(resource)
        usings.add(
            namespace_of(context, context.layout.resource(resource, "repository")),
            namespace_of(context, context.layout.resource(resource, "service")),
        )
        if context.pending:
            implementation = name["pendingRepository"]
        elif context.ef_core:
            implementation = name["efRepository"]
        else:
            implementation = name["memory"]
        # The in-memory storage lives as long as the application; the database one, as long as a request
        lifetime = "AddScoped" if context.ef_core else "AddSingleton"
        registrations.extend(
            [
                f"builder.Services.{lifetime}<{name['repository']}, {implementation}>();",
                f"builder.Services.AddScoped<{name['service']}>();",
            ]
        )
    use = "UseNpgsql" if database == "postgresql" else "UseSqlite" if database == "sqlite" else "UseMySQL"
    if context.pending:
        storage = "// Storage to write: every repository answers 501 until it is implemented"
    elif context.ef_core:
        storage = "// Each repository keeps its items in the database with Entity Framework Core"
    else:
        storage = "// Data kept in memory while the application runs; restarting it (or each test) starts empty"
    content = lines(
        usings.render(),
        "",
        "var builder = WebApplication.CreateBuilder(args);",
        "",
        "builder.Services",
        "    .AddControllers(options =>",
        '        // Errors name each field as the JSON does ("postalCode"), not as the C# property',
        "        options.ModelMetadataDetailsProviders.Add(new SystemTextJsonValidationMetadataProvider()))",
        "    .AddJsonOptions(options =>",
        "        // A field the contract does not describe is an error, as openapi.yaml says",
        "        options.JsonSerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow)",
        "    .ConfigureApiBehaviorOptions(options =>",
        "    {",
        "        options.InvalidModelStateResponseFactory = ApiErrors.InvalidModelState;",
        "        // Statuses without a body (415…) get the error format of openapi.yaml, not ProblemDetails",
        "        options.SuppressMapClientErrors = true;",
        "    });",
        "",
        storage,
        context.ef_core
        and [
            "builder.Services.AddDbContext<AppDbContext>((services, options) =>",
            f'    options.{use}(services.GetRequiredService<IConfiguration>()["DATABASE_CONNECTION"]',
            '        ?? throw new InvalidOperationException("Set DATABASE_CONNECTION to the connection string of the database")));',
        ],
        registrations,
        auth == "apiKey"
        and [
            "",
            "builder.Services.AddAuthentication(ApiKeyAuthenticationHandler.SchemeName)",
            "    .AddScheme<AuthenticationSchemeOptions, ApiKeyAuthenticationHandler>(ApiKeyAuthenticationHandler.SchemeName, null);",
            "builder.Services.AddAuthorization();",
        ],
        auth == "jwt" and ["", "builder.Services.AddTokenAuthentication();"],
        "",
        "var app = builder.Build();",
        context.ef_core
        and [
            "",
            "using (var scope = app.Services.CreateScope())",
            "{",
            "    // Creates the tables when the database has none, while you develop; use migrations for a real database",
            "    scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.EnsureCreated();",
            "}",
        ],
        "",
        "app.UseMiddleware<ApiErrorMiddleware>();",
        "app.UseStatusCodePages(ApiErrors.StatusCodePage);",
        context.security and ["app.UseAuthentication();", "app.UseAuthorization();"],
        "app.MapControllers();",
        "app.Run();",
        "",
        cs_doc("The application, visible to the tests (WebApplicationFactory)."),
        "public partial class Program;",
    )
    return {"path": f"src/{context.root}/Program.cs", "content": file_text(content)}
