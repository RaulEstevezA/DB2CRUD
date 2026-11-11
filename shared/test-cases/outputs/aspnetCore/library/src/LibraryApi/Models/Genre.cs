using System.Text.Json.Serialization;
using LibraryApi.Common;

namespace LibraryApi.Models;

/// <summary>Values of Genre, with the value each one has in JSON.</summary>
[JsonConverter(typeof(TextEnumConverter<Genre>))]
public enum Genre
{
    [JsonStringEnumMemberName("novel")]
    Novel,

    [JsonStringEnumMemberName("essay")]
    Essay,

    [JsonStringEnumMemberName("poetry")]
    Poetry,

    [JsonStringEnumMemberName("science")]
    Science,
}
