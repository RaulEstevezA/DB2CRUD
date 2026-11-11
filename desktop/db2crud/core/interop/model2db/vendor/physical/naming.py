"""Table, column and constraint names. Mirrors web/src/core/physical/naming.ts."""

import re

from ..model.naming import name_words, to_snake_case

# Documents keep the field names of the model; tables follow the SQL convention; Redis keys are singular
DEFAULT_NAMING = {
    "relational": {"tables": "plural", "columns": "snake"},
    "document": {"tables": "plural", "columns": "field"},
    "keyvalue": {"tables": "singular", "columns": "snake"},
    "widecolumn": {"tables": "plural", "columns": "snake"},
}


def pluralize(word: str) -> str:
    """Plural of an English word, for table names: `order` → `orders`, `category` → `categories`."""
    if word == "":
        return word
    lower = word.lower()
    if re.search(r"(s|x|z|ch|sh)$", lower):
        return f"{word}es"
    if re.search(r"[^aeiou]y$", lower):
        return f"{word[:-1]}ies"
    return f"{word}s"


def table_name(model: str, naming: dict) -> str:
    """Table or collection name of a model: `OrderLine` → `order_lines`, `order_line` or `OrderLine`."""
    if naming["tables"] == "model":
        return model
    snake = to_snake_case(model)
    if naming["tables"] == "singular":
        return snake
    words = snake.split("_")
    words[-1] = pluralize(words[-1])
    return "_".join(words)


def column_name(field: str, naming: dict) -> str:
    """Column name of a field: `createdAt` → `created_at`, or the field name as it is."""
    return to_snake_case(field) if naming["columns"] == "snake" else field


def join_names(parts: list[str], naming: dict) -> str:
    """Joins name parts in the column convention: (`address`, `city`) → `address_city` or `addressCity`."""
    if naming["columns"] == "snake":
        return "_".join(to_snake_case(part) for part in parts)
    words = [word for part in parts for word in name_words(part)]
    return "".join(word if i == 0 else word[0].upper() + word[1:] for i, word in enumerate(words))


def free_name(name: str, used: set[str]) -> str:
    """A name not used yet in a set, with a number when needed: `id`, `id_2`."""
    candidate = name
    i = 2
    while candidate.lower() in used:
        candidate = f"{name}_{i}"
        i += 1
    used.add(candidate.lower())
    return candidate


# Most databases limit identifiers to 63 (PostgreSQL) or 64 characters; constraint names stay below
MAX_IDENTIFIER = 60
_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def _base36(value: int) -> str:
    text = ""
    while True:
        value, digit = divmod(value, 36)
        text = _DIGITS[digit] + text
        if value == 0:
            return text


def _char_code(char: str) -> int:
    """charCodeAt(0) of a character: the first UTF-16 unit."""
    code = ord(char)
    return 0xD800 + ((code - 0x10000) >> 10) if code > 0xFFFF else code


def _js_length(text: str) -> int:
    return sum(2 if ord(char) > 0xFFFF else 1 for char in text)


def _js_slice(text: str, end: int) -> str:
    """text.slice(0, end) in UTF-16 units; a character cut in half keeps its first unit as JavaScript does."""
    result, units = [], 0
    for char in text:
        size = 2 if ord(char) > 0xFFFF else 1
        if units + size > end:
            if units < end:
                result.append(chr(_char_code(char)))
            break
        result.append(char)
        units += size
    return "".join(result)


def constraint_name(prefix: str, table: str, columns: list[str]) -> str:
    """Name of a constraint or index: `fk_orders_customer_id`, shortened if it gets too long."""
    name = "_".join([prefix, table, *columns])
    if _js_length(name) <= MAX_IDENTIFIER:
        return name
    hashed = 0
    for char in name:
        hashed = (hashed * 31 + _char_code(char)) & 0xFFFFFFFF
    return f"{_js_slice(name, MAX_IDENTIFIER - 9)}_{_base36(hashed)[:8]}"
