"""What the Java generator needs: identifiers (camelCase members, PascalCase types, lowercase packages), Java literals,
and the imports of a compilation unit, sorted, without the ones of its own package or java.lang. Mirrors
web/src/core/generators/java/java.ts."""

from ...model.naming import split_words, to_camel_case, to_pascal_case

KEYWORDS = set(
    (
        "abstract assert boolean break byte case catch char class const continue default do double else enum extends "
        "final finally float for goto if implements import instanceof int interface long native new package private "
        "protected public return short static strictfp super switch synchronized this throw throws transient try void "
        "volatile while true false null var record yield sealed permits"
    ).split(" ")
)


def _safe(name: str) -> str:
    base = f"_{name}" if name[:1].isdigit() else name
    return f"{base}_" if base in KEYWORDS else base


def member_name(name: str) -> str:
    """created_at → createdAt."""
    return _safe(to_camel_case(name) or "value")


def type_name(name: str) -> str:
    """order line → OrderLine."""
    return _safe(to_pascal_case(name) or "Item")


def package_name(name: str) -> str:
    """OrderLine → orderline, for a package."""
    return _safe("".join(split_words(name)).lower() or "item")


def capitalized(name: str) -> str:
    """createdAt → CreatedAt, for getters and setters."""
    return name[:1].upper() + name[1:]


def java_string(text: str) -> str:
    """A Java string literal."""
    escaped = (
        text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    )
    return f'"{escaped}"'


def java_path(pkg: str, name: str, test: bool = False) -> str:
    """The path of a class of a package: src/main/java/app/entities/Product.java."""
    return f"src/{'test' if test else 'main'}/java/{pkg.replace('.', '/')}/{name}.java"


class JavaImports:
    """The imports of one compilation unit: static imports first, then the others, each sorted."""

    def __init__(self, pkg: str):
        self._pkg = pkg
        self._names: list[str] = []
        self._statics: list[str] = []

    def add(self, *names: str) -> "JavaImports":
        for name in names:
            if name not in self._names:
                self._names.append(name)
        return self

    def add_static(self, *names: str) -> "JavaImports":
        for name in names:
            if name not in self._statics:
                self._statics.append(name)
        return self

    def write(self) -> str:
        def own(name: str) -> str:
            return name[: name.rindex(".")]

        names = sorted(name for name in self._names if own(name) != self._pkg and own(name) != "java.lang")
        statics = sorted(self._statics)
        result = [f"import static {name};" for name in statics]
        if statics and names:
            result.append("")
        result += [f"import {name};" for name in names]
        return "\n".join(result)
