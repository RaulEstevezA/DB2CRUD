"""Serializers of the Django REST Framework project: one per resource (it reads requests and writes responses,
with the access of each field) and one per embedded object. Fields use their JSON names and point to the model
attribute with source. A base class rejects fields the client may not send, as the OpenAPI contract does.
Mirrors web/src/core/generators/frameworks/djangoRest/serializers.ts.
"""

import re

from ....js import number_text
from ...languages.python.python import py_class, py_literal, py_string
from .context import DjangoContext, Modules, attr, is_foreign_key, module_of, names

_STRING_FORMATS = {
    "email": "EmailField",
    "uri": "URLField",
    "uuid": "UUIDField",
    "date": "DateField",
    "date-time": "DateTimeField",
    "time": "TimeField",
}
_PLAIN_SCALARS = {
    "boolean": "BooleanField",
    "date": "DateField",
    "datetime": "DateTimeField",
    "time": "TimeField",
    "uuid": "UUIDField",
    "any": "JSONField",
}
_NESTED = "__nested__"


def _value_field(context: DjangoContext, type_ref: dict, field: dict | None, here: str, module: dict) -> dict:
    """The DRF field that reads and writes one value of a type, without the field's own options: {"name", "args"}."""
    c = field["constraints"] if field else {}
    kind = type_ref["kind"]
    if kind == "scalar":
        scalar = type_ref["scalar"]
        if scalar == "string":
            if c.get("format") in _STRING_FORMATS:
                return {"name": _STRING_FORMATS[c["format"]], "args": []}
            # Text as sent: no trimming, and empty text is valid unless a minimum length says otherwise
            args = ["trim_whitespace=False", *([] if c.get("minLength") else ["allow_blank=True"])]
            if c.get("minLength") is not None:
                args.append(f"min_length={number_text(c['minLength'])}")
            if c.get("maxLength") is not None:
                args.append(f"max_length={number_text(c['maxLength'])}")
            if c.get("pattern") is not None:
                module["imports"].add("django.core.validators", "RegexValidator")
                args.append(f"validators=[RegexValidator({py_string(c['pattern'])})]")
            return {"name": "CharField", "args": args}
        if scalar in ("integer", "float", "decimal"):
            args = ["max_digits=18", "decimal_places=4", "coerce_to_string=False"] if scalar == "decimal" else []
            if c.get("minimum") is not None:
                args.append(f"min_value={number_text(c['minimum'])}")
            if c.get("maximum") is not None:
                args.append(f"max_value={number_text(c['maximum'])}")
            exclusive = []
            if c.get("exclusiveMinimum") is not None:
                module["imports"].add("config.validation", "greater_than")
                exclusive.append(f"greater_than({number_text(c['exclusiveMinimum'])})")
            if c.get("exclusiveMaximum") is not None:
                module["imports"].add("config.validation", "less_than")
                exclusive.append(f"less_than({number_text(c['exclusiveMaximum'])})")
            if exclusive:
                args.append(f"validators=[{', '.join(exclusive)}]")
            name = {"integer": "IntegerField", "float": "FloatField"}.get(scalar, "DecimalField")
            return {"name": name, "args": args}
        if scalar in _PLAIN_SCALARS:
            return {"name": _PLAIN_SCALARS[scalar], "args": []}
        return {"name": "CharField", "args": ["trim_whitespace=False", "allow_blank=True"]}
    if kind == "enum":
        shared = context.layout.shared_enums()
        if shared != here:
            module["imports"].add(shared, py_class(type_ref["name"]))
        return {"name": "ChoiceField", "args": [f"choices={py_class(type_ref['name'])}.choices"]}
    if kind == "array":
        child = _value_field(context, type_ref["items"], None, here, module)
        args = [f"child={_render(child)}"]
        if c.get("minItems") is not None:
            args.append(f"min_length={number_text(c['minItems'])}")
        if c.get("maxItems") is not None:
            args.append(f"max_length={number_text(c['maxItems'])}")
        return {"name": "ListField", "args": args}
    if kind == "map":
        return {
            "name": "DictField",
            "args": [f"child={_render(_value_field(context, type_ref['value'], None, here, module))}"],
        }
    shared = context.layout.shared_serializers()
    class_name = f"{py_class(type_ref['name'])}Serializer"
    if shared != here:
        module["imports"].add(shared, class_name)
    return {"name": f"{_NESTED}{class_name}", "args": []}


def _render(field: dict) -> str:
    if field["name"].startswith(_NESTED):
        return f"{field['name'][len(_NESTED) :]}({', '.join(field['args'])})"
    return f"serializers.{field['name']}({', '.join(field['args'])})"


def _key_value_field(context: DjangoContext, reference: str) -> str:
    """The key type of a resource, as a DRF field: references to it are written with it."""
    target = next(item for item in context.spec["resources"] if item["name"] == reference)
    scalar = target["key"]["type"]["scalar"]
    if scalar == "integer":
        return "serializers.IntegerField()"
    return "serializers.UUIDField()" if scalar == "uuid" else "serializers.CharField()"


