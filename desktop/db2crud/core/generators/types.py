"""What every generator shares: joining the lines that apply and indenting blocks. Mirrors
web/src/core/generators/types.ts.

A generator is a dictionary {"language", "orm", "generate"} whose generate(schema, design, settings) returns the
files of a project: dictionaries {"path", "content"}.
"""


def _flat(items):
    for item in items:
        if isinstance(item, list):
            yield from _flat(item)
        else:
            yield item


def lines(*items) -> str:
    """Joins the lines that apply: strings, at any depth of lists; False and None are left out."""
    return "\n".join(item for item in _flat(items) if isinstance(item, str))


def indent(text: str, spaces: int = 4) -> str:
    """Indents every non-empty line of a block."""
    pad = " " * spaces
    return "\n".join(line if line == "" else pad + line for line in text.split("\n"))
