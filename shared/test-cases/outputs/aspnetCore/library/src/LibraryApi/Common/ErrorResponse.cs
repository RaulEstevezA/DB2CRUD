using System.Text.Json.Serialization;

namespace LibraryApi.Common;

/// <summary>The body of every error: {"error": {"code", "message", "details"}}.</summary>
public sealed record ErrorResponse(ErrorBody Error)
{
    public static ErrorResponse Of(string code, string message, IReadOnlyList<ErrorDetail>? details = null) =>
        new(new ErrorBody(code, message, details is { Count: > 0 } ? details : null));
}

/// <summary>What went wrong; the details only when there are some.</summary>
public sealed record ErrorBody(
    string Code,
    string Message,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<ErrorDetail>? Details);

/// <summary>Where the request is wrong and why.</summary>
public sealed record ErrorDetail(string Field, string Message);
