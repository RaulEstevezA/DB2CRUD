"""Request bodies of the Laravel project: a Form Request per shape (create or replace, and partial update) with
Laravel's validation rules for every field the contract describes, and the enums they check. Mirrors
web/src/core/generators/frameworks/laravel/requests.ts.

Presence follows openapi.yaml: a required field must be present (it may be "" or [] if its rules allow them), an
optional one may be left out, and null is accepted only where the field is nullable.
"""

from ....js import number_text
from ....openapi.build import shape_fields
from ...common.text import file_text, lines
from ...languages.php.model import field_defaults
from ...languages.php.php import PhpImports, php_class, php_doc, php_header, php_regex, php_string
from .context import LaravelContext, article, class_path, names, qualified

# Patterns of the text formats Laravel has no rule for, as in the other generators
DATE_TIME = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$"
TIME = r"^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$"
DURATION = r"^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$"
BASE64 = r"^[A-Za-z0-9+\/]*={0,2}$"


class _RuleSet:
    def __init__(self, imports: PhpImports) -> None:
        # Rules by attribute path, in order
        self.rules: list[tuple[str, list[str]]] = []
        # Paths whose content is free
        self.open: list[str] = []
        self.imports = imports


def _regex_rule(pattern: str) -> str:
    return php_string(f"regex:{php_regex(pattern)}")


def _type_rules(
    context: LaravelContext, type_ref: dict, field: dict | None, rule_set: _RuleSet, path: str
) -> list[str]:
    """The rules of a value of a type, without presence and nullability."""

    def blank(text: bool, extra: str = "") -> str:
        rule_set.imports.add("App\\Rules\\BlankString")
        return f"new BlankString({'text: true' if text else 'text: false'}{extra})"

    c = field["constraints"] if field else {}
    kind = type_ref["kind"]
    if kind == "scalar":
        scalar = type_ref["scalar"]
        if scalar == "string":
            rules = ["'string'"]
            text_format = c.get("format")
            if text_format == "email":
                rules.append("'email'")
            if text_format == "uri":
                rules.append("'url'")
            if text_format == "uuid":
                rules.append("'uuid'")
            if text_format == "date":
                rules.append("'date_format:Y-m-d'")
            if text_format == "date-time":
                rules.append(_regex_rule(DATE_TIME))
            if text_format == "time":
                rules.append(_regex_rule(TIME))
            if c.get("minLength") is not None:
                rules.append(f"'min:{number_text(c['minLength'])}'")
            if c.get("maxLength") is not None:
                rules.append(f"'max:{number_text(c['maxLength'])}'")
            if c.get("pattern") is not None:
                rules.append(_regex_rule(c["pattern"]))
            extra = "".join(
                [
                    f", min: {number_text(c['minLength'])}" if c.get("minLength") is not None else "",
                    f", max: {number_text(c['maxLength'])}" if c.get("maxLength") is not None else "",
                    f", pattern: {php_string(php_regex(c['pattern']))}" if c.get("pattern") is not None else "",
                    ", format: true" if text_format else "",
                ]
            )
            rules.append(blank(True, extra))
            return rules
        if scalar in ("integer", "float", "decimal"):
            rules = ["'integer:strict'" if scalar == "integer" else "'numeric:strict'"]
            for key, rule in (
                ("minimum", "min"),
                ("maximum", "max"),
                ("exclusiveMinimum", "gt"),
                ("exclusiveMaximum", "lt"),
            ):
                if c.get(key) is not None:
                    rules.append(f"'{rule}:{number_text(c[key])}'")
            rules.append(blank(False))
            return rules
        if scalar == "boolean":
            return ["'boolean:strict'", blank(False)]
        if scalar == "date":
            return ["'string'", "'date_format:Y-m-d'", blank(True, ", format: true")]
        if scalar == "datetime":
            return ["'string'", _regex_rule(DATE_TIME), blank(True, ", format: true")]
        if scalar == "time":
            return ["'string'", _regex_rule(TIME), blank(True, ", format: true")]
        if scalar == "duration":
            return ["'string'", _regex_rule(DURATION), blank(True, ", format: true")]
        if scalar == "uuid":
            return ["'string'", "'uuid'", blank(True, ", format: true")]
        if scalar == "binary":
            return ["'string'", _regex_rule(BASE64), blank(True)]
        if scalar == "any":
            rule_set.open.append(path)
        return []
    if kind == "enum":
        rule_set.imports.add("Illuminate\\Validation\\Rule", f"{context.layout.enums()}\\{php_class(type_ref['name'])}")
        return [f"Rule::enum({php_class(type_ref['name'])}::class)", blank(False)]
    if kind == "array":
        rules = ["'list'"]
        if c.get("minItems") is not None:
            rules.append(f"'min:{number_text(c['minItems'])}'")
        if c.get("maxItems") is not None:
            rules.append(f"'max:{number_text(c['maxItems'])}'")
        rules.append(blank(False))
        return rules
    if kind == "map":
        rule_set.open.append(path)
    return ["'array'", blank(False)]


