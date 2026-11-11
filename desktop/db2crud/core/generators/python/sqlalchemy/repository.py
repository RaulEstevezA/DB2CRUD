"""The bodies of the SQLAlchemy repositories. Mirrors web/src/core/generators/python/sqlalchemy/repository.ts."""

from ..common.context import aw
from ..python import Imports


def _soft_filter(info: dict) -> str | None:
    """The filter that leaves out rows marked as deleted."""
    soft = info["soft"]
    if not soft:
        return None
    attr = f"{info['entity']}.{soft['attr']}"
    return f"{attr}.is_(False)" if soft["column"]["type"]["kind"] == "boolean" else f"{attr}.is_(None)"


def _where(info: dict, conditions: list[str]) -> str:
    every = [item for item in [*conditions, _soft_filter(info)] if item is not None]
    return f".where({', '.join(every)})" if every else ""


def _key_columns(info: dict) -> str:
    return ", ".join(f"{info['entity']}.{column['attr']}" for column in info["key"])


def sql_body(context: dict, info: dict, method: dict, imports: Imports) -> list:
    a = aw(context)
    entity = info["entity"]
    equals = [f"{entity}.{param['name']} == {param['name']}" for param in method["params"]]
    commit = context["settings"]["transactions"] == "repository"

    def write(action: str) -> list:
        imports.from_("sqlalchemy.exc", "IntegrityError").from_("app.errors", "ConflictError")
        return [
            action,
            "try:",
            f"    {a}self._session.flush()",
            "except IntegrityError as error:",
            f"    {a}self._session.rollback()",
            f'    raise ConflictError("{entity}", "the database refused the change: " + str(error.orig)) from error',
            commit and f"{a}self._session.commit()",
        ]

    kind = method["query"]["kind"]
    if kind in ("getByKey", "findByUnique"):
        imports.from_("sqlalchemy", "select")
        return [f"return ({a}self._session.scalars(select({entity}){_where(info, equals)})).first()"]
    if kind in ("listByParent", "findAllBy"):
        imports.from_("sqlalchemy", "select")
        order = _key_columns(info)
        return [
            f"return list(({a}self._session.scalars(select({entity}){_where(info, equals)}.order_by({order}))).all())"
        ]
    if kind == "list":
        imports.from_("sqlalchemy", "select")
        base = f"query = select({entity}){_where(info, [])}"
        paging = context["settings"]["paging"]
        if paging == "offset":
            imports.from_("sqlalchemy", "func")
            return [
                base,
                f"total = {a}self._session.scalar(select(func.count()).select_from(query.subquery())) or 0",
                f"rows = ({a}self._session.scalars(query.order_by({_key_columns(info)}).offset(offset).limit(limit))).all()",
                "return Page(items=list(rows), total=total, offset=offset, limit=limit)",
            ]
        if paging == "cursor":
            single = len(info["key"]) == 1
            if not single:
                imports.from_("sqlalchemy", "tuple_")
            after = (
                f"{entity}.{info['key'][0]['attr']} > after[0]"
                if single
                else f"tuple_({_key_columns(info)}) > tuple_(*after)"
            )
            last = ", ".join(f"rows[-1].{column['attr']}" for column in info["key"])
            return [
                base,
                "if after is not None:",
                f"    query = query.where({after})",
                f"rows = list(({a}self._session.scalars(query.order_by({_key_columns(info)}).limit(limit + 1))).all())",
                "more = len(rows) > limit",
                "rows = rows[:limit]",
                f"last = ({last},) if more else None",
                "return CursorPage(items=rows, next=last)",
            ]
        return [base, f"return list(({a}self._session.scalars(query.order_by({_key_columns(info)}))).all())"]
    if kind in ("insert", "update"):
        return [*write("self._session.add(entity)"), f"{a}self._session.refresh(entity)", "return entity"]
    if kind == "delete":
        return write(f"{a}self._session.delete(entity)")
    return ["raise NotImplementedError"]
