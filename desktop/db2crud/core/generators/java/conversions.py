"""The conversions between the application models and the tables (conversions/plan.py), written in Java: per table, a
final class of static methods, one that turns a model into what the service takes (its create DTO, or the entity) and
one that turns what it returns into the model. Values are converted between the model's Java types and the column's
(numbers of another size, text, dates and times, enums by a switch), so the project compiles; lookups go through the
repositories of the unit of work; Mapper's transformations are plain expressions; what the plan leaves to the user is
a `// TODO:` with the reason. Mirrors web/src/core/generators/java/conversions.ts.

Models are read and built as the application has them: records with `name()`, classes with getters or public fields,
filled with setters, a builder or a constructor. They are copied into the project (`settings.modelsModule` as their
package) or, with `modelsSource: import`, used from the user's package: the copy then goes to `application-models/`,
a source folder the build adds only while it exists (delete it inside the application)."""

import re

from ...conversions.plan import without_hidden
from ...js import js_string
from ..types import lines
from .context import column_of, errors_package, find_info, qualified, query, query_name
from .dtos import accessor, create_columns, create_dto, read_columns, read_dto
from .java import JavaImports, capitalized, java_path, java_string, member_name

_IDENTIFIER = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")

MODELS_FOLDER = "application-models"
"""The folder of the copy of the models when they are imported from the user's package."""


def field_name(name: str) -> str:
    """The Java name of a model field: its name, or its camelCase form when the name is not an identifier."""
    return name if _IDENTIFIER.match(name) else member_name(name)


def _uses_dtos(context: dict, info: dict) -> bool:
    settings = context["settings"]
    return (
        settings["services"]
        and settings["serviceTypes"] == "dtos"
        and info["service"] is not None
        and info["role"] == "entity"
    )


def service_plans(context: dict, plans: list[dict]) -> list[dict]:
    """The plans as the services serve them: a read DTO leaves out the hidden columns, so no field is read from them."""
    result = []
    for plan in plans:
        info = find_info(context, plan["table"])
        result.append(without_hidden(plan, info["hidden"]) if info and _uses_dtos(context, info) else plan)
    return result


def conversions_package(context: dict, info: dict) -> str:
    """The package of the conversions of a table, by architecture."""
    if context["settings"]["architecture"] == "table":
        return f"{context['base']}.{info['pkg']}"
    return f"{context['base']}.conversions"


def conversions_class(info: dict) -> str:
    return f"{info['entity']}Conversions"


def _lower_first(text: str) -> str:
    return text[:1].lower() + text[1:]


def conversion_names(context: dict, plan: dict) -> dict:
    """The names of a plan: its methods, the classes they take and return, and how the model is written (by its
    package when it is named like the entity or a DTO of the same file)."""
    info = find_info(context, plan["table"])
    dtos = _uses_dtos(context, info)
    target = create_dto(info) if dtos else info["entity"]
    source = read_dto(info) if dtos else info["entity"]
    clash = plan["model"] in (info["entity"], target, source)
    named = f"{plan['model']}Model" if clash else plan["model"]
    return {
        "write": f"{_lower_first(named)}To{target}",
        "read": f"{_lower_first(source)}To{named}",
        "target": target,
        "source": source,
        "model": f"{context['settings']['modelsModule']}.{plan['model']}" if clash else plan["model"],
        "clash": clash,
    }


# Types of the models

_KNOWN = {
    "BigDecimal": "java.math.BigDecimal",
    "BigInteger": "java.math.BigInteger",
    "LocalDate": "java.time.LocalDate",
    "LocalDateTime": "java.time.LocalDateTime",
    "LocalTime": "java.time.LocalTime",
    "OffsetDateTime": "java.time.OffsetDateTime",
    "OffsetTime": "java.time.OffsetTime",
    "Instant": "java.time.Instant",
    "ZonedDateTime": "java.time.ZonedDateTime",
    "Duration": "java.time.Duration",
    "UUID": "java.util.UUID",
    "List": "java.util.List",
    "Set": "java.util.Set",
    "Map": "java.util.Map",
}

_PRIMITIVE_JAVA = {
    "string": "String",
    "decimal": "BigDecimal",
    "boolean": "Boolean",
    "date": "LocalDate",
    "datetime": "OffsetDateTime",
    "time": "LocalTime",
    "duration": "Duration",
    "uuid": "UUID",
    "binary": "byte[]",
    "any": "Object",
}


def _type_ref_java(type_ref: dict) -> str:
    """The Java type of a model's TypeRef, for models of no language."""
    kind = type_ref["kind"]
    if kind == "primitive":
        name = type_ref["name"]
        bits = type_ref.get("bits")
        if name == "integer":
            return "Integer" if bits in (8, 16, 32) else "Long"
        if name == "float":
            return "Float" if bits == 32 else "Double"
        return _PRIMITIVE_JAVA[name]
    if kind == "array":
        return f"List<{_type_ref_java(type_ref['items'])}>"
    if kind == "map":
        return f"Map<String, {_type_ref_java(type_ref['value'])}>"
    if kind in ("model", "enum"):
        return type_ref["name"]
    return "Object"


