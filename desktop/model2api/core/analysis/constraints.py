"""Validations declared on a field, read from what the input already says: annotations and decorators (Jakarta
Bean Validation, class-validator, DataAnnotations, Symfony Validator, Laravel Data, Pydantic, Django, JPA,
SQLAlchemy, Prisma, Zod checks, Go `validate` tags, Laravel rules) and JSON Schema keywords. Nothing is inferred
from names or examples. Mirrors web/src/core/analysis/constraints.ts.

Each notation is a reader (Strategy pattern) in READERS. To support a new one, write a reader that turns one
annotation into raw bounds and add it to the list; the normalization does the rest.

Constraints are dictionaries with JSON Schema names (minLength, maxLength, minimum, maximum, exclusiveMinimum,
exclusiveMaximum, pattern, format, minItems, maxItems). While they are built, None stands for a key without a
value, as undefined does on the web, so keys keep the order in which the web version creates them.
"""

import json
import re
from collections.abc import Callable

from ..js import is_number, js_string, number, trim
from ..model.schema import FieldDef, TypeRef

Constraints = dict
RawBounds = dict
# A notation's reader: one annotation, its simple lower-case name, and the language of the input when known (a
# name can mean different things in different languages)
Reader = Callable[[dict, str, str | None], RawBounds | None]

_PREFIX = re.compile(r"^[a-z]+:")
_SEPARATORS = re.compile(r"\.|::|\\")
_ATTRIBUTE = re.compile(r"Attribute$")


def _simple_name(name: str) -> str:
    """Size, javax.validation.constraints.Size, field:Size, MaxLengthAttribute → size, maxlength."""
    return _ATTRIBUTE.sub("", _SEPARATORS.split(_PREFIX.sub("", name, count=1))[-1], count=1).lower()


def _split_args(args: str | None) -> list[str]:
    """Argument texts of an annotation, split on top-level commas."""
    if not args or not trim(args):
        return []
    parts: list[str] = []
    depth = 0
    quote: str | None = None
    current = ""
    index = 0
    while index < len(args):
        char = args[index]
        if quote:
            if char == "\\":
                current += char + (args[index + 1] if index + 1 < len(args) else "")
                index += 2
                continue
            if char == quote:
                quote = None
        elif char in "\"'`":
            quote = char
        elif char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        elif char == "," and depth == 0:
            parts.append(trim(current))
            current = ""
            index += 1
            continue
        current += char
        index += 1
    if trim(current):
        parts.append(trim(current))
    return parts


_OPTIONS_OBJECT = re.compile(r"^\{([\s\S]*)\}$")
_NAMED = re.compile(r"^([A-Za-z_]\w*)\s*[=:]\s*([\s\S]+)$", re.ASCII)
_QUOTE_START = re.compile(r"^[\"'`/]")


def _read_args(annotation: dict) -> tuple[dict[str, str], list[str]]:
    """Named arguments (min = 3, max_length=80, MinimumLength = 2) by lower-case name, and positional ones."""
    named: dict[str, str] = {}
    positional: list[str] = []
    parts = _split_args(annotation.get("args"))
    # An options object (@Column({ length: 80 }), TypeORM and class-validator) holds the named arguments
    only = _OPTIONS_OBJECT.match(parts[0]) if len(parts) == 1 else None
    for part in _split_args(only.group(1)) if only else parts:
        match = _NAMED.match(part)
        if match and not _QUOTE_START.match(part):
            named[match.group(1).lower()] = trim(match.group(2))
        else:
            positional.append(part)
    return named, positional


_QUOTES = re.compile(r"^[\"'`]|[\"'`]$")
_SUFFIX = re.compile(r"[lLfFdDmM]$")
_DECIMAL = re.compile(r"^-?\d+(\.\d+)?([eE][-+]?\d+)?$", re.ASCII)


