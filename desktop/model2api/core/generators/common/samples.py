"""Sample values for the tests every generator writes: request bodies that satisfy the validations the models
declare (lengths, ranges, formats, patterns, enums), built once and language-neutral so the tests of every
framework send the same data. Mirrors web/src/core/generators/common/samples.ts.

References to other resources cannot be known in advance: they are listed with their place in the body so the
generated test creates the referenced item first and puts its key there.
"""

import json
import math
import re

from ...js import number_text


class _Unsupported(Exception):
    pass


_UUIDS = ("3fa85f64-5717-4562-b3fc-2c963f66afa6", "7c9e6679-7425-40de-944b-e07fc1f90ae7")
_RANGE = re.compile(r"^(.)-(.)", re.DOTALL)
_BOUND = re.compile(r"^\{(\d+)(,(\d*))?\}", re.ASCII)
_BAD_ESCAPE = re.compile(r"[1-9bBk]")


def _class_sample(body: str) -> str:
    """One character of a class written in a pattern: A-Z, 0-9, a, \\d."""
    if body.startswith("^"):
        raise _Unsupported("negated class")
    if body.startswith("\\d"):
        return "1"
    if body.startswith("\\w"):
        return "a"
    if body.startswith("\\s"):
        return " "
    found = _RANGE.match(body)
    if found:
        return found.group(1)
    if body.startswith("\\"):
        return body[1] if len(body) > 1 else "undefined"
    return body[0] if body else "undefined"


def _js_regex_accepts(pattern: str, value: str) -> bool:
    """new RegExp(pattern).test(value) for the simple patterns models declare."""
    return re.search(pattern, value) is not None


def pattern_accepts(pattern: str, value: str) -> bool:
    """Whether a regular expression accepts a text, as JavaScript reads it; False when the pattern does not compile."""
    try:
        return _js_regex_accepts(pattern, value)
    except re.error:
        return False


def sample_from_pattern(pattern: str) -> str | None:
    """Builds a string that a simple regular expression accepts: literals, classes, \\d \\w \\s, groups,
    alternatives (the first is used) and the quantifiers ? * + {n} {n,} {n,m}. None when the pattern uses
    something else (look-arounds, back-references…)."""
    index = 0

    def at(position: int) -> str | None:
        return pattern[position] if 0 <= position < len(pattern) else None

    def atom() -> str:
        nonlocal index
        char = pattern[index]
        if char == "[":
            end = pattern.find("]", index + 1)
            if end < 0:
                raise _Unsupported("class")
            body = pattern[index + 1 : end]
            index = end + 1
            return _class_sample(body)
        if char == "(":
            index += 1
            if pattern.startswith("?:", index):
                index += 2
            elif at(index) == "?":
                raise _Unsupported("look-around")
            value = sequence(")")
            index += 1
            return value
        if char == "\\":
            following = at(index + 1)
            index += 2
            if following == "d":
                return "1"
            if following == "w":
                return "a"
            if following == "s":
                return " "
            if following is None or _BAD_ESCAPE.match(following):
                if following is None:
                    return "undefined"
                raise _Unsupported("escape")
            return following
        if char == ".":
            index += 1
            return "a"
        index += 1
        return char

    def quantified() -> str:
        nonlocal index
        value = atom()
        char = at(index)
        if char in ("?", "*"):
            index += 1
            return value if char == "?" else ""
        if char == "+":
            index += 1
            return value
        if char == "{":
            match = _BOUND.match(pattern[index:])
            if not match:
                return value
            index += len(match.group(0))
            return value * int(match.group(1))
        return value

    def sequence(stop: str | None) -> str:
        nonlocal index
        result = ""
        while index < len(pattern) and pattern[index] != stop:
            char = pattern[index]
            if char in ("^", "$"):
                index += 1
                continue
            if char == "|":
                # The first alternative is enough: skip the rest of this sequence
                depth = 0
                while index < len(pattern) and not (depth == 0 and pattern[index] == stop):
                    if pattern[index] == "\\":
                        index += 1
                    elif pattern[index] == "(":
                        depth += 1
                    elif pattern[index] == ")":
                        depth -= 1
                    index += 1
                break
            result += quantified()
        return result

    try:
        value = sequence(None)
        return value if _js_regex_accepts(pattern, value) else None
    except Exception:
        return None


def _sample_text(constraints: dict, name: str, variant: int) -> str:
    """A text that respects the field's validations: its format, its pattern or its length."""
    text_format = constraints.get("format")
    if text_format == "email":
        return f"user{variant + 1}@example.com"
    if text_format == "uri":
        return f"https://example.com/{name.lower()}/{variant + 1}"
    if text_format == "uuid":
        return _UUIDS[variant % len(_UUIDS)]
    if text_format == "date":
        return f"2024-01-{15 + variant}"
    if text_format == "date-time":
        return f"2024-01-{15 + variant}T10:30:00Z"
    if text_format == "time":
        return "10:30:00"
    if constraints.get("pattern"):
        value = sample_from_pattern(constraints["pattern"])
        if value is None:
            raise _Unsupported(f"pattern {constraints['pattern']}")
        return value
    text = f"{name} {variant + 1}"
    minimum = constraints.get("minLength", 0)
    maximum = constraints.get("maxLength")
    if len(text) < minimum:
        text = text.ljust(minimum, "x")
    if maximum is not None and len(text) > maximum:
        text = text[: max(0, int(maximum))]
    return text


def _plain_number(value):
    """A number as JavaScript holds it: 2.0 is 2."""
    return int(value) if isinstance(value, float) and value.is_integer() else value


