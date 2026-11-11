namespace ShopApi.Common;

/// <summary>Turns the exceptions of a request into the error format of openapi.yaml.</summary>
public sealed class ApiErrorMiddleware(RequestDelegate next, ILogger<ApiErrorMiddleware> logger)
{
    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await next(context);
        }
        catch (ApiException error) when (!context.Response.HasStarted)
        {
            await ApiErrors.Write(context, error.Status, error.Code, error.Message, error.Details);
        }
        catch (NotImplementedException error) when (!context.Response.HasStarted)
        {
            await ApiErrors.Write(context, 501, "not_implemented", error.Message);
        }
        catch (Exception error) when (!context.Response.HasStarted)
        {
            logger.LogError(error, "Unexpected error");
            await ApiErrors.Write(context, 500, "internal_error", "Something went wrong on the server");
        }
    }
}
