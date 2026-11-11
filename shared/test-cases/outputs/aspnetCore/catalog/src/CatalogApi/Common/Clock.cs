namespace CatalogApi.Common;

/// <summary>The time the server writes, in UTC.</summary>
public static class Clock
{
    /// <summary>Now, to the microsecond: what databases keep, so a later read gives the same value.</summary>
    public static DateTimeOffset Now()
    {
        var now = DateTimeOffset.UtcNow;
        return now.AddTicks(-(now.Ticks % 10));
    }

    /// <summary>Today, in UTC.</summary>
    public static DateOnly Today() => DateOnly.FromDateTime(DateTime.UtcNow);

    /// <summary>Now as ISO 8601 text, for a text field the server fills.</summary>
    public static string Text() => Now().UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
}
