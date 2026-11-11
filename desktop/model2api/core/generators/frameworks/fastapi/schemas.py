"""Pydantic schemas of the FastAPI project: the base model and validators shared by every schema, the enums and
embedded objects, and the read, create and partial update schemas of each resource. They follow the shapes of
the OpenAPI contract (openapi/build.py) field by field. Mirrors
web/src/core/generators/frameworks/fastapi/schemas.ts.
"""

import re

from ....js import js_string, number_text
from ....model.naming import to_screaming_snake_case
from ....openapi.build import always_in_response, shape_fields
from ...common.text import file_text, lines
from ...languages.python.python import PyImports, py_class, py_docstring, py_literal, py_string, py_type
from .context import FastApiContext, attr, classes


def validators_file() -> dict:
    """The base schema and the validators of formats Pydantic has no plain type for."""
    content = lines(
        py_docstring("Base schema and validators shared by every request and response schema."),
        "",
        "from datetime import UTC, date, datetime, time",
        "from decimal import Decimal",
        "from typing import Annotated, Any, ClassVar",
        "from uuid import UUID",
        "",
        "from pydantic import AfterValidator, AnyUrl, BaseModel, ConfigDict, PlainSerializer, field_validator, model_validator",
        "",
        "",
        "class ApiModel(BaseModel):",
        '    """Base of every schema: fields are read by their JSON name or their Python name, unknown fields',
        "    are rejected, bytes travel as base64, and fields listed in `non_nullable` may be left out but never",
        '    sent as null."""',
        "",
        '    model_config = ConfigDict(populate_by_name=True, extra="forbid", ser_json_bytes="base64", val_json_bytes="base64")',
        "",
        "    non_nullable: ClassVar[frozenset[str]] = frozenset()",
        "",
        '    @model_validator(mode="after")',
        '    def reject_null(self) -> "ApiModel":',
        "        for name in self.non_nullable & self.model_fields_set:",
        "            if getattr(self, name) is None:",
        "                alias = type(self).model_fields[name].alias or name",
        '                raise ValueError(f"{alias} cannot be null")',
        "        return self",
        "",
        "",
        "class ResponseModel(BaseModel):",
        '    """Base of response schemas: built from stored values, which may hold more fields than the API shows."""',
        "",
        '    model_config = ConfigDict(populate_by_name=True, from_attributes=True, ser_json_bytes="base64", val_json_bytes="base64")',
        "",
        '    @field_validator("*", mode="after")',
        "    @classmethod",
        "    def utc(cls, value: Any) -> Any:",
        '        """Dates stored without a time zone (SQLite keeps none) were stored in UTC: every database answers alike."""',
        "        if isinstance(value, datetime) and value.tzinfo is None:",
        "            return value.replace(tzinfo=UTC)",
        "        return value",
        "",
        "",
        "def _check_url(value: str) -> str:",
        "    AnyUrl(value)",
        "    return value",
        "",
        "",
        "def _check_uuid(value: str) -> str:",
        "    return str(UUID(value))",
        "",
        "",
        "def _check_date(value: str) -> str:",
        "    date.fromisoformat(value)",
        "    return value",
        "",
        "",
        "def _check_datetime(value: str) -> str:",
        '    datetime.fromisoformat(value.replace("Z", "+00:00"))',
        "    return value",
        "",
        "",
        "def _check_time(value: str) -> str:",
        "    time.fromisoformat(value)",
        "    return value",
        "",
        "",
        "# Texts with a format, kept as text after the check",
        "UrlText = Annotated[str, AfterValidator(_check_url)]",
        "UuidText = Annotated[str, AfterValidator(_check_uuid)]",
        "DateText = Annotated[str, AfterValidator(_check_date)]",
        "DateTimeText = Annotated[str, AfterValidator(_check_datetime)]",
        "TimeText = Annotated[str, AfterValidator(_check_time)]",
        "",
        "# Exact numbers travel as JSON numbers, as the OpenAPI contract describes them",
        'DecimalNumber = Annotated[Decimal, PlainSerializer(float, return_type=float, when_used="json")]',
        "",
        "# Free JSON values",
        "JsonValue = Any",
    )
    return {"path": "app/validators.py", "content": file_text(content)}