def _simple(type_text: str) -> str:
    """`java.time.LocalDate` → `LocalDate`, in every part of a type."""
    return re.sub(r"\b(?:[a-z_]\w*\.)+(?=[A-Z])", "", type_text)


def _models(context: dict, schema: dict) -> dict:
    origin = schema.get("origin") or {}
    return {"schema": schema, "java": origin.get("language") == "java", "pkg": context["settings"]["modelsModule"]}


def _field_java(models: dict, field: dict) -> str:
    """The Java type of a field, as the model has it."""
    if models["java"] and field.get("originalType"):
        return _simple(field["originalType"])
    return _type_ref_java(field["type"])


def _style_of(models: dict, model: dict) -> tuple[str, str]:
    """How a model is read and built: its accessors and its construction."""
    if not models["java"]:
        return ("getters", "properties") if model.get("extends") else ("record", "positional")
    metadata = model.get("metadata") or {}
    accessors = metadata.get("accessors") or "getters"
    if accessors == "record":
        return accessors, "positional"
    return accessors, "builder" if metadata.get("builder") else "properties"


def _getter(models: dict, field: dict) -> str:
    prefix = "is" if _field_java(models, field) == "boolean" else "get"
    return f"{prefix}{capitalized(field_name(field['name']))}"


def _access(models: dict, model: dict, field: dict) -> str:
    """How a field of a model is read: `name()`, `getName()` or `name`."""
    style = _style_of(models, model)[0]
    if style == "record":
        return f"{field_name(field['name'])}()"
    if style == "fields":
        return field_name(field["name"])
    return f"{_getter(models, field)}()"


def _enum_constant(models: dict, value: dict) -> str:
    """The constant of an enum value in Java."""
    if models["java"]:
        return value["name"]
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", member_name(value["name"])).upper()


def _enum_text(value: dict) -> str:
    """The text an enum value is stored as."""
    return js_string(value["value"] if value.get("value") is not None else value["name"])


def _closure(schema: dict, names: list[str]) -> tuple[list[dict], list[dict]]:
    """The models and enums a set of models needs, in the order of the schema."""
    models: set[str] = set()
    enums: set[str] = set()

    def visit(type_ref: dict) -> None:
        if type_ref["kind"] == "array":
            visit(type_ref["items"])
        elif type_ref["kind"] == "map":
            visit(type_ref["value"])
        elif type_ref["kind"] == "enum":
            enums.add(type_ref["name"])
        elif type_ref["kind"] == "model":
            add(type_ref["name"])

    def add(name: str) -> None:
        model = next((item for item in schema["models"] if item["name"] == name), None)
        if model is None or name in models:
            return
        models.add(name)
        for parent in model.get("extends") or []:
            add(parent)
        for field in model["fields"]:
            visit(field["type"])

    for name in names:
        add(name)
    return (
        [model for model in schema["models"] if model["name"] in models],
        [item for item in schema["enums"] if item["name"] in enums],
    )