def _declaration(context: DjangoContext, resource: dict | None, field: dict, here: str, module: dict) -> str:
    """One serializer field: its value, its access, whether it is required, its default and its source."""
    options: list[str] = []
    is_key = resource is not None and field["name"] == resource["key"]["field"]
    source = attr(field) if resource else None
    wire = field["wire"]
    if source and source != wire:
        options.append(f"source={py_string(source)}")
    if field["access"] == "readOnly":
        options.append("read_only=True")
    else:
        if field["access"] == "writeOnly":
            options.append("write_only=True")
        options.append(f"required={'True' if field['required'] else 'False'}")
        if field["nullable"]:
            options.append("allow_null=True")
        if not field["required"] and "defaultValue" in field:
            options.append(f"default={py_literal(field['defaultValue'])}")
    if is_key and field["access"] == "readOnly":
        inner = f"source={py_string(source)}" if source and source != wire else ""
        return f"    {wire} = serializers.ReadOnlyField({inner})"
    if resource and is_foreign_key(field):
        target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
        model = names(target)["model"]
        module["imports"].add(module_of(context, target, "models"), model)
        args = [] if field["access"] == "readOnly" else [f"queryset={model}.objects.all()"]
        value = {"name": "PrimaryKeyRelatedField", "args": args}
    elif field.get("reference"):
        # A key, or a list of keys, of another resource, kept as plain values
        key_field = _key_value_field(context, field["reference"])
        if field["type"]["kind"] == "array":
            value = {"name": "ListField", "args": [f"child={key_field}"]}
        else:
            value = {"name": key_field[12 : key_field.index("(")], "args": []}
    else:
        value = _value_field(context, field["type"], field, here, module)
    if value["name"].startswith(_NESTED):
        many = field["type"]["kind"] == "array"
        parts = [part for part in ("many=True" if many else None, *options) if part]
        return f"    {wire} = {value['name'][len(_NESTED) :]}({', '.join(parts)})"
    if value["name"] == "ListField" and field["type"]["kind"] == "array" and field["type"]["items"]["kind"] == "object":
        nested = _value_field(context, field["type"]["items"], None, here, module)
        return f"    {wire} = {nested['name'][len(_NESTED) :]}({', '.join(['many=True', *options])})"
    return f"    {wire} = serializers.{value['name']}({', '.join([*value['args'], *options])})"


def serializer_blocks(context: DjangoContext, modules: Modules) -> None:
    modular = context.settings["architecture"] == "modular"
    shared = context.layout.shared_serializers()
    if context.spec["objects"]:
        module = modules.get(
            shared,
            "Serializers of the embedded objects shared by the resources."
            if modular
            else "Serializers of the API: requests in, responses out.",
        )
        module["imports"].add("rest_framework", "serializers")
        module["imports"].add("config.validation", "StrictSerializer")
        for spec_object in _declaration_order(context.spec["objects"]):
            fields = [_declaration(context, None, field, shared, module) for field in spec_object["fields"]]
            description = spec_object.get("description")
            if description is None:
                description = f"{spec_object['name']}, embedded in the resources that hold it."
            module["blocks"].append(
                "\n".join(
                    [
                        f"class {py_class(spec_object['name'])}Serializer(StrictSerializer):",
                        f'    """{description}"""',
                        "",
                        *fields,
                    ]
                )
            )
    for resource in context.spec["resources"]:
        here = module_of(context, resource, "serializers")
        module = modules.get(
            here,
            f"Serializer of {resource['plural']}: requests in, responses out."
            if modular
            else "Serializers of the API: requests in, responses out.",
        )
        module["imports"].add("rest_framework", "serializers")
        module["imports"].add("config.validation", "StrictSerializer")
        fields = []
        for field in resource["fields"]:
            todo = f"    # TODO: {field['todo']}\n" if field.get("todo") else ""
            fields.append(f"{todo}{_declaration(context, resource, field, here, module)}")
        module["blocks"].append(
            "\n".join(
                [
                    f"class {names(resource)['serializer']}(StrictSerializer):",
                    f'    """{capitalize(article(resource["singular"]))}: what a request may send and what a response shows."""',
                    "",
                    *fields,
                ]
            )
        )


def _inner(type_ref: dict) -> list[str]:
    kind = type_ref["kind"]
    if kind == "object":
        return [type_ref["name"]]
    if kind == "array":
        return _inner(type_ref["items"])
    if kind == "map":
        return _inner(type_ref["value"])
    return []


def _declaration_order(objects: list[dict]) -> list[dict]:
    """Objects ordered so each is declared after the objects it holds (a Python class must exist before it is used)."""
    ordered: list[dict] = []
    visiting: set[str] = set()

    def visit(spec_object: dict) -> None:
        if any(item is spec_object for item in ordered) or spec_object["name"] in visiting:
            return
        visiting.add(spec_object["name"])
        for field in spec_object["fields"]:
            for name in _inner(field["type"]):
                target = next((item for item in objects if item["name"] == name), None)
                if target:
                    visit(target)
        ordered.append(spec_object)

    for spec_object in objects:
        visit(spec_object)
    return ordered


_VOWEL = re.compile(r"^[aeiou]", re.IGNORECASE)


def article(text: str) -> str:
    return f"an {text}" if _VOWEL.match(text) else f"a {text}"


def capitalize(text: str) -> str:
    return text[:1].upper() + text[1:]
