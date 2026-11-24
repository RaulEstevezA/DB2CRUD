"""Registry of the generators (Registry pattern). Mirrors web/src/core/generators/registry.ts."""

from ..conversions.plan import conversions_available
from ..settings.settings import normalize_settings
from .csharp.efcore.index import EFCORE_ORM
from .csharp.generator import csharp_generator
from .csharp.sql.index import SQL_ORM as CSHARP_SQL_ORM
from .java.generator import java_generator
from .java.jpa.index import JPA_ORM
from .java.springdata.index import SPRING_DATA_ORM
from .java.sql.index import SQL_ORM as JAVA_SQL_ORM
from .kotlin.exposed.index import EXPOSED_ORM
from .kotlin.generator import kotlin_generator
from .kotlin.sql.index import SQL_ORM as KOTLIN_SQL_ORM
from .php.common.generator import php_generator
from .php.doctrine.index import DOCTRINE_ORM
from .php.eloquent.index import ELOQUENT_ORM
from .php.sql.index import SQL_ORM as PHP_SQL_ORM
from .python.common.generator import python_generator
from .python.django.index import DJANGO_ORM
from .python.sql.index import SQL_ORM as PYTHON_SQL_ORM
from .python.sqlalchemy.index import SQLALCHEMY_ORM
from .rust.generator import rust_generator
from .rust.seaorm.index import SEAORM_ORM
from .rust.sql.index import SQL_ORM as RUST_SQL_ORM
from .swift.fluent.index import FLUENT_ORM
from .swift.generator import swift_generator
from .swift.sql.index import SQL_ORM as SWIFT_SQL_ORM
from .typescript.common.generator import typescript_generator
from .typescript.drizzle.index import DRIZZLE_ORM
from .typescript.mongoose.index import MONGOOSE_ORM
from .typescript.prisma.index import PRISMA_ORM
from .typescript.sequelize.index import SEQUELIZE_ORM
from .typescript.sql.index import SQL_ORM as TYPESCRIPT_SQL_ORM
from .typescript.typeorm.index import TYPEORM_ORM

GENERATORS = [
    python_generator(SQLALCHEMY_ORM),
    python_generator(DJANGO_ORM),
    python_generator(PYTHON_SQL_ORM),
    typescript_generator(TYPEORM_ORM),
    typescript_generator(PRISMA_ORM),
    typescript_generator(DRIZZLE_ORM),
    typescript_generator(SEQUELIZE_ORM),
    typescript_generator(TYPESCRIPT_SQL_ORM),
    typescript_generator(MONGOOSE_ORM),
    java_generator(JPA_ORM),
    java_generator(JAVA_SQL_ORM),
    java_generator(SPRING_DATA_ORM),
    csharp_generator(EFCORE_ORM),
    csharp_generator(CSHARP_SQL_ORM),
    php_generator(DOCTRINE_ORM),
    php_generator(ELOQUENT_ORM),
    php_generator(PHP_SQL_ORM),
    kotlin_generator(EXPOSED_ORM),
    kotlin_generator(KOTLIN_SQL_ORM),
    rust_generator(SEAORM_ORM),
    rust_generator(RUST_SQL_ORM),
    swift_generator(FLUENT_ORM),
    swift_generator(SWIFT_SQL_ORM),
]


def find_generator(settings: dict) -> dict | None:
    return next(
        (item for item in GENERATORS if item["language"] == settings["language"] and item["orm"] == settings["orm"]),
        None,
    )


def _without_items(design: dict, settings: dict) -> dict:
    """The design without the operations on one item of a list, which only document databases have."""
    if settings["database"] == "mongodb":
        return design

    def whole(items: list[dict]) -> list[dict]:
        return [item for item in items if item["kind"] not in ("addItem", "removeItem")]

    return {
        **design,
        "repositories": [{**item, "queries": whole(item["queries"])} for item in design["repositories"]],
        "services": [{**item, "operations": whole(item["operations"])} for item in design["services"]],
    }


def generate_project(schema: dict, design: dict, settings: dict, models: dict | None = None) -> list[dict]:
    """The files of the project, sorted by path, for settings made consistent first. With application models, their
    conversions are written only when the models are in the project's language, or in none (`conversions_available`);
    otherwise the project is the one without models."""
    normalized = normalize_settings(settings)
    generator = find_generator(normalized)
    if not generator:
        return []
    usable = models if models and conversions_available(models, normalized["language"])["ok"] else None
    return sorted(
        generator["generate"](schema, _without_items(design, normalized), normalized, usable),
        key=lambda file: file["path"],
    )
