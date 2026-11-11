namespace LibraryApi.Common;

/// <summary>An error the API answers with a status, a code and a message (see openapi.yaml).</summary>
public sealed class ApiException(int status, string code, string message, IReadOnlyList<ErrorDetail>? details = null)
    : Exception(message)
{
    public int Status { get; } = status;

    public string Code { get; } = code;

    public IReadOnlyList<ErrorDetail> Details { get; } = details ?? [];

    public static ApiException Invalid(string field, string message) =>
        new(400, "validation_error", "The request is not valid", [new ErrorDetail(field, message)]);

    public static ApiException NotFound(string what) => new(404, "not_found", $"No {what} has this key");

    public static ApiException Conflict(string message) => new(409, "conflict", message);
}
