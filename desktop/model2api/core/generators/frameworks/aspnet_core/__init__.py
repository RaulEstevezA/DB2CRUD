"""ASP.NET Core generator: writes a .NET 10 project with controllers, DataAnnotations validation, authentication (API
key or JWT bearer) and Entity Framework Core when it is chosen, with an xUnit test project. It composes the modules of
this folder; each writes one kind of file. Mirrors web/src/core/generators/frameworks/aspnetCore/index.ts.
"""

from .common import common_files, data_files, program_file, security_files
from .context import create_context
from .model import domain_file, dto_files, shared_files
from .persistence import repository_files
from .project import gitignore_file, project_files, readme_file
from .tests import test_files
from .web import controller_file, service_file


def _generate(spec: dict, settings: dict, open_api: str) -> list[dict]:
    context = create_context(spec, settings)
    code = [
        program_file(context),
        *common_files(context),
        *security_files(context),
        *data_files(context),
        *shared_files(context),
    ]
    for resource in spec["resources"]:
        code.extend(
            [
                domain_file(context, resource),
                *dto_files(context, resource),
                *repository_files(context, resource),
                service_file(context, resource),
                controller_file(context, resource),
            ]
        )
    return [
        readme_file(context),
        gitignore_file(),
        {"path": "openapi.yaml", "content": open_api},
        *project_files(context),
        *code,
        *test_files(context),
    ]


ASPNET_CORE_GENERATOR = {"framework": "aspnetCore", "serverUrl": "http://localhost:5000", "generate": _generate}
