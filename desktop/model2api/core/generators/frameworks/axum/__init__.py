"""Axum generator: writes a Rust project with Axum 0.8, serde, authentication (API key or JWT) and SeaORM when it is
chosen, built with Cargo. It composes the modules of this folder; each writes one kind of file. The module
declarations (mod.rs, lib.rs) are derived last, from the paths of the source files written. Mirrors
web/src/core/generators/frameworks/axum/index.ts.
"""

from .common import common_files, database_file, main_file, module_files, security_file
from .context import create_context
from .model import domain_file, dto_file, shared_files
from .persistence import entity_file, repository_file
from .project import cargo_file, env_example_file, gitignore_file, readme_file
from .tests import test_files
from .web import routes_file, service_file


def _generate(spec: dict, settings: dict, open_api: str) -> list[dict]:
    context = create_context(spec, settings)
    code = [main_file(context), *common_files(context), *shared_files(context)]
    code.extend(file for file in (security_file(context), database_file(context)) if file)
    for resource in spec["resources"]:
        entity = entity_file(context, resource)
        code.extend(
            [
                domain_file(context, resource),
                dto_file(context, resource),
                *([entity] if entity else []),
                repository_file(context, resource),
                service_file(context, resource),
                routes_file(context, resource),
            ]
        )
    code.extend(module_files(context, [file["path"] for file in code]))
    return [
        readme_file(context),
        env_example_file(context),
        gitignore_file(),
        {"path": "openapi.yaml", "content": open_api},
        cargo_file(context),
        *code,
        *test_files(context),
    ]


AXUM_GENERATOR = {"framework": "axum", "serverUrl": "http://localhost:8080", "generate": _generate}
