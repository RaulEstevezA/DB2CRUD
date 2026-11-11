"""The CRUD design (docs/design.md, section 3): what will be generated for each table of a physical schema.
Mirrors web/src/core/crud/types.ts.

A design is a dictionary: {"policies", "repositories", "services"}. A policy is {"table", "role", "delete",
"concurrency", "children" (a decision, or None), "hidden"}; a repository {"table", "entity", "entityMissing",
"queries"}; a service {"table", "name", "operations"}. Names are language-neutral camelCase (getById); each generator
writes them in its language's convention.
"""

POLICY_DECISIONS = ("role", "delete", "concurrency", "children", "hidden")


def find_policy(design: dict, table: str) -> dict | None:
    return next((policy for policy in design["policies"] if policy["table"] == table), None)


def find_repository(design: dict, table: str) -> dict | None:
    return next((repository for repository in design["repositories"] if repository["table"] == table), None)


def find_service(design: dict, table: str) -> dict | None:
    return next((service for service in design["services"] if service["table"] == table), None)
