"""Django models of the Django REST Framework project: enums as choices, and one model per resource. A reference
to one item is a foreign key that protects the item from deletion; embedded objects, lists and maps are JSON
fields; timestamps the server keeps use auto_now_add and auto_now. Mirrors
web/src/core/generators/frameworks/djangoRest/models.ts.
"""

import re

from ....js import js_string, number_text
from ....model.naming import to_screaming_snake_case
from ...languages.python.python import py_class, py_literal, py_string
from .context import DjangoContext, Modules, attr, is_foreign_key, module_of, names

_DIGIT_START = re.compile(r"^[0-9]")


def member_name(value, used: set[str]) -> str:
    """Enum member names: in progress → IN_PROGRESS, 2 → VALUE_2."""
    name = to_screaming_snake_case(js_string(value)) or "VALUE"
    if _DIGIT_START.match(name):
        name = f"VALUE_{name}"
    unique = name
    n = 2
    while unique in used:
        unique = f"{name}_{n}"
        n += 1
    used.add(unique)
    return unique


def enum_blocks(context: DjangoContext, modules: Modules) -> None:
    if not context.spec["enums"]:
        return
    modular = context.settings["architecture"] == "modular"
    module = modules.get(
        context.layout.shared_enums(),
        "Enums shared by the resources." if modular else "Models of the API and their enums.",
    )
    module["imports"].add("django.db", "models")
    for item in context.spec["enums"]:
        integer = item["valueType"] == "integer"
        used: set[str] = set()
        members = [
            f"    {member_name(value, used)} = {py_literal(value)}, {py_string(js_string(value))}"
            for value in item["values"]
        ]
        module["blocks"].append(
            "\n".join(
                [
                    f"class {py_class(item['name'])}(models.{'IntegerChoices' if integer else 'TextChoices'}):",
                    f'    """Values of {item["name"]}."""',
                    "",
                    *members,
                ]
            )
        )


def _enum_class(context: DjangoContext, name: str, here: str, module: dict) -> str:
    shared = context.layout.shared_enums()
    if shared != here:
        module["imports"].add(shared, py_class(name))
    return py_class(name)


_SCALAR_FIELDS = {
    "float": "FloatField",
    "boolean": "BooleanField",
    "date": "DateField",
    "datetime": "DateTimeField",
    "time": "TimeField",
    "uuid": "UUIDField",
}


def _model_field(context: DjangoContext, resource: dict, field: dict, here: str, module: dict) -> str:
    """The model field of an API field."""
    is_key = field["name"] == resource["key"]["field"]
    args: list[str] = []
    optional = not is_key and (field["nullable"] or not field["required"] or field.get("server") == "pending")
    if is_key:
        generated = resource["key"]["generated"]
        if generated == "increment":
            return "models.BigAutoField(primary_key=True)"
        if generated == "uuid":
            module["imports"].add("uuid")
            if resource["key"]["type"]["scalar"] == "uuid":
                return "models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)"
            return "models.CharField(primary_key=True, max_length=36, default=new_key, editable=False)"
        args.append("primary_key=True")
    if is_foreign_key(field):
        target = next(item for item in context.spec["resources"] if item["name"] == field["reference"])
        if target["name"] == resource["name"]:
            to = '"self"'
        else:
            to = py_string(f"{context.layout.app(target)}.{names(target)['model']}")
        # PROTECT: an item other items refer to cannot be deleted (the API answers 409)
        parts = [to, "on_delete=models.PROTECT", 'related_name="+"']
        if optional:
            parts.extend(["null=True", "blank=True"])
        return f"models.ForeignKey({', '.join(parts)})"
    if field.get("server") == "created":
        return "models.DateTimeField(auto_now_add=True)"
    if field.get("server") == "updated":
        return "models.DateTimeField(auto_now=True)"
    if optional:
        args.extend(["null=True", "blank=True"])
    if field.get("defaultValue") is not None:
        args.append(f"default={py_literal(field['defaultValue'])}")
    type_ref = field["type"]
    if type_ref["kind"] == "enum":
        item = next(candidate for candidate in context.spec["enums"] if candidate["name"] == type_ref["name"])
        class_name = _enum_class(context, type_ref["name"], here, module)
        if item["valueType"] == "integer":
            return f"models.IntegerField({', '.join([f'choices={class_name}.choices', *args])})"
        longest = max([1, *(len(js_string(value)) for value in item["values"])])
        return f"models.CharField({', '.join([f'max_length={longest}', f'choices={class_name}.choices', *args])})"
    if type_ref["kind"] != "scalar" or type_ref["scalar"] == "any":
        module["imports"].add("django.core.serializers.json", "DjangoJSONEncoder")
        return f"models.JSONField({', '.join(['encoder=DjangoJSONEncoder', *args])})"

    def call(name: str, extra: list[str] | None = None) -> str:
        return f"models.{name}({', '.join([*(extra or []), *args])})"

    scalar = type_ref["scalar"]
    if scalar == "string":
        maximum = field["constraints"].get("maxLength")
        if maximum is not None or is_key:
            return call("CharField", [f"max_length={number_text(maximum) if maximum is not None else 255}"])
        return call("TextField")
    if scalar == "integer":
        return call("BigIntegerField" if type_ref.get("bits") == 64 else "IntegerField")
    if scalar == "decimal":
        # A fixed size: MySQL and MariaDB need one
        return call("DecimalField", ["max_digits=18", "decimal_places=4"])
    if scalar == "duration":
        return call("CharField", ["max_length=64"])
    if scalar in _SCALAR_FIELDS:
        return call(_SCALAR_FIELDS[scalar])
    # Binary values travel as base64 text, as the API sends them
    return call("TextField")


def model_blocks(context: DjangoContext, modules: Modules) -> None:
    modular = context.settings["architecture"] == "modular"
    for resource in context.spec["resources"]:
        here = module_of(context, resource, "models")
        module = modules.get(
            here, f"Model of {resource['plural']}." if modular else "Models of the API and their enums."
        )
        module["imports"].add("django.db", "models")
        name = names(resource)
        if resource["key"]["generated"] == "uuid" and resource["key"]["type"]["scalar"] != "uuid":
            module["imports"].add("uuid")
            if not any(block.startswith("def new_key") for block in module["blocks"]):
                module["blocks"].insert(
                    0,
                    'def new_key() -> str:\n    """A new key for an item: a random UUID as text."""\n    return str(uuid.uuid4())',
                )
        fields = []
        for field in resource["fields"]:
            todo = f"    # TODO: {field['todo']}\n" if field.get("todo") else ""
            fields.append(f"{todo}    {attr(field)} = {_model_field(context, resource, field, here, module)}")
        key = next(field for field in resource["fields"] if field["name"] == resource["key"]["field"])
        block = [
            f"# TODO: {resource['todo']}" if resource.get("todo") else None,
            f"class {name['model']}(models.Model):",
            f'    """A stored {resource["singular"]}."""',
            "",
            *fields,
            "",
            "    class Meta:",
            f"        db_table = {py_string(resource['plural'].replace(' ', '_'))}",
            f"        ordering = [{py_string(attr(key))}]",
        ]
        module["blocks"].append("\n".join(line for line in block if line is not None))
