using System.Text.Json;

namespace CatalogApi.Common;

/// <summary>JSON helpers of the service and the storage.</summary>
public static class JsonValues
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    /// <summary>A value written in JSON, such as the default of a list.</summary>
    public static T Parse<T>(string json) => JsonSerializer.Deserialize<T>(json, Options)!;

    /// <summary>A copy of a value made through JSON, so a stored item never shares objects with the caller.</summary>
    public static T Copy<T>(T value) => JsonSerializer.Deserialize<T>(JsonSerializer.SerializeToUtf8Bytes(value, Options), Options)!;
}