def _to_number(text: str | None) -> int | float | None:
    """A number written in code: 3, -1.5, "9999.99", 100L, 1_000."""
    if text is None:
        return None
    cleaned = _SUFFIX.sub("", _QUOTES.sub("", trim(text)).replace("_", ""), count=1)
    if not _DECIMAL.match(cleaned):
        return None
    return number(cleaned)


_STRING_LITERAL = re.compile(r"^(?:[rR]|@)?([\"'`])([\s\S]*)\1$")
_RAW_PREFIX = re.compile(r"^[rR@]")


def _to_text(text: str | None) -> str | None:
    """The text of a string literal ("^[A-Z]+$", r"\\d+", @"\\d+"), unescaped as the language would."""
    if text is None:
        return None
    match = _STRING_LITERAL.match(trim(text))
    if not match:
        return None
    return match.group(2) if _RAW_PREFIX.match(trim(text)) else match.group(2).replace("\\\\", "\\")


_REGEX_LITERAL = re.compile(r"^/((?:\\.|[^/])+)/[a-z]*$")


def _to_pattern(text: str | None) -> str | None:
    """The source of a regular expression literal (/^[a-z]+$/i → ^[a-z]+$), or a string literal."""
    if text is None:
        return None
    literal = _REGEX_LITERAL.match(trim(text))
    return literal.group(1) if literal else _to_text(text)


_DELIMITED = re.compile(r"^([^\w\s\\])([\s\S]*)\1[a-zA-Z]*$", re.ASCII)


def _without_delimiters(pattern: str | None) -> str | None:
    """A PCRE pattern as PHP writes it, with its delimiters and flags ('/^\\d+$/', '#^[a-z]+$#i') → ^\\d+$."""
    if pattern is None:
        return None
    delimited = _DELIMITED.match(pattern)
    return delimited.group(2) if delimited else pattern


FORMAT_NAMES = {
    "email": "email",
    "isemail": "email",
    "emailaddress": "email",
    "emailfield": "email",
    "url": "uri",
    "isurl": "uri",
    "urlfield": "uri",
    "isuuid": "uuid",
    "uuid": "uuid",
    "uuidfield": "uuid",
    "isdatestring": "date-time",
    "isiso8601": "date-time",
}


_COMPARISONS = {
    "greaterthan": "exclusiveMinimum",
    "greaterthanorequal": "minimum",
    "lessthan": "exclusiveMaximum",
    "lessthanorequal": "maximum",
}


