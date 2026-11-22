"""The JPA repositories, over an EntityManager: JPQL reads that leave out rows marked as deleted, writes flushed at once
so a database refusal becomes a ConflictException, and the values the database fills read back after an insert. Mirrors
web/src/core/generators/java/jpa/repository.ts."""

from ..context import column_of, errors_package, jpql_name, sql_repository_class
from ..java import JavaImports


def _soft_condition(info: dict) -> str | None:
    """JPQL that leaves out rows marked as deleted."""
    soft = info["soft"]
    if not soft:
        return None
    return f"e.{soft['prop']} = false" if soft["column"]["type"]["kind"] == "boolean" else f"e.{soft['prop']} is null"


def _order(info: dict) -> str:
    return f" order by {', '.join('e.' + column['prop'] for column in info['key'])}"


def _where(conditions: list) -> str:
    present = [item for item in conditions if item is not None]
    return f" where {' and '.join(present)}" if present else ""


def _by_params(columns: list[dict]) -> list[str]:
    return [f"e.{column['prop']} = :{column['prop']}" for column in columns]


def _parameters(columns: list[dict]) -> str:
    return "".join(f'.setParameter("{column["prop"]}", {column["prop"]})' for column in columns)


def _write(context: dict, info: dict, action: list[str], imports: JavaImports) -> list:
    """A write, flushed at once, with a database refusal turned into a ConflictException."""
    imports.add("jakarta.persistence.PersistenceException", f"{errors_package(context)}.ConflictException")
    if context["settings"]["transactions"] == "caller":
        inner = [f"    {line}" for line in action]
    else:
        inner = ["    inTransaction(() -> {", *(f"        {line}" for line in action), "    });"]
    return [
        "try {",
        *inner,
        "} catch (PersistenceException error) {",
        f'    throw new ConflictException("{info["entity"]}", "the database refused the change: " + error.getMessage());',
        "}",
    ]


def jpa_body(context: dict, info: dict, method: dict, imports: JavaImports) -> list:
    entity = info["entity"]
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    soft = _soft_condition(info)
    name = jpql_name(info)

    def select(conditions: list) -> str:
        return f'"select e from {name} e{_where(conditions)}'

    kind = method["query"]["kind"]
    paging = context["settings"]["paging"]
    if kind in ("getByKey", "findByUnique"):
        return [
            f'return entityManager.createQuery({select([*_by_params(columns), soft])}", {entity}.class){_parameters(columns)}',
            "        .getResultStream()",
            "        .findFirst();",
        ]
    if kind in ("listByParent", "findAllBy"):
        return [
            f'return entityManager.createQuery({select([*_by_params(columns), soft])}{_order(info)}", {entity}.class){_parameters(columns)}.getResultList();'
        ]
    if kind == "list":
        if paging == "offset":
            imports.add("java.util.List")
            return [
                f'List<{entity}> items = entityManager.createQuery({select([soft])}{_order(info)}", {entity}.class)',
                "        .setFirstResult(offset)",
                "        .setMaxResults(limit)",
                "        .getResultList();",
                f'long total = entityManager.createQuery("select count(e) from {name} e{_where([soft])}", Long.class).getSingleResult();',
                "return new Page<>(items, total, offset, limit);",
            ]
        if paging == "cursor":
            imports.add("java.util.ArrayList", "java.util.List")
            # After the key (a, b): a greater, or a the same and b greater
            key = info["key"]
            options = []
            for index, column in enumerate(key):
                parts = [f"e.{before['prop']} = :k{position}" for position, before in enumerate(key[:index])]
                parts.append(f"e.{column['prop']} > :k{index}")
                item = " and ".join(parts)
                options.append(f"({item})" if len(key) > 1 else item)
            after = " or ".join(options)
            conditions = [item for item in (soft, f"({after})") if item is not None]
            last = ", ".join(f"last.{column['getter']}()" for column in key)
            return [
                f'String jpql = after == null ? {select([soft])}{_order(info)}" : {select(conditions)}{_order(info)}";',
                f"var query = entityManager.createQuery(jpql, {entity}.class).setMaxResults(limit + 1);",
                *(
                    f'if (after != null) query.setParameter("k{index}", after.get({index}));'
                    for index in range(len(key))
                ),
                f"List<{entity}> rows = query.getResultList();",
                f"List<{entity}> items = new ArrayList<>(rows.subList(0, Math.min(limit, rows.size())));",
                f"{entity} last = items.isEmpty() ? null : items.get(items.size() - 1);",
                f"return new CursorPage<>(items, rows.size() > limit ? List.of({last}) : null);",
            ]
        return [f'return entityManager.createQuery({select([soft])}{_order(info)}", {entity}.class).getResultList();']
    if kind == "insert":
        action = [
            "entityManager.persist(entity);",
            "entityManager.flush();",
            "// Reads back what the database filled: the key, defaults",
            "entityManager.refresh(entity);",
        ]
        return [*_write(context, info, action, imports), "return entity;"]
    if kind == "update":
        action = ["stored[0] = entityManager.merge(entity);", "entityManager.flush();"]
        return [f"{entity}[] stored = new {entity}[1];", *_write(context, info, action, imports), "return stored[0];"]
    if kind == "delete":
        action = [
            "entityManager.remove(entityManager.contains(entity) ? entity : entityManager.merge(entity));",
            "entityManager.flush();",
        ]
        return _write(context, info, action, imports)
    return ["throw new UnsupportedOperationException();"]


def jpa_head(context: dict, info: dict, imports: JavaImports) -> list:
    """The EntityManager of the repository, and its constructor."""
    imports.add("jakarta.persistence.EntityManager")
    if context["settings"]["transactions"] != "caller":
        imports.add("jakarta.persistence.EntityTransaction")
    return [
        "    protected final EntityManager entityManager;",
        "",
        f"    public {sql_repository_class(info)}(EntityManager entityManager) {{",
        "        this.entityManager = entityManager;",
        "    }",
    ]


def jpa_tail(context: dict, _info: dict, _imports: JavaImports) -> list:
    """Runs a write in the transaction already open, or in one of its own, unless the caller owns the transaction."""
    if context["settings"]["transactions"] == "caller":
        return []
    return [
        "",
        "    /** Runs a write in the transaction already open, or in one of its own. */",
        "    private void inTransaction(Runnable write) {",
        "        EntityTransaction transaction = entityManager.getTransaction();",
        "        if (transaction.isActive()) {",
        "            write.run();",
        "            return;",
        "        }",
        "        transaction.begin();",
        "        try {",
        "            write.run();",
        "            transaction.commit();",
        "        } catch (RuntimeException error) {",
        "            if (transaction.isActive()) transaction.rollback();",
        "            throw error;",
        "        }",
        "    }",
    ]
