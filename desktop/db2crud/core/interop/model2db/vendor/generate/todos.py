"""Mirrors web/src/core/generate/todos.ts."""


def todo_text(todo: dict, model: str, kind: str) -> str:
    """The comment written for a decision still pending, in English like the rest of the generated code.
    `kind` names what the database stores models in: `table`, `collection` of documents, or Redis `hash`."""
    params = todo["params"]
    key = "primary key" if kind == "table" else "_id" if kind == "collection" else "key"
    code = todo["code"]
    if code == "relationPending":
        return f'TODO: decide how "{model}.{params["field"]}" is stored (pending in the design).'
    if code == "keyPending":
        return f'TODO: choose the {key} of "{params["model"]}".'
    if code == "targetNotStored":
        return f'TODO: "{model}.{params["field"]}" points to "{params["model"]}", which has no {kind} of its own.'
    return f'TODO: "{params["column"]}" refers to "{params["model"]}", whose {key} is not decided yet.'