def _annotation_reader(annotation: dict, name: str, language: str | None) -> RawBounds | None:
    """Jakarta Bean Validation and Hibernate Validator (Java, Kotlin), class-validator (TypeScript), DataAnnotations
    (C#), Symfony Validator and Laravel Data (PHP). Their names barely overlap, and where they do they mean the same,
    except Min, Max and Size(n): in Laravel Data (PHP) they bound whatever the type has (length, value or items),
    elsewhere Min / Max bound only a number."""
    laravel = language == "php"
    named, positional = _read_args(annotation)
    first = positional[0] if positional else named.get("value")
    if name in FORMAT_NAMES and not name.endswith("field"):
        return {"format": FORMAT_NAMES[name]}
    second = positional[1] if len(positional) > 1 else None
    if name in ("size", "length", "count", "arraysize"):
        # Symfony: Length(exactly: 5), Count(min: 1, max: 3)
        exactly = _to_number(named.get("exactly"))
        if exactly is not None:
            return {"sizeMin": exactly, "sizeMax": exactly}
        # Laravel Data: Size(5) is the exact length, value or number of items
        if laravel and name == "size" and len(positional) == 1 and not named:
            size = _to_number(positional[0])
            return {"boundMin": size, "boundMax": size}
        min_text = named["min"] if "min" in named else (positional[0] if positional else None)
        max_text = named["max"] if "max" in named else second
        return {"sizeMin": _to_number(min_text), "sizeMax": _to_number(max_text)}
    if name in ("minlength", "arrayminsize"):
        return {"sizeMin": _to_number(first)}
    if name in ("maxlength", "arraymaxsize"):
        return {"sizeMax": _to_number(first)}
    if name == "stringlength":
        # C#: [StringLength(100, MinimumLength = 2)]
        return {"sizeMax": _to_number(first), "sizeMin": _to_number(named.get("minimumlength"))}
    if name in ("notblank", "notempty", "isnotempty"):
        return {"sizeMin": 1}
    if name == "min":
        return {"boundMin": _to_number(first)} if laravel else {"minimum": _to_number(first)}
    if name == "max":
        return {"boundMax": _to_number(first)} if laravel else {"maximum": _to_number(first)}
    if name == "between":
        # Laravel Data: Between(1, 10)
        return {"boundMin": _to_number(positional[0] if positional else None), "boundMax": _to_number(second)}
    if name == "decimalmin":
        value = _to_number(first)
        return {"exclusiveMinimum": value} if named.get("inclusive") == "false" else {"minimum": value}
    if name == "decimalmax":
        value = _to_number(first)
        return {"exclusiveMaximum": value} if named.get("inclusive") == "false" else {"maximum": value}
    if name == "range":
        # Symfony: Range(min: 1, max: 10)
        if "min" in named or "max" in named:
            return {"minimum": _to_number(named.get("min")), "maximum": _to_number(named.get("max"))}
        # C#: [Range(1, 10)] or [Range(typeof(decimal), "0.01", "100")]
        values = positional[1:] if positional and positional[0].startswith("typeof") else positional
        return {
            "minimum": _to_number(values[0] if values else None),
            "maximum": _to_number(values[1] if len(values) > 1 else None),
        }
    if name in ("positive", "ispositive"):
        return {"exclusiveMinimum": 0}
    if name == "positiveorzero":
        return {"minimum": 0}
    if name in ("negative", "isnegative"):
        return {"exclusiveMaximum": 0}
    if name == "negativeorzero":
        return {"maximum": 0}
    # Symfony: GreaterThan(0) or GreaterThan(value: 0); a property path or a date is not a number and is ignored
    if name in _COMPARISONS:
        return {_COMPARISONS[name]: _to_number(first)}
    if name == "regex":
        # Symfony: Regex(pattern: '/^\d+$/'), and match: false accepts what does not match, which a pattern cannot say
        if named.get("match") == "false":
            return None
        return {"pattern": _without_delimiters(_to_text(named["pattern"] if "pattern" in named else first))}
    if name == "pattern":
        return {"pattern": _to_text(named["regexp"] if "regexp" in named else first)}
    if name in ("matches", "regularexpression"):
        return {"pattern": _to_pattern(first)}
    return None


_SQL_STRING = re.compile(r"^String\((\d+)\)$", re.ASCII)


def _first_of(named: dict[str, str], *keys: str) -> str | None:
    """named.get(a) ?? named.get(b)."""
    return next((named[key] for key in keys if key in named), None)


def _python_and_orm_reader(annotation: dict, name: str, _language: str | None) -> RawBounds | None:
    """Pydantic Field(...), Django fields (CharField(max_length=80), EmailField()), SQLAlchemy
    mapped_column(String(80)) and JPA @Column(length = 80)."""
    named, positional = _read_args(annotation)
    if name == "field":
        return {
            "sizeMin": _to_number(_first_of(named, "min_length", "min_items")),
            "sizeMax": _to_number(_first_of(named, "max_length", "max_items")),
            "minimum": _to_number(named.get("ge")),
            "maximum": _to_number(named.get("le")),
            "exclusiveMinimum": _to_number(named.get("gt")),
            "exclusiveMaximum": _to_number(named.get("lt")),
            "pattern": _to_text(_first_of(named, "pattern", "regex")),
        }
    if name == "column":
        return {"sizeMax": _to_number(named.get("length"))}
    if name in ("mapped_column", "column_property"):
        lengths = [match.group(1) for match in (_SQL_STRING.match(arg) for arg in positional) if match]
        return {"sizeMax": _to_number(next((length for length in lengths if length), None))}
    if name.endswith("field"):
        return {"sizeMax": _to_number(named.get("max_length")), "format": FORMAT_NAMES.get(name)}
    return None


