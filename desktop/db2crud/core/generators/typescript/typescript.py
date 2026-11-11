"""What every TypeScript generator needs: identifiers (camelCase members, PascalCase types, kebab-case files),
literals, and the imports of an ES module, with the `.js` extension NodeNext resolution asks for and paths relative
to the importing file. Mirrors web/src/core/generators/typescript/typescript.ts."""

from ...js import number_text
from ...model.naming import split_words, to_camel_case, to_pascal_case

RESERVED = {
    *"break case catch class const continue debugger default delete do else enum export extends false finally".split(),
    *"for function if import in instanceof new null return super switch this throw true try typeof var void".split(),
    *"while with yield let static implements interface package private protected public await".split(),
}


def _safe(name: str) -> str:
    base = f"_{name}" if name[:1].isdigit() else name
    return f"{base}_" if base in RESERVED else base


def member_name(name: str) -> str:
    """created_at → createdAt."""
    return _safe(to_camel_case(name) or "value")


def type_name(name: str) -> str:
    """order line → OrderLine."""
    return _safe(to_pascal_case(name) or "Item")


def file_name(name: str) -> str:
    """OrderLine → order-line, for file names."""
    return "-".join(split_words(name)).lower() or "item"


def ts_literal(value) -> str:
    """A TypeScript literal."""
    if value is None:
        return "null"
    if isinstance(value, str):
        escaped = value.replace("\\", "\\\\").replace("'", "\\'")
        return f"'{escaped}'"
    return number_text(value)


def quote(text: str) -> str:
    """A string in single quotes."""
    return ts_literal(text)


def relative_import(source: str, target: str) -> str:
    """The path of `target` as an import from `source` (both module paths without extension, from the project root)."""
    if not target.startswith("src/") and not target.startswith("test/"):
        return target
    from_parts = source.split("/")[:-1]
    to_parts = target.split("/")
    common = 0
    while common < len(from_parts) and common < len(to_parts) - 1 and from_parts[common] == to_parts[common]:
        common += 1
    up = len(from_parts) - common
    path = "/".join([".."] * up + to_parts[common:])
    return f"{'./' if up == 0 else ''}{path}.js"


class TsImports:
    """The imports of one module: packages first, then the project's own files, each sorted."""

    def __init__(self, self_module: str) -> None:
        self._self = self_module
        self._named: dict[str, set[str]] = {}
        self._types: dict[str, set[str]] = {}
        self._side_effects: set[str] = set()

    def from_(self, module: str, *names: str) -> "TsImports":
        """import { name } from 'module'; `module` is a package or a project module path (src/errors)."""
        self._named.setdefault(module, set()).update(names)
        return self

    def type(self, module: str, *names: str) -> "TsImports":
        """import type { name } from 'module'"""
        self._types.setdefault(module, set()).update(names)
        return self

    def only(self, module: str) -> "TsImports":
        """import 'module'"""
        self._side_effects.add(module)
        return self

    def write(self) -> str:
        modules = set(self._named) | set(self._types)

        def local(module: str) -> int:
            return 1 if module.startswith("src/") or module.startswith("test/") else 0

        order = sorted(modules, key=lambda module: (local(module), module))
        result = [f"import '{module}'" for module in sorted(self._side_effects)]
        for module in order:
            if module == self._self:
                continue
            target = relative_import(self._self, module)
            values = sorted(self._named.get(module, set()))
            types = sorted(name for name in self._types.get(module, set()) if name not in values)
            if values:
                names = ", ".join([*values, *(f"type {name}" for name in types)])
                result.append(f"import {{ {names} }} from '{target}'")
            elif types:
                result.append(f"import type {{ {', '.join(types)} }} from '{target}'")
        return "\n".join(result)
