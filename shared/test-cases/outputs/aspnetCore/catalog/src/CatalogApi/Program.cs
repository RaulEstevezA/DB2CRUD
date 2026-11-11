using System.Text.Json.Serialization;
using CatalogApi.Common;
using CatalogApi.Repositories;
using CatalogApi.Services;
using Microsoft.AspNetCore.Mvc.ModelBinding.Metadata;

var builder = WebApplication.CreateBuilder(args);

builder.Services
    .AddControllers(options =>
        // Errors name each field as the JSON does ("postalCode"), not as the C# property
        options.ModelMetadataDetailsProviders.Add(new SystemTextJsonValidationMetadataProvider()))
    .AddJsonOptions(options =>
        // A field the contract does not describe is an error, as openapi.yaml says
        options.JsonSerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow)
    .ConfigureApiBehaviorOptions(options =>
    {
        options.InvalidModelStateResponseFactory = ApiErrors.InvalidModelState;
        // Statuses without a body (415…) get the error format of openapi.yaml, not ProblemDetails
        options.SuppressMapClientErrors = true;
    });

// Data kept in memory while the application runs; restarting it (or each test) starts empty
builder.Services.AddSingleton<ICategoryRepository, InMemoryCategoryRepository>();
builder.Services.AddScoped<CategoryService>();
builder.Services.AddSingleton<IItemRepository, InMemoryItemRepository>();
builder.Services.AddScoped<ItemService>();

var app = builder.Build();

app.UseMiddleware<ApiErrorMiddleware>();
app.UseStatusCodePages(ApiErrors.StatusCodePage);
app.MapControllers();
app.Run();

/// <summary>The application, visible to the tests (WebApplicationFactory).</summary>
public partial class Program;
