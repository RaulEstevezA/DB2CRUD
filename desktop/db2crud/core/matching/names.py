"""How the matching compares names (matching.py): by their words, whatever their convention, with plurals and the
usual suffixes of models left out; a suffix may also say which way a model goes. Mirrors
web/src/core/matching/names.ts."""

from ..model.naming import name_words, singularize

_SUFFIX_DIRECTIONS = {
    "entity": "both",
    "model": "both",
    "dto": "both",
    "record": "both",
    "request": "input",
    "input": "input",
    "command": "input",
    "response": "output",
    "output": "output",
}
DIRECTIONS = ("both", "input", "output")


def singular_words(words: list[str]) -> list[str]:
    return [*words[:-1], singularize(words[-1])] if words else words


def model_name(name: str) -> tuple[list[str], str]:
    """The words a model name is compared by (without its suffixes, the last one singular) and its direction."""
    words = name_words(name)
    direction = "both"
    while len(words) > 1 and words[-1] in _SUFFIX_DIRECTIONS:
        found = _SUFFIX_DIRECTIONS[words.pop()]
        if direction == "both":
            direction = found
    return singular_words(words), direction


def key(words: list[str]) -> str:
    return " ".join(words)


def fields_of(model: dict, schema: dict, seen: set | None = None) -> list[dict]:
    """All fields of a model, with those of the models it extends first."""
    seen = seen if seen is not None else set()
    seen.add(model["name"])
    inherited: list[dict] = []
    for name in model.get("extends") or []:
        parent = next((item for item in schema["models"] if item["name"] == name), None)
        if parent is not None and parent["name"] not in seen:
            inherited.extend(fields_of(parent, schema, seen))
    return [*inherited, *model["fields"]]


def field_names(field: dict) -> list[str]:
    """The names a field answers to: its own, its name on the wire and its aliases."""
    return [
        field["name"],
        *([field["serializedName"]] if field.get("serializedName") else []),
        *(field.get("aliases") or []),
    ]


def field_for(column: dict, fields: list[dict], taken: set[str]) -> tuple[dict, str] | None:
    """The field a column comes from: the same name, or the same words in another convention (both exact); the second
    value says whether the name is the same."""
    names = [column["name"], *([column["attribute"]] if column.get("attribute") else [])]
    free = [field for field in fields if field["name"] not in taken]
    exact = next((field for field in free if any(name in names for name in field_names(field))), None)
    if exact is not None:
        return exact, "exact"
    words = [key(name_words(name)) for name in names]
    close = next((field for field in free if any(key(name_words(name)) in words for name in field_names(field))), None)
    return (close, "probable") if close is not None else None


def names_table(words: list[str], table: dict) -> bool:
    """Whether the words of a model name are those of a table or of its entity."""
    names = [table["name"], *([table["entity"]] if table.get("entity") else [])]
    return any(key(singular_words(name_words(name))) == key(words) for name in names)
