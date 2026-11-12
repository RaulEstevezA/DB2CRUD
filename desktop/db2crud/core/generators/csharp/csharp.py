"""What the C# generator needs: identifiers (PascalCase members and types, camelCase locals), C# literals, and the
usings of a file, sorted, without the ones of its own namespace. Mirrors web/src/core/generators/csharp/csharp.ts."""

from ...model.naming import to_camel_case, to_pascal_case

KEYWORDS = set(
    (
        "abstract as base bool break byte case catch char checked class const continue decimal default delegate do "
        "double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface "
        "internal is lock long namespace new null object operator out override params private protected public "
        "readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try "
        "typeof uint ulong unchecked unsafe ushort using virtual void volatile while value record"
    ).split(" ")
)


def local_name(name: str) -> str:
    """A name C# accepts as a local or parameter: keywords get a leading @."""
    base = to_camel_case(name) or "value"
    safe = f"_{base}" if base[:1].isdigit() else base
    return f"@{safe}" if safe in KEYWORDS else safe


def pascal_name(name: str) -> str:
    """order line → OrderLine."""
    base = to_pascal_case(name) or "Item"
    return f"_{base}" if base[:1].isdigit() else base


def cs_string(text: str) -> str:
    """A C# string literal."""
    escaped = (
        text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    )
    return f'"{escaped}"'


class CsUsings:
    """The usings of one file, sorted, without its own namespace (and System first, as dotnet format leaves them)."""

    def __init__(self, ns: str):
        self._ns = ns
        self._names: list[str] = []

    def add(self, *names: str) -> "CsUsings":
        for name in names:
            if name not in self._names:
                self._names.append(name)
        return self

    def write(self) -> str:
        def system(name: str) -> bool:
            return name == "System" or name.startswith("System.")

        names = sorted((name for name in self._names if name != self._ns), key=lambda name: (not system(name), name))
        return "\n".join(f"using {name};" for name in names)
