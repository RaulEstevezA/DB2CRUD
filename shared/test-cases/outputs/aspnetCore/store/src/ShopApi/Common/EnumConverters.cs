using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace ShopApi.Common;

/// <summary>
/// Reads and writes an enum as the text each member has in JSON ([JsonStringEnumMemberName]). Any other text, a
/// number or a different case is an error.
/// </summary>
public sealed class TextEnumConverter<T> : JsonConverter<T> where T : struct, Enum
{
    private static readonly Dictionary<string, T> ByText = typeof(T)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .ToDictionary(member => member.GetCustomAttribute<JsonStringEnumMemberNameAttribute>()?.Name ?? member.Name, member => (T)member.GetValue(null)!);

    private static readonly Dictionary<T, string> ByValue = ByText.ToDictionary(pair => pair.Value, pair => pair.Key);

    /// <summary>The member with this text, or null when no member has it.</summary>
    public static T? Parse(string text) => ByText.TryGetValue(text, out var value) ? value : null;

    public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String && ByText.TryGetValue(reader.GetString()!, out var value))
        {
            return value;
        }
        throw new JsonException($"Must be one of: {string.Join(", ", ByText.Keys)}");
    }

    public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options) =>
        writer.WriteStringValue(ByValue[value]);
}

/// <summary>Reads and writes an enum as its number in JSON; a number no member has is an error.</summary>
public sealed class NumberEnumConverter<T> : JsonConverter<T> where T : struct, Enum
{
    private static readonly Dictionary<long, T> ByNumber = Enum.GetValues<T>().ToDictionary(value => Convert.ToInt64(value), value => value);

    /// <summary>The member with this number, or null when no member has it.</summary>
    public static T? Parse(long number) => ByNumber.TryGetValue(number, out var value) ? value : null;

    public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Number && reader.TryGetInt64(out var number) && ByNumber.TryGetValue(number, out var value))
        {
            return value;
        }
        throw new JsonException($"Must be one of: {string.Join(", ", ByNumber.Keys)}");
    }

    public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options) =>
        writer.WriteNumberValue(Convert.ToInt64(value));
}