def _sample_number(constraints: dict, whole: bool, variant: int):
    """A number inside the field's range, different for each variant where the range allows it."""
    step = 1 if whole else 0.5
    minimum = constraints.get("minimum")
    exclusive_minimum = constraints.get("exclusiveMinimum")
    low = minimum if minimum is not None else exclusive_minimum + step if exclusive_minimum is not None else None
    if minimum is not None and exclusive_minimum is not None:
        low = max(minimum, exclusive_minimum + step)
    maximum = constraints.get("maximum")
    exclusive_maximum = constraints.get("exclusiveMaximum")
    high = maximum if maximum is not None else exclusive_maximum - step if exclusive_maximum is not None else None
    value = (low if low is not None else (1 if whole else 1.5)) + variant * step
    if whole:
        value = math.ceil(value)
    if high is not None and value > high:
        value = max(low if low is not None else high, high)
    return _plain_number(value)


def _sample_of(type_ref: dict, field: dict, spec: dict, variant: int, path: list, references: list, depth: int):
    constraints = field["constraints"]
    kind = type_ref["kind"]
    if kind == "scalar":
        name = type_ref["scalar"]
        if name == "string":
            return _sample_text(constraints, field["name"], variant)
        if name == "integer":
            return _sample_number(constraints, True, variant)
        if name in ("float", "decimal"):
            return _sample_number(constraints, False, variant)
        if name == "boolean":
            return variant % 2 == 0
        if name == "date":
            return f"2024-01-{15 + variant}"
        if name == "datetime":
            return f"2024-01-{15 + variant}T10:30:00Z"
        if name == "time":
            return "10:30:00"
        if name == "duration":
            return "PT1H"
        if name == "uuid":
            return _UUIDS[variant % len(_UUIDS)]
        if name == "binary":
            return "aGVsbG8="
        if name == "any":
            return {"note": f"sample {variant + 1}"}
        return None
    if kind == "enum":
        found = next((item for item in spec["enums"] if item["name"] == type_ref["name"]), None)
        values = found["values"] if found else []
        if not values:
            raise _Unsupported(f"empty enum {type_ref['name']}")
        return values[variant % len(values)]
    if kind == "object":
        spec_object = next((item for item in spec["objects"] if item["name"] == type_ref["name"]), None)
        if not spec_object or depth > 4:
            raise _Unsupported(f"object {type_ref['name']}")
        return _object_sample(spec_object["fields"], spec, variant, path, references, depth + 1)
    plain = {**field, "constraints": {}}
    if kind == "array":
        count = max(1, field["constraints"].get("minItems", 1))
        return [
            _sample_of(type_ref["items"], plain, spec, variant, [*path, position], references, depth)
            for position in range(count)
        ]
    return {"key": _sample_of(type_ref["value"], plain, spec, variant, [*path, "key"], references, depth)}


def _object_sample(fields: list[dict], spec: dict, variant: int, path: list, references: list, depth: int) -> dict:
    """The body of an object: every field the client may send, references left to fill."""
    body: dict = {}
    for field in fields:
        if field["access"] == "readOnly":
            continue
        here = [*path, field["wire"]]
        if field.get("reference"):
            # An optional reference (a tree's parent) stays out; a required one is filled by the test
            if not field["required"]:
                continue
            if field["type"]["kind"] == "array":
                body[field["wire"]] = [None]
                references.append({"path": [*here, 0], "resource": field["reference"]})
            else:
                body[field["wire"]] = None
                references.append({"path": here, "resource": field["reference"]})
            continue
        body[field["wire"]] = _sample_of(field["type"], field, spec, variant, here, references, depth)
    return body


def sample_body(spec: dict, resource: dict, variant: int) -> dict:
    """A valid creation body of a resource: {"sample": {"body", "references"}, "problem"}. Variant 0 is the
    first body, 1 another one with different values where possible; problem says in English why no valid body
    can be built, or is None."""
    references: list = []
    try:
        body = _object_sample(resource["fields"], spec, variant, [], references, 0)
        return {"sample": {"body": body, "references": references}, "problem": None}
    except Exception as error:
        problem = f"No valid sample body could be built ({error}); write one by hand."
        return {"sample": {"body": {}, "references": []}, "problem": problem}


def updatable_field(resource: dict) -> dict | None:
    """A field a partial update can change in the tests: a plain text or number the client may send."""
    for field in resource["fields"]:
        if (
            field["access"] == "readWrite"
            and field["name"] != resource["key"]["field"]
            and not field.get("reference")
            and field["type"]["kind"] == "scalar"
            and field["type"]["scalar"] in ("string", "integer", "float", "decimal")
            and not field["constraints"].get("pattern")
            and not field["constraints"].get("format")
        ):
            return field
    return None


def creation_order(spec: dict, resource: dict) -> list[dict]:
    """The resources a resource needs before it can be created, deepest first, without repeats or cycles."""
    order: list[dict] = []
    visiting: set[str] = set()

    def visit(current: dict) -> None:
        if current["name"] in visiting or any(item is current for item in order):
            return
        visiting.add(current["name"])
        sample = sample_body(spec, current, 0)["sample"]
        for reference in sample["references"]:
            target = next((item for item in spec["resources"] if item["name"] == reference["resource"]), None)
            if target is not None and target is not current:
                visit(target)
        order.append(current)

    visit(resource)
    return [item for item in order if item is not resource]


def json_text(value) -> str:
    """JSON.stringify of a sample value, with numbers written as JavaScript writes them."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return number_text(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(json_text(item) for item in value) + "]"
    return (
        "{" + ",".join(f"{json.dumps(key, ensure_ascii=False)}:{json_text(item)}" for key, item in value.items()) + "}"
    )
