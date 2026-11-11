using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ModelBinding;

namespace LibraryApi.Common;

/// <summary>Answers with the error format of openapi.yaml where ASP.NET Core would answer with its own.</summary>
public static class ApiErrors
{
    /// <summary>Writes an error body with its status.</summary>
    public static Task Write(HttpContext context, int status, string code, string message, IReadOnlyList<ErrorDetail>? details = null)
    {
        context.Response.StatusCode = status;
        return context.Response.WriteAsJsonAsync(ErrorResponse.Of(code, message, details));
    }

    /// <summary>The answer to a body or a parameter that breaks its rules: 400 with each problem.</summary>
    public static IActionResult InvalidModelState(ActionContext context)
    {
        var details = context.ModelState
            .Where(entry => entry.Value is { Errors.Count: > 0 })
            .SelectMany(entry => entry.Value!.Errors.Select(error => new ErrorDetail(FieldOf(entry.Key), MessageOf(error))))
            .ToList();
        return new ObjectResult(ErrorResponse.Of("validation_error", "The request is not valid", details)) { StatusCode = 400 };
    }

    /// <summary>Answers the requests no route takes, which ASP.NET Core leaves without a body.</summary>
    public static Task StatusCodePage(StatusCodeContext context) => context.HttpContext.Response.StatusCode switch
    {
        404 => Write(context.HttpContext, 404, "not_found", "No route matches this request"),
        405 => Write(context.HttpContext, 405, "method_not_allowed", "This path does not accept this method"),
        415 => Write(context.HttpContext, 400, "validation_error", "The body must be JSON (Content-Type: application/json)"),
        _ => Task.CompletedTask,
    };

    // "$.lines[0].quantity" (a value JSON cannot read) and "lines[0].quantity" (a broken rule) are the same field
    private static string FieldOf(string key) => key.StartsWith("$.") ? key[2..] : key == "$" ? "" : key;

    private static string MessageOf(ModelError error) =>
        string.IsNullOrEmpty(error.ErrorMessage) ? "Has a value of the wrong type" : error.ErrorMessage;
}