_PRISMA_SIZED = re.compile(r"^db\.(?:VarChar|Char|NVarChar|NChar)$", re.IGNORECASE)


def _prisma_reader(annotation: dict, _name: str, _language: str | None) -> RawBounds | None:
    """Prisma native types with a size: @db.VarChar(80), @db.Char(3)."""
    return {"sizeMax": _to_number(annotation.get("args"))} if _PRISMA_SIZED.match(annotation["name"]) else None


_ZOD_BOUNDS = {
    "gt": "exclusiveMinimum",
    "lt": "exclusiveMaximum",
}
_ZOD_FIXED = {
    "positive": {"exclusiveMinimum": 0},
    "nonnegative": {"minimum": 0},
    "negative": {"exclusiveMaximum": 0},
    "nonpositive": {"maximum": 0},
    "nonempty": {"sizeMin": 1},
    "email": {"format": "email"},
    "url": {"format": "uri"},
    "uuid": {"format": "uuid"},
    "datetime": {"format": "date-time"},
}


def _zod_reader(annotation: dict, _name: str, _language: str | None) -> RawBounds | None:
    """Zod checks, kept by the importer as z.<method> annotations."""
    if not annotation["name"].startswith("z."):
        return None
    method = annotation["name"][2:]
    args = _split_args(annotation.get("args"))
    value = _to_number(args[0] if args else None)
    if method == "min":
        return {"boundMin": value}
    if method == "gte":
        return {"minimum": value}
    if method == "max":
        return {"boundMax": value}
    if method == "lte":
        return {"maximum": value}
    if method == "length":
        return {"boundMin": value, "boundMax": value}
    if method in _ZOD_BOUNDS:
        return {_ZOD_BOUNDS[method]: value}
    if method in _ZOD_FIXED:
        return dict(_ZOD_FIXED[method])
    if method == "regex":
        return {"pattern": _to_pattern(annotation.get("args"))}
    return None


_VALIDATE_TAG = re.compile(r'validate:"([^"]*)"')
_GO_BOUNDS = {"min": ("boundMin",), "max": ("boundMax",), "len": ("boundMax", "boundMin")}
_GO_LIMITS = {"gte": "minimum", "lte": "maximum", "gt": "exclusiveMinimum", "lt": "exclusiveMaximum"}
_GO_FORMATS = {"email": "email", "url": "uri", "uri": "uri", "uuid": "uuid", "uuid4": "uuid"}


def _go_tag_reader(annotation: dict, _name: str, _language: str | None) -> RawBounds | None:
    """Go struct tags: validate:"required,min=2,max=50,email"."""
    if annotation["name"] != "tag":
        return None
    match = _VALIDATE_TAG.search(annotation.get("args") or "")
    rules = match.group(1) if match else ""
    if not rules:
        return None
    bounds: RawBounds = {}
    for rule in rules.split(","):
        parts = rule.split("=")
        key = parts[0]
        value = _to_number(parts[1] if len(parts) > 1 else None)
        if key in _GO_BOUNDS:
            for target in _GO_BOUNDS[key]:
                bounds[target] = value
        elif key in _GO_LIMITS:
            bounds[_GO_LIMITS[key]] = value
        elif key in _GO_FORMATS:
            bounds["format"] = _GO_FORMATS[key]
    return bounds


_LIST = re.compile(r"^\[([\s\S]*)\]$")
_RULE_BOUNDS = {"min": ("boundMin",), "max": ("boundMax",), "size": ("boundMin", "boundMax")}
_RULE_LIMITS = {"gt": "exclusiveMinimum", "gte": "minimum", "lt": "exclusiveMaximum", "lte": "maximum"}
_RULE_FORMATS = {"email": "email", "url": "uri", "uuid": "uuid"}


