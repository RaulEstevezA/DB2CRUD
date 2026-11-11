"""Text helpers shared by the generators: joining lines while skipping the ones that do not apply, indenting
blocks of code, ending files and ordering texts. Mirrors web/src/core/generators/common/text.ts.

A line is a string, or False / None for a line that does not apply; lines may be grouped in nested lists.
"""

import functools

from ...js import trim, trim_end


def lines(*items) -> str:
    """Joins the lines that apply with line breaks, at any depth of nesting."""
    result: list[str] = []

    def add(item) -> None:
        if isinstance(item, (list, tuple)):
            for inner in item:
                add(inner)
        elif isinstance(item, str):
            result.append(item)

    for item in items:
        add(item)
    return "\n".join(result)


def indent(text: str, spaces: int) -> str:
    """Indents every non-empty line of a block."""
    pad = " " * spaces
    return "\n".join("" if trim(line) == "" else pad + line for line in text.split("\n"))


def file_text(text: str) -> str:
    """Ends a file with exactly one line break, as editors and linters expect."""
    return f"{trim_end(text)}\n"


def compare_text(a: str, b: str) -> int:
    """Orders two texts the same way on every system: ignoring case first, then by character code."""
    x = a.lower()
    y = b.lower()
    if x != y:
        return -1 if x < y else 1
    return -1 if a < b else 1 if a > b else 0


compare_key = functools.cmp_to_key(compare_text)
