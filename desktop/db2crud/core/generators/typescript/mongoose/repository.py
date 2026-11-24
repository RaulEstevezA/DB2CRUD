"""The Mongoose repositories, over the models of a connection and, when there is one, the session of a transaction:
documents become the project's plain entities (identifiers, exact decimals and bytes as text, numbers and buffers),
reads leave out documents marked as deleted, pages go by offset or after a key, and a change writes only the fields
that are not as they were read, so two people changing different fields do not undo each other. Mirrors
web/src/core/generators/typescript/mongoose/repository.ts."""

from ..common.context import column_type, is_in, query
from ..typescript import TsImports, quote
from .models import IDENTIFIER, field_key, models_module


def _changeable(info: dict, column: dict) -> bool:
    return (
        not is_in(column, info["key"])
        and not column["generated"]
        and column["column"].get("generated") != "onUpdateNow"
    )


def _access(name: str) -> str:
    """A field of a document as code reads it: document.name, document['a b']."""
    return f"document.{name}" if IDENTIFIER.fullmatch(name) else f"document[{quote(name)}]"


def _pairs(columns: list[dict], target: str) -> list[str]:
    return [f"    {field_key(column['column']['name'])}: {target}.{column['prop']}," for column in columns]


def mongoose_helpers(context: dict, info: dict, imports: TsImports) -> list:
    """toEntity, storedValues and changesOf of a collection."""
    imports.from_("src/database", "plain").type(models_module(context), "Stored")
    changes = [column for column in info["columns"] if _changeable(info, column)]
    updates = query(info, "update") is not None and bool(changes)
    entity = info["entity"]
    result: list = []
    if updates:
        result += [
            "/** The values each entity was read with, by the stored names of its fields: a change writes only those that differ. */",
            f"const loaded = new WeakMap<{entity}, Record<string, string>>()",
            "",
            "/** The fields of an entity a change may write. */",
            f"function changeable(entity: {entity}): Stored {{",
            "  return {",
            *_pairs(changes, "entity"),
            "  }",
            "}",
            "",
            "/** The same fields as text, to compare them later. */",
            f"const snapshot = (entity: {entity}): Record<string, string> =>",
            "  Object.fromEntries(Object.entries(changeable(entity)).map(([name, value]) => [name, JSON.stringify(value ?? null)]))",
            "",
        ]
    result += [
        f"/** The {entity} of a document; a field it does not have is null. */",
        f"function toEntity(document: Stored): {entity} {{",
        f"  {'const entity =' if updates else 'return'} Object.assign(new {entity}(), {{",
        *(
            f"    {column['prop']}: (plain({_access(column['column']['name'])}) ?? null) as {column_type(column)},"
            for column in info["columns"]
        ),
        "  })",
        *(["  loaded.set(entity, snapshot(entity))", "  return entity"] if updates else []),
        "}",
    ]
    if query(info, "insert"):
        result += [
            "",
            "/** The fields of a new document; those left empty are not stored, and take their default. */",
            f"function storedValues(entity: {entity}): Stored {{",
            "  const values: Stored = {",
            *_pairs(info["columns"], "entity"),
            "  }",
            "  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null))",
            "}",
        ]
    if updates:
        touched = []
        for column in info["columns"]:
            if column["column"].get("generated") == "onUpdateNow":
                name = column["column"]["name"]
                target = f".{name}" if IDENTIFIER.fullmatch(name) else f"[{quote(name)}]"
                touched.append(f"  $set{target} = new Date()")
        result += [
            "",
            "/** What a change writes and what it removes: only the fields that are not as they were read. */",
            f"function changesOf(entity: {entity}): {{ $set: Stored; $unset: Stored }} {{",
            "  const before = loaded.get(entity)",
            "  const $set: Stored = {}",
            "  const $unset: Stored = {}",
            "  for (const [name, value] of Object.entries(changeable(entity))) {",
            "    if (before?.[name] === JSON.stringify(value ?? null)) continue",
            "    if (value === undefined || value === null) $unset[name] = ''",
            "    else $set[name] = value",
            "  }",
            *touched,
            "  return { $set, $unset }",
            "}",
        ]
    return result


def _soft_condition(info: dict) -> str | None:
    """The condition that leaves out documents marked as deleted: a field that is not there is null."""
    soft = info["soft"]
    if not soft:
        return None
    name = field_key(soft["column"]["name"])
    return f"{name}: {{ $ne: true }}" if soft["column"]["type"]["kind"] == "boolean" else f"{name}: null"


def _filter_of(conditions: list) -> str:
    present = [item for item in conditions if item is not None]
    return f"{{ {', '.join(present)} }}" if present else "{}"


def _equal(column: dict, value: str) -> str:
    key = field_key(column["column"]["name"])
    return key if key == value else f"{key}: {value}"