_FORMAT_TYPES = {
    "uri": "UrlText",
    "uuid": "UuidText",
    "date": "DateText",
    "date-time": "DateTimeText",
    "time": "TimeText",
}


class _TypeNames:
    """Python names of the shared enums and objects, imported from the shared module."""

    def __init__(self, context: FastApiContext, imports: PyImports, here: str) -> None:
        self._shared = context.layout.shared()["module"]
        self._imports = imports
        self._here = here

    def _named(self, name: str) -> str:
        class_name = py_class(name)
        if self._shared != self._here:
            self._imports.add(self._shared, class_name)
        return class_name

    def object(self, name: str) -> str:
        return self._named(name)

    def enum(self, name: str) -> str:
        return self._named(name)


_DECIMAL = re.compile(r"\bDecimal\b", re.ASCII)


def _field_type(field: dict, imports: PyImports, names) -> str:
    """The Python type of a field, with its format and exact-number serialization."""
    text_format = field["constraints"].get("format")
    if field["type"]["kind"] == "scalar" and field["type"]["scalar"] == "string" and text_format:
        if text_format == "email":
            imports.add("pydantic", "EmailStr")
            return "EmailStr"
        name = _FORMAT_TYPES.get(text_format)
        imports.add("app.validators", name)
        return name
    text = py_type(field["type"], imports, names)
    if "Decimal" in text:
        imports.add("app.validators", "DecimalNumber")
        return _DECIMAL.sub("DecimalNumber", text)
    return text


def _field_args(field: dict) -> list[str]:
    """Arguments of Field(...) for the validations, the JSON name and the description."""
    args: list[str] = []
    name = attr(field)
    if name != field["wire"]:
        args.append(f"alias={py_string(field['wire'])}")
    c = field["constraints"]
    text = field["type"]["kind"] == "scalar" and field["type"]["scalar"] == "string"
    is_list = field["type"]["kind"] == "array"
    if text or is_list:
        minimum = c.get("minItems") if is_list else c.get("minLength")
        maximum = c.get("maxItems") if is_list else c.get("maxLength")
        if minimum is not None:
            args.append(f"min_length={number_text(minimum)}")
        if maximum is not None:
            args.append(f"max_length={number_text(maximum)}")
    for key, keyword in (("minimum", "ge"), ("maximum", "le"), ("exclusiveMinimum", "gt"), ("exclusiveMaximum", "lt")):
        if c.get(key) is not None:
            args.append(f"{keyword}={number_text(c[key])}")
    if text and c.get("pattern") is not None:
        args.append(f"pattern={py_string(c['pattern'])}")
    if field.get("description"):
        args.append(f"description={py_string(field['description'])}")
    return args


def _declaration(field: dict, shape: str, imports: PyImports, names) -> str:
    """One field declaration: name: str = Field(..., min_length=2)."""
    field_type = _field_type(field, imports, names)
    args = _field_args(field)
    if shape == "update":
        optional = True
        default_text = "None"
    elif shape == "read":
        optional = field["nullable"] or not always_in_response(field)
        default_text = "None" if optional else "..."
    else:
        optional = field["nullable"] or not field["required"]
        if field["required"]:
            default_text = "..."
        elif "defaultValue" in field:
            default_text = py_literal(field["defaultValue"])
        else:
            default_text = "None"
    annotation = f"{field_type} | None" if optional else field_type
    if not args:
        if default_text == "...":
            return f"{attr(field)}: {annotation}"
        return f"{attr(field)}: {annotation} = {default_text}"
    imports.add("pydantic", "Field")
    default_arg = "..." if default_text == "..." else f"default={default_text}"
    return f"{attr(field)}: {annotation} = Field({', '.join([default_arg, *args])})"


def _non_nullable(fields: list[dict]) -> list[str]:
    """Fields that may be left out but never sent as null, for ApiModel.non_nullable."""
    return [attr(field) for field in fields if not field["nullable"]]