def _reference_rules(context: LaravelContext, field: dict, rule_set: _RuleSet) -> list[str]:
    """The rules of the key a reference holds: the type of the target's key."""
    target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
    rule_set.imports.add("App\\Rules\\BlankString")
    scalar = target["key"]["type"]["scalar"]
    if scalar == "integer":
        return ["'integer:strict'", "new BlankString(text: false)"]
    if scalar == "uuid":
        return ["'string'", "'uuid'", "new BlankString(text: true, format: true)"]
    return ["'string'", "new BlankString(text: true)"]


def _add_field(
    context: LaravelContext, field: dict, shape: str, parent: str | None, path: str, rule_set: _RuleSet, depth: int
) -> None:
    """Adds the rules of a field, and of what it holds, to the set. parent is None at the top of the body."""
    if parent is None:
        presence = ["'present'" if shape == "create" and field["required"] else "'sometimes'"]
    elif field["required"]:
        presence = [f"'exclude_if:{parent},null'", f"'present_with:{parent}'"]
    else:
        presence = ["'sometimes'"]
    if field["nullable"]:
        presence.append("'nullable'")
    if field.get("reference"):
        if field["type"]["kind"] == "array":
            rule_set.rules.append((path, [*presence, "'list'"]))
            rule_set.rules.append((f"{path}.*", _reference_rules(context, field, rule_set)))
        else:
            rule_set.rules.append((path, [*presence, *_reference_rules(context, field, rule_set)]))
        return
    rule_set.rules.append((path, [*presence, *_type_rules(context, field["type"], field, rule_set, path)]))
    _add_inner(context, field["type"], path, rule_set, depth)


def _add_inner(context: LaravelContext, type_ref: dict, path: str, rule_set: _RuleSet, depth: int) -> None:
    """Rules of what a type holds: the fields of an object, the items of a list, the values of a map."""
    if depth > 4:
        return
    if type_ref["kind"] == "object":
        spec_object = next((item for item in context.spec["objects"] if item["name"] == type_ref["name"]), None)
        for inner in spec_object["fields"] if spec_object else []:
            _add_field(context, inner, "object", path, f"{path}.{inner['wire']}", rule_set, depth + 1)
        return
    if type_ref["kind"] in ("array", "map"):
        item = type_ref["items"] if type_ref["kind"] == "array" else type_ref["value"]
        rules = _type_rules(context, item, None, rule_set, f"{path}.*")
        if rules:
            rule_set.rules.append((f"{path}.*", rules))
        _add_inner(context, item, f"{path}.*", rule_set, depth + 1)


def _request_file(context: LaravelContext, resource: dict, shape: str) -> dict:
    namespace = context.layout.resource(resource, "request")
    name = names(resource)
    class_name = name["store"] if shape == "create" else name["update"]
    rule_set = _RuleSet(PhpImports(namespace).add("App\\Http\\Requests\\ApiRequest"))
    fields = shape_fields(resource["fields"], shape)
    for field in fields:
        _add_field(context, field, shape, None, field["wire"], rule_set, 0)
    todos = [f"        // TODO: {field['wire']}: {field['todo']}" for field in fields if field.get("todo")]
    fill = field_defaults(context, fields, "$values", 0, shape == "create")
    if shape == "create":
        description = f"Body of a request that creates or replaces {article(resource['singular'])}."
    else:
        description = (
            f"Body of a request that changes part of {article(resource['singular'])}: only the fields sent change."
        )
    if rule_set.rules:
        returned = [
            "        return [",
            [f"            {php_string(path)} => [{', '.join(rules)}]," for path, rules in rule_set.rules],
            "        ];",
        ]
    else:
        returned = "        return [];"
    content = lines(
        *php_header(namespace, rule_set.imports),
        php_doc(description),
        f"final class {class_name} extends ApiRequest",
        "{",
        bool(rule_set.open)
        and [f"    protected array $open = [{', '.join(php_string(path) for path in rule_set.open)}];", ""],
        "    /** @return array<string, list<mixed>> */",
        "    public function rules(): array",
        "    {",
        todos,
        returned,
        "    }",
        "",
        "    /** @return array<string, mixed> The values sent, with the defaults of the fields left out. */"
        if shape == "create"
        else "    /** @return array<string, mixed> The values sent. */",
        "    public function values(): array",
        "    {",
        "        $values = $this->validated();",
        [f"        {line}" for line in fill],
        "",
        "        return $values;",
        "    }",
        "}",
    )
    return {"path": class_path(namespace, class_name), "content": file_text(content)}


def request_files(context: LaravelContext, resource: dict) -> list[dict]:
    """The Form Requests of a resource, when an endpoint receives a body."""
    if not any(endpoint["input"] != "none" for endpoint in resource["endpoints"]):
        return []
    return [_request_file(context, resource, "create"), _request_file(context, resource, "update")]


def request_class(context: LaravelContext, resource: dict, shape: str) -> str:
    """The class of a resource's request of a shape, fully qualified."""
    name = names(resource)
    return qualified(context, resource, "request", name["store"] if shape == "create" else name["update"])