def _unique(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


def _imports_of_types(imports: JavaImports, types: list[str]) -> None:
    for type_text in types:
        for word in re.findall(r"\b[A-Z]\w*", type_text):
            if word in _KNOWN:
                imports.add(_KNOWN[word])


def _model_class(models: dict, model: dict) -> list[str]:
    """The class of a copied model, as the application has it."""
    accessors, construction = _style_of(models, model)
    fields = [
        {"type": _field_java(models, field), "name": field_name(field["name"]), "field": field}
        for field in model["fields"]
    ]
    doc = f"/** {model['name']}, as the application has it. */"
    if accessors == "record":
        if not fields:
            return [doc, f"public record {model['name']}() {{}}"]
        return [
            doc,
            f"public record {model['name']}(",
            *(
                f"        {item['type']} {item['name']}{',' if index < len(fields) - 1 else ''}"
                for index, item in enumerate(fields)
            ),
            ") {}",
        ]
    extended = f" extends {model['extends'][0]}" if model.get("extends") else ""
    visibility = "public" if accessors == "fields" else "private"
    body = [f"    {visibility} {item['type']} {item['name']};" for item in fields]
    if accessors == "getters":
        for item in fields:
            body += [
                "",
                f"    public {item['type']} {_getter(models, item['field'])}() {{",
                f"        return {item['name']};",
                "    }",
                "",
                f"    public void set{capitalized(item['name'])}({item['type']} {item['name']}) {{",
                f"        this.{item['name']} = {item['name']};",
                "    }",
            ]
    if construction == "builder":
        body += [
            "",
            "    public static Builder builder() {",
            "        return new Builder();",
            "    }",
            "",
            f"    /** Builds a {model['name']}, as Lombok's @Builder does. */",
            "    public static class Builder {",
            f"        private final {model['name']} built = new {model['name']}();",
        ]
        for item in fields:
            body += [
                "",
                f"        public Builder {item['name']}({item['type']} {item['name']}) {{",
                f"            built.{item['name']} = {item['name']};",
                "            return this;",
                "        }",
            ]
        body += ["", f"        public {model['name']} build() {{", "            return built;", "        }", "    }"]
    return [doc, f"public class {model['name']}{extended} {{", *body, "}"]


def model_files(context: dict, schema: dict, plans: list[dict]) -> list[dict]:
    """The copy of the application models the conversions use: a class or enum per file."""
    models = _models(context, schema)
    pkg = context["settings"]["modelsModule"]
    folder = "" if context["settings"]["modelsSource"] == "copy" else f"{MODELS_FOLDER}/"
    classes, enums = _closure(schema, _unique([plan["model"] for plan in plans]))

    def unit(name: str, imports: JavaImports, body: list[str]) -> dict:
        written = imports.write()
        content = lines(f"package {pkg};", "", written != "" and [written, ""], *body, "")
        return {"path": f"{folder}{java_path(pkg, name)}", "content": content}

    files = []
    for item in enums:
        constants = ", ".join(_enum_constant(models, value) for value in item["values"])
        files.append(
            unit(
                item["name"],
                JavaImports(pkg),
                [
                    f"/** {item['name']}, as the application has it. */",
                    f"public enum {item['name']} {{",
                    f"    {constants}",
                    "}",
                ],
            )
        )
    for model in classes:
        imports = JavaImports(pkg)
        _imports_of_types(imports, [_field_java(models, field) for field in model["fields"]])
        files.append(unit(model["name"], imports, _model_class(models, model)))
    return files


# Values

_BOXES = {
    "byte": "Byte",
    "short": "Short",
    "int": "Integer",
    "long": "Long",
    "float": "Float",
    "double": "Double",
    "boolean": "Boolean",
    "char": "Character",
}
_PRIMITIVE_OF = {box: primitive for primitive, box in _BOXES.items()}
_NUMBERS = {"Byte", "Short", "Integer", "Long", "Float", "Double", "BigDecimal", "BigInteger"}
_TEMPORAL = {"LocalDate", "LocalDateTime", "LocalTime", "OffsetDateTime", "OffsetTime", "Instant", "ZonedDateTime"}
_PARSE = {
    "Byte": "Byte.valueOf",
    "Short": "Short.valueOf",
    "Integer": "Integer.valueOf",
    "Long": "Long.valueOf",
    "Float": "Float.valueOf",
    "Double": "Double.valueOf",
    "Boolean": "Boolean.valueOf",
}


def _is_primitive(type_text: str) -> bool:
    return type_text in _BOXES


def _boxed(type_text: str) -> str:
    return _BOXES.get(type_text, type_text)


def _typed(expression: str, type_text: str, present: bool = False) -> dict:
    return {"expression": expression, "type": type_text, "present": present}


def _temporal(expression: str, source: str, target: str, body: dict) -> str | None:
    """The conversion of a non-null value from one temporal type to another, or None."""

    def utc() -> str:
        body["imports"].add("java.time.ZoneOffset")
        return "ZoneOffset.UTC"

    def instant() -> str | None:
        if source == "Instant":
            return expression
        if source in ("OffsetDateTime", "ZonedDateTime"):
            return f"{expression}.toInstant()"
        if source == "LocalDateTime":
            return f"{expression}.toInstant({utc()})"
        if source == "LocalDate":
            return f"{expression}.atStartOfDay().toInstant({utc()})"
        return None

    if source == "OffsetDateTime" and target == "LocalDateTime":
        return f"{expression}.toLocalDateTime()"
    if source == "LocalDateTime" and target == "LocalDate":
        return f"{expression}.toLocalDate()"
    if source == "OffsetDateTime" and target == "LocalDate":
        return f"{expression}.toLocalDate()"
    if source == "LocalDate" and target == "LocalDateTime":
        return f"{expression}.atStartOfDay()"
    if source == "OffsetTime" and target == "LocalTime":
        return f"{expression}.toLocalTime()"
    if source == "LocalTime" and target == "OffsetTime":
        return f"{expression}.atOffset({utc()})"
    moment = instant()
    if moment is None:
        return None
    if target in _KNOWN:
        body["imports"].add(_KNOWN[target])
    if target == "Instant":
        return moment
    if target == "OffsetDateTime":
        return f"{expression}.atOffset({utc()})" if source == "LocalDateTime" else f"{moment}.atOffset({utc()})"
    if target == "ZonedDateTime":
        return f"{moment}.atZone({utc()})"
    if target == "LocalDateTime":
        return f"LocalDateTime.ofInstant({moment}, {utc()})"
    if target == "LocalDate":
        return f"LocalDate.ofInstant({moment}, {utc()})"
    return None


def _convert(models: dict, value: dict, target_type: str, body: dict) -> str | None:
    """A value of one Java type as another, or None when DB2CRUD does not convert them. A value that may be null
    stays null."""
    expression = value["expression"]
    source_type = value["type"]
    present = value.get("present") or _is_primitive(source_type) or _is_primitive(target_type)
    if source_type == target_type or target_type == "Object" or _boxed(source_type) == _boxed(target_type):
        return expression

    def guard(converted: str) -> str:
        # A value that may be null is converted only when it is there
        return converted if present else f"{expression} == null ? null : {converted}"

    from_enum = next((item for item in models["schema"]["enums"] if item["name"] == source_type), None)
    to_enum = next((item for item in models["schema"]["enums"] if item["name"] == target_type), None)
    if from_enum and target_type == "String":
        cases = " ".join(
            f"case {_enum_constant(models, item)} -> {java_string(_enum_text(item))};" for item in from_enum["values"]
        )
        return guard(f"switch ({expression}) {{ {cases} }}")
    if to_enum:
        body["imports"].add(f"{models['pkg']}.{target_type}")
    if to_enum and source_type == "String":
        cases = " ".join(
            f"case {java_string(_enum_text(item))} -> {target_type}.{_enum_constant(models, item)};"
            for item in to_enum["values"]
        )
        message = f'"No {target_type} for this value"' if present else f'"No {target_type} for " + {expression}'
        return guard(f"switch ({expression}) {{ {cases} default -> throw new IllegalArgumentException({message}); }}")
    source = _boxed(source_type)
    target = _boxed(target_type)
    if source in _NUMBERS and target in _NUMBERS:
        if target == "BigDecimal":
            body["imports"].add("java.math.BigDecimal")
            return guard(
                f"new BigDecimal({expression})" if source == "BigInteger" else f"BigDecimal.valueOf({expression})"
            )
        if target == "BigInteger":
            body["imports"].add("java.math.BigInteger")
            return guard(
                f"{expression}.toBigInteger()" if source == "BigDecimal" else f"BigInteger.valueOf({expression})"
            )
        primitive = _PRIMITIVE_OF[target]
        if _is_primitive(source_type):
            return guard(f"({primitive}) {expression}")
        return guard(f"{expression}.{primitive}Value()")
    if target == "String":
        if _is_primitive(source_type):
            return f"String.valueOf({expression})"
        return guard(f"{expression}.toPlainString()" if source_type == "BigDecimal" else f"{expression}.toString()")
    if source == "String":
        if target in _PARSE:
            return guard(f"{_PARSE[target]}({expression})")
        if target in ("BigDecimal", "BigInteger"):
            body["imports"].add(_KNOWN[target])
            return guard(f"new {target}({expression})")
        if target == "UUID":
            body["imports"].add("java.util.UUID")
            return guard(f"UUID.fromString({expression})")
        if target in _TEMPORAL:
            body["imports"].add(_KNOWN[target])
            return guard(f"{target}.parse({expression})")
        return None
    if source in _TEMPORAL and target in _TEMPORAL:
        converted = _temporal(expression, source, target, body)
        return None if converted is None else guard(converted)
    return None


def _literal(value) -> dict:
    """A Java literal of a Mapper constant, with its type."""
    if value is None:
        return _typed("null", "Object")
    if isinstance(value, str):
        return _typed(java_string(value), "String", True)
    if isinstance(value, bool):
        return _typed("true" if value else "false", "boolean")
    if isinstance(value, int) or (isinstance(value, float) and value.is_integer()):
        return _typed(f"{js_string(value)}L", "long", True)
    return _typed(js_string(value), "double", True)


_INVERSE = {"*": "/", "/": "*", "+": "-", "-": "+"}


def _inverse(transform: dict) -> dict:
    """The transformation that undoes an invertible one."""
    if transform["kind"] == "arithmetic":
        return {**transform, "operator": _INVERSE[transform["operator"]]}
    if transform["kind"] == "enum":
        return {"kind": "enum", "pairs": [{"from": pair["to"], "to": pair["from"]} for pair in transform["pairs"]]}
    return transform


def _transformed(models: dict, transform: dict, values: list[dict], target: str, body: dict) -> dict | None:
    """A Mapper transformation of typed values, as an expression of the type it gives; None when it cannot be
    written."""
    value = values[0]
    kind = transform["kind"]
    if kind == "direct":
        return value
    if kind == "concat":
        parts = ", ".join(f"String.valueOf({item['expression']})" for item in values)
        return _typed(f"String.join({java_string(transform['separator'])}, {parts})", "String", True)
    if kind == "split":
        separator = java_string(transform["separator"])
        if transform["part"] == "rest":
            body["helpers"].add("rest")
            return _typed(f"rest({value['expression']}, {separator})", "String", True)
        body["helpers"].add("part")
        part = -1 if transform["part"] == "last" else transform["part"]
        return _typed(f"part({value['expression']}, {separator}, {part})", "String", True)
    if kind == "constant":
        return _literal(transform["value"])
    if kind == "boolean":
        body["imports"].add("java.util.List")
        items = ", ".join(java_string(item) for item in transform["trueValues"])
        return _typed(f"List.of({items}).contains(String.valueOf({value['expression']}))", "boolean", True)
    if kind == "enum":
        body["helpers"].add("pair")
        body["imports"].add("java.util.Map")
        pairs = ", ".join(
            f"Map.entry({java_string(pair['from'])}, {java_string(pair['to'])})" for pair in transform["pairs"]
        )
        fallback = java_string(transform["fallback"]) if transform.get("fallback") is not None else "null"
        return _typed(f"pair(Map.ofEntries({pairs}), {value['expression']}, {fallback})", "String", True)
    if kind == "epoch":
        milliseconds = transform["unit"] == "milliseconds"
        # From a date and time: a number; from a number: an instant
        if _boxed(target) in _NUMBERS or target == "String":
            moment = _convert(models, {**value, "present": True}, "Instant", body)
            if moment is None:
                return None
            return _typed(f"{moment}.{'toEpochMilli()' if milliseconds else 'getEpochSecond()'}", "long", True)
        number = _convert(models, {**value, "present": True}, "long", body)
        if number is None:
            return None
        body["imports"].add("java.time.Instant")
        return _typed(f"Instant.{'ofEpochMilli' if milliseconds else 'ofEpochSecond'}({number})", "Instant", True)
    if kind == "arithmetic":
        number = _convert(models, {**value, "present": True}, "double", body)
        if number is None:
            return None
        operand = re.sub(r"L$", "", _literal(transform["operand"])["expression"])
        return _typed(f"({number} {transform['operator']} {operand})", "double", True)
    return None


def _fit(models: dict, result: dict, target: str, body: dict) -> str | None:
    """A typed value as the type a column or field has: whole numbers rounded, then converted."""
    whole = _boxed(target) in ("Byte", "Short", "Integer", "Long", "BigInteger")
    if whole and result["type"] in ("double", "float"):
        result = _typed(f"Math.round({result['expression']})", "long", True)
    return _convert(models, result, target, body)


# Conversions

_WHY = {
    "pending": "the matching waits for review",
    "noField": "no field of the model gives it",
    "oneWay": "Mapper's relation only goes the other way",
    "unsupported": "DB2CRUD does not write this conversion",
    "hidden": "the service never returns it",
}


def _todo_text(todo: dict) -> str:
    detail = f" ({todo['detail']})" if todo.get("detail") else ""
    return f"{_WHY[todo['reason']]}{detail}"


def _article(name: str) -> str:
    """`A Customer`, `An Order`."""
    return f"{'An' if re.match(r'[AEIOU]', name, re.IGNORECASE) else 'A'} {name}"


def _missing(type_text: str) -> str:
    """The default of a value left out of a constructor."""
    if not _is_primitive(type_text):
        return "null"
    return {"boolean": "false", "char": "'\\0'", "float": "0f", "double": "0d", "long": "0L"}.get(type_text, "0")


def _argument_lines(values: list[dict], indent: str) -> list[str]:
    """The arguments of a call, one per line, with their comments."""
    result = []
    for index, value in enumerate(values):
        comma = "," if index < len(values) - 1 else ""
        todo = f" // TODO: {value['name']}: {value['todo']}" if value.get("todo") else ""
        result.append(f"{indent}{value['expression']}{comma}{todo}")
    return result


def _walk(models: dict, model: dict | None, path: list[str], root: str) -> dict | None:
    """The field of a model a path names, with how it is read, walking nested models."""
    current = model
    expression = root
    type_text = "Object"
    for part in path:
        field = next((item for item in current["fields"] if item["name"] == part), None) if current else None
        if current is None or field is None:
            return None
        expression = f"{expression}.{_access(models, current, field)}"
        type_text = _field_java(models, field)
        current = (
            next((item for item in models["schema"]["models"] if item["name"] == field["type"]["name"]), None)
            if field["type"]["kind"] == "model"
            else None
        )
    return _typed(expression, type_text)


def _write_expression(context: dict, models: dict, column: dict, value: dict, model: dict | None, body: dict) -> dict:
    def unsupported(detail: str) -> dict:
        return {"expression": "null", "todo": f"{_WHY['unsupported']} ({detail})"}

    def typed(path: list[str]) -> dict | None:
        return _walk(models, model, path, "model")

    def finish(result: dict | None) -> dict:
        if result is None:
            return unsupported(column["prop"])
        converted = _fit(models, result, column["java"], body)
        if converted is None:
            return unsupported(f"{result['type']} to {column['java']}")
        return {"expression": converted}

    kind = value["kind"]
    if kind == "field":
        return finish(typed(value["path"]))
    if kind == "lookup":
        other = find_info(context, value["table"])
        finder = query(other, "findByUnique", [value["by"]]) if other else None
        given = typed(value["path"])
        if not other or not finder or not given:
            return {"expression": "null", "todo": "no repository query finds the row it names"}
        by = column_of(other, value["by"])
        argument = _convert(models, given, by["java"], body)
        if argument is None:
            return unsupported(f"{given['type']} to {by['java']}")
        name = member_name(other["entity"])
        body["uow"] = True
        body["imports"].add(
            qualified(context, other, "entity", other["entity"]), f"{errors_package(context)}.NotFoundException"
        )
        body["lines"] += [
            f"{other['entity']} {name} = uow.{other['attr']}().{query_name(context, finder)}({argument})",
            f"        .orElseThrow(() -> new NotFoundException({java_string(other['entity'])}, {given['expression']}));",
        ]
        key = column_of(other, value["key"])
        return finish(_typed(f"{name}.{key['getter']}()", key["java"]))
    if kind == "mapper":
        sources = [typed(path) for path in value["sources"]]
        if any(item is None for item in sources):
            return unsupported(column["prop"])
        return finish(_transformed(models, value["transform"], sources, column["java"], body))
    source = typed(value["path"])
    return finish(source and _transformed(models, _inverse(value["transform"]), [source], column["java"], body))


def _read_expression(context: dict, models: dict, info: dict, dtos: bool, field: dict, value: dict, body: dict) -> dict:
    target = _field_java(models, field)

    def read(other: dict, name: str, root: str, entity: bool | None = None) -> dict:
        column = column_of(other, name)
        is_entity = (not dtos or other is not info) if entity is None else entity
        member = f"{column['getter']}()" if is_entity else accessor(context, column["prop"])
        return _typed(f"{root}.{member}", column["java"])

    def unsupported(detail: str) -> dict:
        return {"expression": _missing(target), "todo": f"{_WHY['unsupported']} ({detail})"}

    def finish(result: dict | None) -> dict:
        if result is None:
            return unsupported(field["name"])
        converted = _fit(models, result, target, body)
        if converted is None:
            return unsupported(f"{result['type']} to {target}")
        return {"expression": converted}

    kind = value["kind"]
    if kind == "column":
        return finish(read(info, value["column"], "row"))
    if kind == "lookup":
        other = find_info(context, value["table"])
        finder = (query(other, "getByKey") or query(other, "findByUnique", [value["key"]])) if other else None
        if not other or not finder:
            return {"expression": _missing(target), "todo": "no repository query reads it"}
        name = member_name(other["entity"])
        own = read(info, value["column"], "row")
        nullable = column_of(info, value["column"])["column"]["nullable"]
        body["uow"] = True
        body["imports"].add(qualified(context, other, "entity", other["entity"]))
        found = f"uow.{other['attr']}().{query_name(context, finder)}({own['expression']})"
        body["lines"].append(
            f"{other['entity']} {name} = {own['expression']} == null ? null : {found}.orElse(null);"
            if nullable
            else f"{other['entity']} {name} = {found}.orElseThrow();"
        )
        result = finish(read(other, value["by"], name, True))
        if nullable and not result.get("todo"):
            return {"expression": f"{name} == null ? null : {result['expression']}"}
        return result
    if kind == "children":
        other = find_info(context, value["table"])
        lister = (
            (query(other, "listByParent", [value["by"]]) or query(other, "findAllBy", [value["by"]])) if other else None
        )
        if not other or not lister:
            return {"expression": _missing(target), "todo": "no repository query reads it"}
        body["uow"] = True
        item = read(other, value["value"], "item", True)
        found = re.match(r"^(?:List|Set|Collection)<(.+)>$", target)
        element = found.group(1) if found else item["type"]
        converted = _convert(models, item, element, body)
        if converted is None:
            return unsupported(f"{item['type']} to {element}")
        key = read(info, value["key"], "row")
        listed = f"uow.{other['attr']}().{query_name(context, lister)}({key['expression']}).stream().map(item -> {converted})"
        if target.startswith("Set<"):
            body["imports"].add("java.util.stream.Collectors")
            return {"expression": f"{listed}.collect(Collectors.toSet())"}
        return {"expression": f"{listed}.toList()"}
    if kind == "mapper":
        columns = [read(info, column, "row") for column in value["columns"]]
        return finish(_transformed(models, value["transform"], columns, target, body))
    inverse = _transformed(models, _inverse(value["transform"]), [read(info, value["column"], "row")], target, body)
    return finish(inverse)


_HELPERS = {
    "pair": [
        "/** The value an enum pair gives, or the fallback; a value without a pair is an error. */",
        "private static String pair(Map<String, String> pairs, Object value, String fallback) {",
        "    String found = pairs.getOrDefault(String.valueOf(value), fallback);",
        '    if (found == null) throw new IllegalArgumentException("No pair for " + value);',
        "    return found;",
        "}",
    ],
    "part": [
        "/** One part of a text split by a separator (the last one for -1), or an empty text. */",
        "private static String part(Object value, String separator, int index) {",
        "    String[] parts = String.valueOf(value).split(Pattern.quote(separator), -1);",
        "    int at = index < 0 ? parts.length - 1 : index;",
        '    return at < parts.length ? parts[at] : "";',
        "}",
    ],
    "rest": [
        "/** What follows the first separator of a text, or an empty text. */",
        "private static String rest(Object value, String separator) {",
        "    String text = String.valueOf(value);",
        "    int at = text.indexOf(separator);",
        '    return at < 0 ? "" : text.substring(at + separator.length());',
        "}",
    ],
}


def _todo_comment(value: dict) -> str:
    return f" // TODO: {value['name']}: {value['todo']}" if value.get("todo") else ""


def conversion_file(context: dict, plans: list[dict], schema: dict) -> dict | None:
    """The class of the conversions of one table: one method per direction its models go."""
    info = find_info(context, plans[0]["table"])
    if info is None:
        return None
    models = _models(context, schema)
    pkg = conversions_package(context, info)
    imports = JavaImports(pkg)
    helpers: set[str] = set()
    methods: list[list[str]] = []
    dtos = _uses_dtos(context, info)
    for plan in plans:
        model = next((item for item in schema["models"] if item["name"] == plan["model"]), None)
        names = conversion_names(context, plan)
        if not names["clash"]:
            imports.add(f"{context['settings']['modelsModule']}.{plan['model']}")
        if plan["write"] is not None:
            body = {"lines": [], "uow": False, "imports": imports, "helpers": helpers}
            values = []
            for item in plan["write"]:
                column = column_of(info, item["column"])
                if item["value"]["kind"] == "todo":
                    values.append({"name": column["prop"], "expression": "null", "todo": _todo_text(item["value"])})
                else:
                    written = _write_expression(context, models, column, item["value"], model, body)
                    values.append({"name": column["prop"], **written})
            params = f"{names['model']} model{', UnitOfWork uow' if body['uow'] else ''}"
            if body["uow"]:
                imports.add(f"{context['base']}.UnitOfWork")
            if dtos:
                imports.add(qualified(context, info, "dtos", names["target"]))
                # Every value of the create DTO, in its order; those the model does not give are null
                every = [
                    next(
                        (value for value in values if value["name"] == column["prop"]),
                        {"name": column["prop"], "expression": "null"},
                    )
                    for column in create_columns(info)
                ]
                result = [
                    f"        return new {names['target']}(",
                    *_argument_lines(every, "                "),
                    "        );",
                ]
            else:
                imports.add(qualified(context, info, "entity", info["entity"]))
                result = [f"        {info['entity']} entity = new {info['entity']}();"]
                for value in values:
                    setter = next(column for column in info["columns"] if column["prop"] == value["name"])["setter"]
                    result.append(f"        entity.{setter}({value['expression']});{_todo_comment(value)}")
                result.append("        return entity;")
            methods.append(
                [
                    f"    /** {_article(plan['model'])} as the {info['name']} table takes it. */",
                    f"    public static {names['target']} {names['write']}({params}) {{",
                    *(f"        {line}" for line in body["lines"]),
                    *result,
                    "    }",
                ]
            )
        if plan["read"] is not None and model is not None:
            body = {"lines": [], "uow": False, "imports": imports, "helpers": helpers}
            values = []
            for field in model["fields"]:
                item = next((candidate for candidate in plan["read"] if candidate["field"] == field["name"]), None)
                name = field_name(field["name"])
                if item is None:
                    values.append({"name": name, "expression": _missing(_field_java(models, field))})
                elif item["value"]["kind"] == "todo":
                    values.append(
                        {
                            "name": name,
                            "expression": _missing(_field_java(models, field)),
                            "todo": _todo_text(item["value"]),
                        }
                    )
                else:
                    read = _read_expression(context, models, info, dtos, field, item["value"], body)
                    values.append({"name": name, **read})
            given = {field_name(item["field"]) for item in plan["read"]}
            imports.add(
                qualified(context, info, "dtos", names["source"])
                if dtos
                else qualified(context, info, "entity", info["entity"])
            )
            if body["uow"]:
                imports.add(f"{context['base']}.UnitOfWork")
            params = f"{names['source']} row{', UnitOfWork uow' if body['uow'] else ''}"
            accessors, construction = _style_of(models, model)
            if construction == "positional":
                result = [
                    f"        return new {names['model']}(",
                    *_argument_lines(values, "                "),
                    "        );",
                ]
            else:
                # Built by its properties: the fields the plan does not give keep the model's defaults
                chosen = [value for value in values if value["name"] in given]
                if construction == "builder":
                    result = [
                        f"        return {names['model']}.builder()",
                        *(
                            f"                .{value['name']}({value['expression']}){_todo_comment(value)}"
                            for value in chosen
                        ),
                        "                .build();",
                    ]
                else:
                    result = [f"        {names['model']} model = new {names['model']}();"]
                    for value in chosen:
                        if accessors == "fields":
                            result.append(
                                f"        model.{value['name']} = {value['expression']};{_todo_comment(value)}"
                            )
                        else:
                            setter = f"set{capitalized(value['name'])}"
                            result.append(f"        model.{setter}({value['expression']});{_todo_comment(value)}")
                    result.append("        return model;")
            article = _article(plan["model"]).split(" ")[0].lower()
            methods.append(
                [
                    f"    /** A row of the {info['name']} table as {article} {plan['model']}. */",
                    f"    public static {names['model']} {names['read']}({params}) {{",
                    *(f"        {line}" for line in body["lines"]),
                    *result,
                    "    }",
                ]
            )
    if "part" in helpers:
        imports.add("java.util.regex.Pattern")
    helper_blocks = [[f"    {line}" for line in _HELPERS[name]] for name in ("pair", "part", "rest") if name in helpers]
    name = conversions_class(info)
    written = imports.write()
    content = lines(
        f"package {pkg};",
        "",
        written != "" and [written, ""],
        f'/** Conversions between the application models and the "{info["name"]}" table: what the service takes and'
        " returns. */",
        f"public final class {name} {{",
        f"    private {name}() {{}}",
        *[line for block in [*methods, *helper_blocks] for line in ("", *block)],
        "}",
        "",
    )
    return {"path": java_path(pkg, name), "content": content}


def _has_todo(items: list[dict] | None) -> bool:
    return any(item["value"]["kind"] == "todo" for item in items or [])


def conversion_test_file(context: dict, plans: list[dict], schema: dict, can_make) -> dict | None:
    """The tests of the conversions: a row stored by the factories is read as the model, and a model that goes both
    ways and leaves nothing to the user is written back, giving every value of the row (lookups and Mapper's
    lossless transformations included)."""
    pkg = context["base"]
    imports = (
        JavaImports(pkg)
        .add("org.junit.jupiter.api.Test")
        .add_static("org.junit.jupiter.api.Assertions.assertEquals", "org.junit.jupiter.api.Assertions.assertNotNull")
    )
    memory = context["settings"]["memoryRepositories"]
    caller = context["settings"]["transactions"] == "caller"
    tests: list[list[str]] = []
    readers: dict[str, list[str]] = {}
    for plan in plans:
        info = find_info(context, plan["table"])
        if (
            not info
            or plan["read"] is None
            or _has_todo(plan["read"])
            or not can_make(info)
            or not any(item["name"] == plan["model"] for item in schema["models"])
        ):
            continue
        names = conversion_names(context, plan)
        dtos = _uses_dtos(context, info)
        reads = any(item["value"]["kind"] in ("lookup", "children") for item in plan["read"])
        writes = plan["write"] is not None and not _has_todo(plan["write"])
        write_uow = writes and any(item["value"]["kind"] == "lookup" for item in plan["write"])
        conversions = f"{conversions_package(context, info)}.{conversions_class(info)}"
        imports.add(conversions, qualified(context, info, "entity", info["entity"]))
        reader = f"{_lower_first(names['source'])}Of"
        row = f"{reader}(row)" if dtos else "row"
        if dtos and info["name"] not in readers:
            imports.add(qualified(context, info, "dtos", names["source"]))
            getters = ", ".join(f"entity.{column['getter']}()" for column in read_columns(info))
            readers[info["name"]] = [
                "    /** The row as the service returns it. */",
                f"    private static {names['source']} {reader}({info['entity']} entity) {{",
                f"        return new {names['source']}({getters});",
                "    }",
            ]
        klass = conversions_class(info)
        body = [
            f"{info['entity']} row = Factories.add{info['entity']}(uow, 1);",
            f"var model = {klass}.{names['read']}({row}{', uow' if reads else ''});",
        ]
        if writes:
            body.append(f"var values = {klass}.{names['write']}(model{', uow' if write_uow else ''});")
            for item in plan["write"]:
                column = column_of(info, item["column"])
                given = accessor(context, column["prop"]) if dtos else f"{column['getter']}()"
                body.append(f"assertEquals(row.{column['getter']}(), values.{given});")
        else:
            body.append("assertNotNull(model);")
        method = f"reads{plan['model']}AndWritesItBack" if writes else f"reads{plan['model']}"
        tests.append(["", "    @Test", f"    void {method}() {{", *(f"        {line}" for line in body), "    }"])
    if not tests:
        return None
    if not memory:
        imports.add(
            "jakarta.persistence.EntityManager", "org.junit.jupiter.api.AfterEach", "org.junit.jupiter.api.BeforeEach"
        )
    setup = (
        "    private final MemoryUnitOfWork uow = new MemoryUnitOfWork();"
        if memory
        else [
            "    private EntityManager entityManager;",
            "    /** The repositories over the test database, opened empty for every test */",
            "    private SqlUnitOfWork uow;",
            "",
            "    @BeforeEach",
            "    void open() {",
            "        entityManager = TestDatabase.open();",
            caller and "        // The caller owns the transaction: the test opens it, and rolls it back at the end",
            caller and "        entityManager.getTransaction().begin();",
            "        uow = new SqlUnitOfWork(entityManager);",
            "    }",
            "",
            "    @AfterEach",
            "    void close() {",
            "        if (entityManager.getTransaction().isActive()) entityManager.getTransaction().rollback();",
            "        entityManager.close();",
            "    }",
        ]
    )
    content = lines(
        f"package {pkg};",
        "",
        imports.write(),
        "",
        "/** Tests of the conversions between the application models and the tables. */",
        "class ConversionsTest {",
        setup,
        *[line for test in tests for line in test],
        *[line for block in readers.values() for line in ("", *block)],
        "}",
        "",
    )
    return {"path": java_path(pkg, "ConversionsTest", True), "content": content}


def conversion_files(context: dict, schema: dict, plans: list[dict]) -> list[dict]:
    """The conversion classes of a project and the copy of the models they use."""
    files = []
    for table in _unique([plan["table"] for plan in plans]):
        file = conversion_file(context, [plan for plan in plans if plan["table"] == table], schema)
        if file is not None:
            files.append(file)
    if not files:
        return files
    return [*files, *model_files(context, schema, plans)]