def _schema_class(
    name: str, base: str, docstring: str, fields: list[dict], shape: str, imports: PyImports, names
) -> str:
    body = []
    for field in fields:
        todo = f"    # TODO: {field['todo']}\n" if field.get("todo") else ""
        body.append(f"{todo}    {_declaration(field, shape, imports, names)}")
    guarded: list[str] = []
    if shape != "read":
        for attribute in _non_nullable(fields):
            field = next(item for item in fields if attr(item) == attribute)
            if shape == "update" or not field["required"]:
                guarded.append(attribute)
    if guarded:
        imports.add("typing", "ClassVar")
        body.extend(
            ["", f"    non_nullable: ClassVar[frozenset[str]] = frozenset({{{', '.join(map(py_string, guarded))}}})"]
        )
    return lines(f"class {name}({base}):", f"    {py_docstring(docstring)}", "", body if body else ["    pass"])


_DIGIT_START = re.compile(r"^[0-9]")


def _member_name(value, used: set[str]) -> str:
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


def shared_schemas_file(context: FastApiContext) -> dict | None:
    """The shared module: enums and embedded objects."""
    spec = context.spec
    if not spec["enums"] and not spec["objects"]:
        return None
    imports = PyImports()
    here = context.layout.shared()["module"]
    names = _TypeNames(context, imports, here)
    blocks: list[str] = []
    for item in spec["enums"]:
        integer = item["valueType"] == "integer"
        base = "IntEnum" if integer else "str, Enum"
        imports.add("enum", "IntEnum" if integer else "Enum")
        used: set[str] = set()
        blocks.append(
            lines(
                f"class {py_class(item['name'])}({base}):",
                f"    {py_docstring('Values of ' + item['name'] + '.')}",
                "",
                [f"    {_member_name(value, used)} = {py_literal(value)}" for value in item["values"]],
            )
        )
    if spec["objects"]:
        imports.add("app.validators", "ApiModel")
    for spec_object in spec["objects"]:
        description = spec_object.get("description")
        docstring = (
            description
            if description is not None
            else f"{spec_object['name']}, embedded in the resources that hold it."
        )
        blocks.append(
            _schema_class(
                py_class(spec_object["name"]), "ApiModel", docstring, spec_object["fields"], "object", imports, names
            )
        )
    content = lines(
        py_docstring("Enums and embedded objects shared by the resources."),
        "",
        imports.render(),
        "",
        "",
        "\n\n\n".join(blocks),
    )
    return {"path": context.layout.shared()["file"], "content": file_text(content)}


def resource_schemas_file(context: FastApiContext, resource: dict) -> dict:
    """Read, create and partial update schemas of a resource."""
    from .routes import page_class

    imports = PyImports()
    location = context.layout.resource(resource, "schemas")
    names = _TypeNames(context, imports, location["module"])
    class_names = classes(resource)
    blocks: list[str] = []
    writes = any(endpoint["input"] != "none" for endpoint in resource["endpoints"])
    if writes:
        imports.add("app.validators", "ApiModel")
        blocks.append(
            _schema_class(
                class_names["create"],
                "ApiModel",
                f"Body of a request that creates or replaces {article(resource['singular'])}.",
                shape_fields(resource["fields"], "create"),
                "create",
                imports,
                names,
            )
        )
        blocks.append(
            _schema_class(
                class_names["update"],
                "ApiModel",
                f"Body of a request that changes part of {article(resource['singular'])}: only the fields sent change.",
                shape_fields(resource["fields"], "update"),
                "update",
                imports,
                names,
            )
        )
    imports.add("app.validators", "ResponseModel")
    blocks.append(
        _schema_class(
            class_names["read"],
            "ResponseModel",
            f"{capitalize(article(resource['singular']))} as the API returns it.",
            shape_fields(resource["fields"], "read"),
            "read",
            imports,
            names,
        )
    )
    page = page_class(resource)
    if page:
        imports.add("pydantic", "BaseModel")
        blocks.append(page)
    todo = f"# TODO: {resource['todo']}\n\n" if resource.get("todo") else ""
    content = lines(
        py_docstring(f"Request and response schemas of {resource['plural']}."),
        "",
        imports.render(),
        "",
        "",
        todo + "\n\n\n".join(blocks),
    )
    return {"path": location["file"], "content": file_text(content)}


_VOWEL = re.compile(r"^[aeiou]", re.IGNORECASE)


def article(text: str) -> str:
    return f"an {text}" if _VOWEL.match(text) else f"a {text}"


def capitalize(text: str) -> str:
    return text[:1].upper() + text[1:]
