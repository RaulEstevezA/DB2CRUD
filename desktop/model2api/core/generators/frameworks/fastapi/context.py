"""Shared context of the FastAPI generator: where each module goes for the chosen architecture (Strategy
pattern: layered or modular), and the Python names of resources and fields. Every other module of the generator
asks the context instead of building paths or names on its own. Mirrors
web/src/core/generators/frameworks/fastapi/context.ts.
"""

from dataclasses import dataclass

from ...languages.python.python import py_class, py_module, py_name

_LAYERED_FOLDERS = {
    "schemas": "schemas",
    "models": "models",
    "repository": "repositories",
    "service": "services",
    "router": "routers",
}


class _Layered:
    """One folder per layer: app/routers/customer.py, app/services/customer.py…"""

    @staticmethod
    def resource(resource: dict, kind: str) -> dict:
        name = py_module(resource["name"])
        folder = _LAYERED_FOLDERS[kind]
        return {"file": f"app/{folder}/{name}.py", "module": f"app.{folder}.{name}"}

    @staticmethod
    def shared() -> dict:
        return {"file": "app/schemas/common.py", "module": "app.schemas.common"}


class _Modular:
    """One folder per resource: app/customer/router.py, app/customer/service.py…"""

    @staticmethod
    def resource(resource: dict, kind: str) -> dict:
        name = py_module(resource["name"])
        return {"file": f"app/{name}/{kind}.py", "module": f"app.{name}.{kind}"}

    @staticmethod
    def shared() -> dict:
        return {"file": "app/shared/schemas.py", "module": "app.shared.schemas"}


@dataclass
class FastApiContext:
    spec: dict
    settings: dict
    layout: object
    sql: bool
    # Repositories that raise "not implemented" in every method
    pending: bool


def create_context(spec: dict, settings: dict) -> FastApiContext:
    return FastApiContext(
        spec=spec,
        settings=settings,
        layout=_Modular if settings["architecture"] == "modular" else _Layered,
        sql=settings["persistence"] == "sqlalchemy",
        pending=settings["persistence"] == "none",
    )


def attr(field: dict) -> str:
    """Python attribute of a field: the reference's wire name for references (customer_id), its own name otherwise."""
    return py_name(field["wire"] if field.get("reference") else field["name"])


def classes(resource: dict) -> dict:
    """Class names of a resource."""
    base = py_class(resource["name"])
    return {
        "read": base,
        "create": f"{base}Create",
        "update": f"{base}Update",
        "model": f"{base}Model",
        "repository": f"{base}Repository",
        "memory": f"InMemory{base}Repository",
        "sqlRepository": f"Sql{base}Repository",
        "pendingRepository": f"Pending{base}Repository",
        "service": f"{base}Service",
    }


def names(resource: dict) -> dict:
    """Python names of the resource for variables and functions: order_line, order_lines."""
    return {"one": py_name(resource["name"]), "many": py_name(resource["plural"].replace(" ", "_"))}


def table_name(resource: dict) -> str:
    """Table of a resource: order_lines."""
    return py_module(resource["plural"].replace(" ", "_"))


def key_field(resource: dict) -> dict:
    return next(field for field in resource["fields"] if field["name"] == resource["key"]["field"])