def _laravel_rule_reader(annotation: dict, name: str, _language: str | None) -> RawBounds | None:
    """Laravel validation rules, as Laravel Data's #[Rule('required|max:120')] or #[Rule(['required', 'email'])]
    declares them. min, max, between and size bound whatever the type has; gt, gte, lt and lte only count when
    they compare with a number, not with another field."""
    if name != "rule":
        return None
    rules: list[str] = []
    for arg in _split_args(annotation.get("args")):
        items = _LIST.match(trim(arg))
        # In an array each item is one rule (a pattern may hold a "|"); a text separates them with "|"
        if items:
            rules.extend(_to_text(item) or "" for item in _split_args(items.group(1)))
        else:
            rules.extend((_to_text(arg) or "").split("|"))
    bounds: RawBounds = {}
    for rule in rules:
        colon = rule.find(":")
        key = trim(rule if colon < 0 else rule[:colon]).lower()
        value = "" if colon < 0 else rule[colon + 1 :]
        parts = value.split(",")
        first = parts[0]
        if key in _RULE_BOUNDS:
            for target in _RULE_BOUNDS[key]:
                bounds[target] = _to_number(first)
        elif key == "between":
            bounds["boundMin"] = _to_number(first)
            bounds["boundMax"] = _to_number(parts[1] if len(parts) > 1 else None)
        elif key in _RULE_LIMITS:
            bounds[_RULE_LIMITS[key]] = _to_number(first)
        elif key in _RULE_FORMATS:
            bounds["format"] = _RULE_FORMATS[key]
        elif key == "regex":
            bounds["pattern"] = _without_delimiters(value)
    return bounds


# Every notation, tried in order on each annotation; the first that recognizes it reads it
READERS: tuple[Reader, ...] = (
    _zod_reader,
    _go_tag_reader,
    _prisma_reader,
    _laravel_rule_reader,
    _python_and_orm_reader,
    _annotation_reader,
)

_METADATA_FORMATS = {
    "email": "email",
    "uri": "uri",
    "url": "uri",
    "uuid": "uuid",
    "date": "date",
    "date-time": "date-time",
    "time": "time",
}


def _metadata_bounds(metadata: dict | None) -> RawBounds | None:
    """JSON Schema keywords, kept by the JSON Schema and OpenAPI importers in the field's metadata."""
    if not metadata:
        return None

    def numeric(key: str):
        return metadata[key] if is_number(metadata.get(key)) else None

    def either(a, b):
        return a if a is not None else b

    bounds = {
        "minimum": numeric("minimum"),
        "maximum": numeric("maximum"),
        "exclusiveMinimum": numeric("exclusiveMinimum"),
        "exclusiveMaximum": numeric("exclusiveMaximum"),
        "sizeMin": either(numeric("minLength"), numeric("minItems")),
        "sizeMax": either(numeric("maxLength"), numeric("maxItems")),
        "pattern": metadata["pattern"] if isinstance(metadata.get("pattern"), str) else None,
        "format": _METADATA_FORMATS.get(metadata["format"]) if isinstance(metadata.get("format"), str) else None,
    }
    return bounds if any(value is not None for value in bounds.values()) else None


_EMAIL_TYPE = re.compile(r"\bEmailStr\b", re.ASCII)
_URL_TYPE = re.compile(r"\b(?:Http|Any)Url\b", re.ASCII)


def _type_format(field: FieldDef) -> str | None:
    """Formats that the type itself names in Python (EmailStr, HttpUrl)."""
    written = field.get("originalType") or ""
    if _EMAIL_TYPE.search(written):
        return "email"
    if _URL_TYPE.search(written):
        return "uri"
    return None


def _shape_of(type_ref: TypeRef) -> str:
    if type_ref["kind"] == "array":
        return "list"
    if type_ref["kind"] != "primitive":
        return "other"
    if type_ref["name"] == "string":
        return "text"
    if type_ref["name"] in ("integer", "float", "decimal"):
        return "number"
    return "other"


def _stricter(current, next_value, keep: str):
    """Keeps the stricter of two bounds: every declaration applies at once in the original code."""
    if next_value is None:
        return current
    if current is None:
        return next_value
    return max(current, next_value) if keep == "max" else min(current, next_value)