def _write(info: dict, action: list[str], imports: TsImports) -> list[str]:
    """A write, with a refusal of the database or of the schema turned into a domain error."""
    imports.from_("src/database", "refusal")
    return [
        "try {",
        *(f"  {line}" for line in action),
        "} catch (error) {",
        f"  throw refusal('{info['entity']}', error)",
        "}",
    ]


def mongoose_body(context: dict, info: dict, method: dict, imports: TsImports) -> list[str]:
    model = f"this.db.models.{info['attr']}"
    columns = [
        next(item for item in info["columns"] if item["column"]["name"] == name) for name in method["query"]["columns"]
    ]
    by_params = [_equal(column, column["prop"]) for column in columns]
    soft = _soft_condition(info)
    sort = f".sort({{ {', '.join(field_key(column['column']['name']) + ': 1' for column in info['key'])} }})"
    session = ".session(this.session).lean<Stored>()"
    many = ".session(this.session).lean<Stored[]>()"
    key = _filter_of([_equal(column, f"entity.{column['prop']}") for column in info["key"]])
    # A text that is not an identifier points to nothing, and Mongoose would fail to make it one
    identifiers = [column for column in columns if column["column"]["type"].get("objectId")]
    kind = method["query"]["kind"]
    if identifiers and kind in ("getByKey", "findByUnique", "listByParent", "findAllBy"):
        imports.from_("src/database", "isObjectId")

    def guard(empty: str) -> list[str]:
        return [f"if (!isObjectId({column['prop']})) return {empty}" for column in identifiers]

    if kind in ("getByKey", "findByUnique"):
        return [
            *guard("null"),
            f"const foundDocument = await {model}.findOne({_filter_of([*by_params, soft])}){session}",
            "return foundDocument === null ? null : toEntity(foundDocument)",
        ]
    if kind in ("listByParent", "findAllBy"):
        condition = _filter_of([*by_params, soft])
        return [*guard("[]"), f"return (await {model}.find({condition}){sort}{many}).map(toEntity)"]
    if kind == "list":
        condition = _filter_of([soft])
        paging = context["settings"]["paging"]
        if paging == "offset":
            return [
                f"const documents = await {model}.find({condition}){sort}.skip(offset).limit(limit){many}",
                f"const total = await {model}.countDocuments({condition}).session(this.session)",
                "return { items: documents.map(toEntity), total, offset, limit }",
            ]
        if paging == "cursor":
            # After the key (a, b): a greater, or a the same and b greater
            options = []
            for index, column in enumerate(info["key"]):
                parts = [
                    f"{field_key(before['column']['name'])}: after[{position}]"
                    for position, before in enumerate(info["key"][:index])
                ]
                parts.append(f"{field_key(column['column']['name'])}: {{ $gt: after[{index}] }}")
                options.append(f"{{ {', '.join(parts)} }}")
            after = options[0] if len(options) == 1 else f"{{ $or: [{', '.join(options)}] }}"
            following = f"{{ $and: [{condition}, {after}] }}" if soft else after
            last = ", ".join(f"last.{column['prop']}" for column in info["key"])
            return [
                f"const filter = after === null ? {condition} : {following}",
                f"const rows = (await {model}.find(filter){sort}.limit(limit + 1){many}).map(toEntity)",
                "const items = rows.slice(0, limit)",
                "const last = items[items.length - 1]",
                f"return {{ items, next: rows.length > limit ? [{last}] : null }}",
            ]
        return [f"return (await {model}.find({condition}){sort}{many}).map(toEntity)"]
    changes = any(_changeable(info, column) for column in info["columns"])
    if kind == "insert":
        # The identifier and the defaults are read back into the entity
        stored = (
            [
                "Object.assign(entity, stored)",
                "loaded.set(entity, loaded.get(stored)!)",
                "return entity",
            ]
            if changes and query(info, "update")
            else ["return Object.assign(entity, stored)"]
        )
        return _write(
            info,
            [
                f"const [document] = await {model}.create([storedValues(entity)], {{ session: this.session ?? undefined }})",
                "const stored = toEntity(document.toObject() as Stored)",
                *stored,
            ],
            imports,
        )
    if kind == "update":
        if not changes:
            return ["// Nothing of it can change but its key", "return entity"]
        options = "{ session: this.session ?? undefined, runValidators: true, timestamps: false }"
        return [
            *_write(info, [f"await {model}.updateOne({key}, changesOf(entity), {options})"], imports),
            "loaded.set(entity, snapshot(entity))",
            "return entity",
        ]
    if kind == "delete":
        return _write(info, [f"await {model}.deleteOne({key}).session(this.session)"], imports)
    return ["throw new Error('not written')"]
