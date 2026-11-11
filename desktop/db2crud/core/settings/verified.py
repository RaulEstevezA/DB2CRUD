"""Stacks whose generated projects have been built and whose own tests have passed with their real tools, in Docker
(verification/run.sh). Mirrors web/src/core/settings/verified.ts."""

VERIFIED = [
    {
        "language": "python",
        "orm": "sqlalchemy",
        "database": "postgresql",
        "execution": "sync",
        "scenarios": ["sqlalchemy-postgresql-sync", "sqlalchemy-postgresql-services-tests-only"],
        "date": "2026-11-11",
    },
    {
        "language": "python",
        "orm": "sqlalchemy",
        "database": "postgresql",
        "execution": "async",
        "scenarios": ["sqlalchemy-postgresql-async-caller-by-table"],
        "date": "2026-11-11",
    },
    {
        "language": "python",
        "orm": "sqlalchemy",
        "database": "mysql",
        "execution": "sync",
        "scenarios": ["sqlalchemy-mysql-sync-pydantic"],
        "date": "2026-11-11",
    },
    {
        "language": "python",
        "orm": "sqlalchemy",
        "database": "mysql",
        "execution": "async",
        "scenarios": ["sqlalchemy-mysql-async-decided"],
        "date": "2026-11-11",
    },
    {
        "language": "python",
        "orm": "sqlalchemy",
        "database": "mariadb",
        "execution": "sync",
        "scenarios": ["sqlalchemy-mariadb-sync-decided"],
        "date": "2026-11-11",
    },
    {
        "language": "python",
        "orm": "sqlalchemy",
        "database": "mariadb",
        "execution": "async",
        "scenarios": ["sqlalchemy-mariadb-async-dataclass-cursor"],
        "date": "2026-11-11",
    },
    {
        "language": "python",
        "orm": "sqlalchemy",
        "database": "sqlite",
        "execution": "sync",
        "scenarios": [
            "sqlalchemy-sqlite-defaults",
            "sqlalchemy-sqlite-database-services-get",
            "sqlalchemy-sqlite-repositories-only",
        ],
        "date": "2026-11-11",
    },
    {
        "language": "python",
        "orm": "sqlalchemy",
        "database": "sqlite",
        "execution": "async",
        "scenarios": ["sqlalchemy-sqlite-async-repository-commits"],
        "date": "2026-11-11",
    },
    {
        "language": "python",
        "orm": "django",
        "database": "sqlite",
        "execution": "sync",
        "scenarios": ["django-sqlite-defaults"],
        "date": "2026-11-11",
    },
    {
        "language": "python",
        "orm": "django",
        "database": "postgresql",
        "execution": "sync",
        "scenarios": ["django-postgresql-pydantic", "django-postgresql-repository-commits"],
        "date": "2026-11-11",
    },
    {
        "language": "python",
        "orm": "django",
        "database": "mysql",
        "execution": "sync",
        "scenarios": ["django-mysql-decided-cursor-by-table"],
        "date": "2026-11-11",
    },
    {
        "language": "python",
        "orm": "django",
        "database": "mariadb",
        "execution": "sync",
        "scenarios": ["django-mariadb-caller-dataclass"],
        "date": "2026-11-11",
    },
]


def is_verified(stack: dict) -> bool:
    """Whether this stack has passed the verification."""
    return any(
        all(item[key] == stack[key] for key in ("language", "orm", "database", "execution")) for item in VERIFIED
    )
