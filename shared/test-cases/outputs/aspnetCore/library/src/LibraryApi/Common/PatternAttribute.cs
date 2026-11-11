using System.ComponentModel.DataAnnotations;
using System.Text.RegularExpressions;

namespace LibraryApi.Common;

/// <summary>
/// A text that matches a regular expression anywhere in it, as "pattern" reads it in openapi.yaml (the
/// RegularExpression attribute of .NET only accepts whole matches).
/// </summary>
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Parameter)]
public sealed class PatternAttribute(string pattern) : ValidationAttribute("Has the wrong format")
{
    private readonly Regex regex = new(pattern, RegexOptions.None, TimeSpan.FromSeconds(1));

    public override bool IsValid(object? value) => value is null || (value is string text && regex.IsMatch(text));
}
