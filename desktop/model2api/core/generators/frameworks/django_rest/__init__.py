"""Django REST Framework generator: writes a Python project with Django, Django REST Framework and the Django ORM.
It composes the modules of this folder; each writes one kind of file. Mirrors
web/src/core/generators/frameworks/djangoRest/index.ts.
"""

from .context import Modules, create_context
from .models import enum_blocks, model_blocks
from .project import config_files, env_example_file, gitignore_file, readme_file, requirements_files
from .serializers import serializer_blocks
from .tests import test_files
from .views import service_and_view_blocks


def _generate(spec: dict, settings: dict, open_api: str) -> list[dict]:
    context = create_context(spec, settings)
    modules = Modules()
    enum_blocks(context, modules)
    model_blocks(context, modules)
    serializer_blocks(context, modules)
    urls = service_and_view_blocks(context, modules)
    return [
        readme_file(context),
        *requirements_files(context),
        env_example_file(context),
        gitignore_file(),
        {"path": "openapi.yaml", "content": open_api},
        *config_files(context),
        *modules.files(),
        *urls,
        *test_files(context),
    ]


DJANGO_REST_GENERATOR = {"framework": "djangoRest", "serverUrl": "http://localhost:8000", "generate": _generate}