def _or(a, b):
    """a ?? b for values that are never null."""
    return a if a is not None else b


def _apply(constraints: Constraints, bounds: RawBounds, shape: str) -> None:
    """Adds what one declaration says to the constraints, given the shape of the field."""
    size_min = _or(bounds.get("sizeMin"), bounds.get("boundMin") if shape != "number" else None)
    size_max = _or(bounds.get("sizeMax"), bounds.get("boundMax") if shape != "number" else None)
    if shape == "list":
        constraints["minItems"] = _stricter(constraints.get("minItems"), size_min, "max")
        constraints["maxItems"] = _stricter(constraints.get("maxItems"), size_max, "min")
    elif shape == "text":
        constraints["minLength"] = _stricter(constraints.get("minLength"), size_min, "max")
        constraints["maxLength"] = _stricter(constraints.get("maxLength"), size_max, "min")
    if shape == "number":
        minimum = _or(bounds.get("minimum"), bounds.get("boundMin"))
        maximum = _or(bounds.get("maximum"), bounds.get("boundMax"))
        constraints["minimum"] = _stricter(constraints.get("minimum"), minimum, "max")
        constraints["maximum"] = _stricter(constraints.get("maximum"), maximum, "min")
        constraints["exclusiveMinimum"] = _stricter(
            constraints.get("exclusiveMinimum"), bounds.get("exclusiveMinimum"), "max"
        )
        constraints["exclusiveMaximum"] = _stricter(
            constraints.get("exclusiveMaximum"), bounds.get("exclusiveMaximum"), "min"
        )
    if shape == "text":
        for key in ("pattern", "format"):
            if bounds.get(key) is not None and constraints.get(key) is None:
                constraints[key] = bounds[key]


def _compact(constraints: Constraints) -> Constraints:
    """Removes the keys without a value, so equal constraints compare equal."""
    return {key: value for key, value in constraints.items() if value is not None}


def _describe_annotation(annotation: dict) -> str:
    """How a declaration is shown when explaining where a validation comes from."""
    args = annotation.get("args")
    args = "" if args is None else args
    if annotation["name"] == "tag":
        return args
    if annotation["name"].startswith("z."):
        return f".{annotation['name'][2:]}({args})"
    return f"{annotation['name']}({args})"


_METADATA_KEYS = (
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "pattern",
    "format",
    "minItems",
    "maxItems",
)


def _snapshot(constraints: Constraints) -> str:
    return json.dumps(_compact(constraints))


def read_constraints(field: FieldDef, language: str | None = None) -> dict:
    """The validations a field declares and the declarations they come from: {"constraints", "sources"}. language
    is the language of the input (schema["origin"]["language"]), when known.

    Only declarations that apply to the field's type are kept: a length on a number or a range on a text is
    ignored, because the generated code could not enforce it."""
    shape = _shape_of(field["type"])
    constraints: Constraints = {}
    sources: list[str] = []
    for annotation in field.get("annotations") or []:
        name = _simple_name(annotation["name"])
        for reader in READERS:
            bounds = reader(annotation, name, language)
            if bounds is None:
                continue
            before = _snapshot(constraints)
            _apply(constraints, bounds, shape)
            if _snapshot(constraints) != before:
                sources.append(_describe_annotation(annotation))
            break
    metadata = field.get("metadata")
    from_metadata = _metadata_bounds(metadata)
    if from_metadata:
        before = _snapshot(constraints)
        _apply(constraints, from_metadata, shape)
        if _snapshot(constraints) != before:
            for key in _METADATA_KEYS:
                if key in metadata:
                    value = metadata[key]
                    sources.append(f"{key}: {value if isinstance(value, str) else js_string(value)}")
    text_format = _type_format(field) if shape == "text" else None
    if text_format and not constraints.get("format"):
        constraints["format"] = text_format
        sources.append(field["originalType"])
    return {"constraints": _compact(constraints), "sources": sources}
