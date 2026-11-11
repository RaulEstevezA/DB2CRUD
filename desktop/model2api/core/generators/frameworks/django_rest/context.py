"""Shared context of the Django REST Framework generator: the Django app and module of each piece for the chosen
architecture (Strategy pattern: layered puts every resource in one api app, modular gives each resource an app
of its own), and a collector that writes each Python module once with its imports. Mirrors
web/src/core/generators/frameworks/djangoRest/context.ts.
"""

from dataclasses import dataclass

from ...common.text import file_text, lines
from ...languages.python.python import PyImports, py_class, py_docstring, py_module, py_name


class _Layered:
    def __init__(self, spec: dict) -> None:
        self._spec = spec

    def app(self, resource: dict) -> str:
        return "api"

    def apps(self) -> list[str]:
        return ["api"]

    def shared_enums(self) -> str:
        return "api.models"

    def shared_serializers(self) -> str:
        return "api.serializers"


class _Modular:
    def __init__(self, spec: dict) -> None:
        self._spec = spec

    def app(self, resource: dict) -> str:
        return py_module(resource["name"])

    def apps(self) -> list[str]:
        return ["common", *(py_module(resource["name"]) for resource in self._spec["resources"])]

    def shared_enums(self) -> str:
        return "common.enums"

    def shared_serializers(self) -> str:
        return "common.serializers"


@dataclass
class DjangoContext:
    spec: dict
    settings: dict
    layout: object


def create_context(spec: dict, settings: dict) -> DjangoContext:
    layout = _Modular(spec) if settings["architecture"] == "modular" else _Layered(spec)
    return DjangoContext(spec=spec, settings=settings, layout=layout)


def module_of(context: DjangoContext, resource: dict, kind: str) -> str:
    """The module of a resource's piece: api.models, customer.views."""
    return f"{context.layout.app(resource)}.{kind}"


class Modules:
    """Collects the blocks of each module and writes them with their docstring and imports."""

    def __init__(self) -> None:
        self._modules: dict[str, dict] = {}

    def get(self, module: str, doc: str) -> dict:
        """The imports and blocks of a module ({"imports", "blocks"}), created with its docstring the first time."""
        if module not in self._modules:
            self._modules[module] = {"doc": doc, "imports": PyImports(), "blocks": []}
        return self._modules[module]

    def files(self) -> list[dict]:
        files = []
        for module, entry in self._modules.items():
            rendered = entry["imports"].render()
            content = lines(
                py_docstring(entry["doc"]),
                "",
                rendered,
                rendered and "",
                rendered and "",
                "\n\n\n".join(entry["blocks"]),
            )
            files.append({"path": f"{module.replace('.', '/')}.py", "content": file_text(content)})
        return files


def names(resource: dict) -> dict:
    """Names of a resource."""
    type_name = py_class(resource["name"])
    return {
        "model": type_name,
        "serializer": f"{type_name}Serializer",
        "service": f"{type_name}Service",
        "one": py_name(resource["name"]),
        "many": py_name(resource["plural"].replace(" ", "_")),
    }


def attr(field: dict) -> str:
    """The Python attribute of a field on its model: references use the field's name (customer), the rest too."""
    return py_name(field["name"])


def key_field(resource: dict) -> dict:
    return next(field for field in resource["fields"] if field["name"] == resource["key"]["field"])


def is_foreign_key(field: dict) -> bool:
    """Whether a field is a reference to one item, stored as a foreign key."""
    return field.get("reference") is not None and field["type"]["kind"] == "scalar"
