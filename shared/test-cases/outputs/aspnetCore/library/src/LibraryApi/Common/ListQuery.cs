namespace LibraryApi.Common;

/// <summary>What a list asks a repository for: equality filters by JSON field name, an order and a window.</summary>
public sealed record ListQuery(IReadOnlyDictionary<string, object> Filters, string? SortField, bool Descending, int Offset, int? Limit)
{
    /// <summary>"-createdAt" sorts by createdAt in descending order.</summary>
    public static ListQuery Of(IReadOnlyDictionary<string, object> filters, string? sort, int offset = 0, int? limit = null)
    {
        if (string.IsNullOrEmpty(sort))
        {
            return new(filters, null, false, offset, limit);
        }
        var descending = sort.StartsWith('-');
        return new(filters, descending ? sort[1..] : sort, descending, offset, limit);
    }
}

/// <summary>A window of items and how many match, whatever the window.</summary>
public sealed record ListResult<T>(IReadOnlyList<T> Items, long Total);

/// <summary>One page of a list, as the API returns it.</summary>
public sealed record PageResponse<T>(IReadOnlyList<T> Items, long Total, int Page, int Size);
