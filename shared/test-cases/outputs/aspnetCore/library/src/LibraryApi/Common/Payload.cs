using System.ComponentModel.DataAnnotations;

namespace LibraryApi.Common;

/// <summary>
/// Base of request bodies and embedded objects. System.Text.Json calls a setter only for the properties present in
/// the JSON, so the setters record them: a property sent as null is present, a missing one is not.
/// </summary>
public abstract class Payload : IValidatableObject
{
    private readonly HashSet<string> present = [];

    /// <summary>Records that the property with this JSON name was sent.</summary>
    protected void Mark(string field) => present.Add(field);

    /// <summary>Whether the property with this JSON name was sent, even as null.</summary>
    public bool Has(string field) => present.Contains(field);

    /// <summary>JSON names of the properties the body must carry.</summary>
    protected virtual string[] RequiredFields => [];

    /// <summary>The properties that cannot be null when they are sent, with their values.</summary>
    protected virtual IEnumerable<(string Field, object? Value)> NonNullValues() => [];

    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
    {
        foreach (var field in RequiredFields.Where(field => !Has(field)))
        {
            yield return new ValidationResult("The field is required", [field]);
        }
        foreach (var (field, value) in NonNullValues().Where(item => Has(item.Field) && item.Value is null))
        {
            yield return new ValidationResult("The field must not be null", [field]);
        }
    }
}
