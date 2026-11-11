"""What the input already says about persistence: keys, relations, uniqueness and sizes declared with
annotations, decorators or schema attributes. Mirrors web/src/core/design/hints.ts."""

import re

from ..parsers.code.annotations import annotation_arg


def _simple(name: str) -> str:
    last = re.split(r"\.|::|\\", name)[-1]
    return re.sub(r"Attribute$", "", last).lower()


def _annotations(item: dict) -> list[dict]:
    return item.get("annotations") or []


def _find(item: dict, names: tuple[str, ...]) -> dict | None:
    return next((annotation for annotation in _annotations(item) if _simple(annotation["name"]) in names), None)


def _arg_is_true(annotation: dict, name: str) -> bool:
    return re.search(rf"(?:^|[\s,({{]){name}\s*[:=]\s*(true|True)\b", annotation.get("args") or "") is not None


_KEY_ANNOTATIONS = (
    "id",
    "key",
    "primarykey",
    "primarycolumn",
    "primarygeneratedcolumn",
    "objectidcolumn",
    "embeddedid",
)


def declares_key(field: dict) -> bool:
    if (field.get("metadata") or {}).get("primaryKey") is True:
        return True
    if _find(field, _KEY_ANNOTATIONS):
        return True
    return any(_arg_is_true(item, "primary_key") or _arg_is_true(item, "primary") for item in _annotations(field))


def declares_unique(field: dict) -> bool:
    if (field.get("metadata") or {}).get("unique") is True:
        return True
    if _find(field, ("unique",)):
        return True
    return any(_arg_is_true(item, "unique") or _arg_is_true(item, "IsUnique") for item in _annotations(field))


_RELATIONS = {
    "manytoone": "manyToOne",
    "foreignkey": "manyToOne",
    "onetoone": "oneToOne",
    "onetoonefield": "oneToOne",
    "onetomany": "oneToMany",
    "manytomany": "manyToMany",
    "manytomanyfield": "manyToMany",
    "embedded": "embedded",
    "embeddedid": "embedded",
    "elementcollection": "elementCollection",
}


def declares_uuid_default(field: dict) -> bool:
    """A text filled with a new UUID: Prisma's `@default(uuid())`, JPA's `@GeneratedValue(strategy =
    GenerationType.UUID)` and Hibernate's `@UuidGenerator`."""
    for annotation in _annotations(field):
        name = _simple(annotation["name"])
        args = annotation.get("args") or ""
        if name == "default" and re.match(r"\s*uuid\(", args):
            return True
        if name == "generatedvalue" and re.search(r"\bGenerationType\.UUID\b", args):
            return True
        if name == "uuidgenerator":
            return True
    return False


def declared_relation(field: dict) -> str | None:
    for annotation in _annotations(field):
        relation = _RELATIONS.get(_simple(annotation["name"]))
        if relation:
            return relation
        if _simple(annotation["name"]) == "relation" and re.search(r"fields\s*:", annotation.get("args") or ""):
            return "manyToOne"
    return None


def declares_embeddable(model: dict) -> bool:
    return _find(model, ("embeddable", "owned", "complextype")) is not None


def _positive_int(value) -> int | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return int(number) if number.is_integer() and number > 0 else None


def declared_length(field: dict) -> int | None:
    for annotation in _annotations(field):
        name = _simple(annotation["name"])
        args = annotation.get("args") or ""
        typed = re.search(r"\b(?:String|VARCHAR|VarChar|Varchar|CHAR|Char)\((\d+)\)", args)
        if typed:
            return int(typed.group(1))
        named = (
            annotation_arg(annotation, "length")
            or annotation_arg(annotation, "max_length")
            or annotation_arg(annotation, "max")
        )
        if named is None and name in ("maxlength", "stringlength", "varchar", "char", "string", "length", "db.varchar"):
            match = re.match(r"^\s*(\d+)", args)
            named = match.group(1) if match else None
        length = _positive_int(named)
        if length:
            return length
    return None


def declared_precision(field: dict) -> dict | None:
    for annotation in _annotations(field):
        name = _simple(annotation["name"])
        precision = _positive_int(annotation_arg(annotation, "precision") or annotation_arg(annotation, "max_digits"))
        scale_text = annotation_arg(annotation, "scale") or annotation_arg(annotation, "decimal_places") or "0"
        try:
            scale = float(scale_text)
        except ValueError:
            scale = float("nan")
        if precision and scale == scale and scale.is_integer():
            return {"precision": precision, "scale": int(scale)}
        if name in ("numeric", "decimal", "precision"):
            match = re.match(r"^\s*(\d+)\s*,\s*(\d+)", annotation.get("args") or "")
            if match:
                return {"precision": int(match.group(1)), "scale": int(match.group(2))}
    return None
