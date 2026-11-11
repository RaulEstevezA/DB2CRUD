"""The service of each table: its operations and what each one checks before it writes, in the order of the design
(docs/design.md, section 3): the values against the database's rules, the rows they point to, unique values, the
version; then children and soft deletes. Every write runs in uow.transaction(...). Services take and return
entities or DTOs, as the settings say, and throw domain errors without HTTP codes. Mirrors
web/src/core/generators/typescript/common/services.ts."""

from ....js import number_text
from ...python.python import js_json
from ...types import indent, lines
from ..typescript import TsImports
from .context import (
    column_of,
    find_info,
    is_in,
    module_of,
    operation_name,
    path_of,
    query,
    query_name,
    service_class,
)
from .dtos import create_columns, create_dto, read_columns, read_dto, update_dto


def _repo(info: dict, uow: str = "uow") -> str:
    return f"{uow}.{info['attr']}"


def _in_transaction(body: list) -> list:
    """The body inside this.uow.transaction(async (uow) => { … })."""
    return ["return this.uow.transaction(async (uow) => {", indent(lines(*body), 2), "})"]


def _key_params(info: dict) -> str:
    return ", ".join(f"{column['prop']}: {column['ts']}" for column in info["key"])


def _key_args(info: dict) -> str:
    return ", ".join(column["prop"] for column in info["key"])


def _key_value(info: dict) -> str:
    return info["key"][0]["prop"] if len(info["key"]) == 1 else f"[{_key_args(info)}]"


def _other_row(info: dict) -> str:
    """True when `other` is another row than `current`, compared by key: ORMs return a new object for each read."""
    return " || ".join(f"other.{column['prop']} !== current.{column['prop']}" for column in info["key"])


def _text(value) -> str:
    return value if isinstance(value, str) else number_text(value)


def _quoted(props: list[str]) -> str:
    return ", ".join(f"'{prop}'" for prop in props)


# Checks


def _value_rules(column: dict, checks: list[dict]) -> list[str]:
    """The rules a value must follow, from the column's type and the CHECK constraints the rules understand."""
    rules = []
    name = column["column"]["name"]
    column_type = column["column"]["type"]
    if column_type["kind"] == "text" and "length" in column_type:
        length = column_type["length"]
        rules.append(
            f"if (typeof value === 'string' && value.length > {length}) errors.push({{ field: '{name}', message: 'is longer than {length} characters' }})"
        )
    for check in checks:
        parsed = check.get("parsed")
        if not parsed or parsed["column"] != name:
            continue
        if parsed["kind"] == "in":
            choices = ", ".join(js_json(item).replace('"', "'") for item in parsed["values"])
            listed = ", ".join(_text(item) for item in parsed["values"])
            rules.append(
                f"if (![{choices}].includes(value as never)) errors.push({{ field: '{name}', message: 'must be one of: {listed}' }})"
            )
        if parsed["kind"] == "compare":
            op, limit = parsed["op"], number_text(parsed["value"])
            rules.append(
                f"if (!(Number(value) {op} {limit})) errors.push({{ field: '{name}', message: 'must be {op} {limit}' }})"
            )
        if parsed["kind"] == "length":
            op, limit = parsed["op"], number_text(parsed["value"])
            rules.append(
                f"if (!(String(value).length {op} {limit})) errors.push({{ field: '{name}', message: 'must have {op} {limit} characters' }})"
            )
    return rules


def _validate_method(writer: dict) -> list:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    imports.from_("src/errors", "ValidationFailedError").type("src/errors", "FieldError").type(
        "src/unit-of-work", "UnitOfWork"
    )
    blocks = []
    for column in create_columns(info):
        name = column["column"]["name"]
        prop = column["prop"]
        if column["required"]:
            missing = f"if (creating || '{prop}' in values) errors.push({{ field: '{name}', message: 'is required' }})"
        elif not column["column"]["nullable"]:
            missing = (
                f"if ('{prop}' in values && !creating) errors.push({{ field: '{name}', message: 'cannot be empty' }})"
            )
        else:
            missing = None
        rules = _value_rules(column, info["table"]["checks"])
        if not missing and not rules:
            continue
        blocks.append(
            lines(
                "{",
                f"  const value = values.{prop}",
                ["  if (value == null) {", f"    {missing}", "  } else {" if rules else "  }"]
                if missing
                else bool(rules) and "  if (value != null) {",
                *(f"    {rule}" for rule in rules),
                bool(rules) and "  }",
                "}",
            )
        )
    # Parents
    for key in info["table"]["foreignKeys"]:
        parent = find_info(context, key["references"]["table"])
        read = query(parent, "getByKey") if parent else None
        same_key = parent and ",".join(column["column"]["name"] for column in parent["key"]) == ",".join(
            key["references"]["columns"]
        )
        if not parent or not read or not same_key:
            blocks.append(
                f"// TODO: {', '.join(key['columns'])} must point to a row of {key['references']['table']}; that table has no read by key to check it"
            )
            continue
        props = [column_of(info, name)["prop"] for name in key["columns"]]
        types = [column["ts"] for column in parent["key"]]
        present = " && ".join(f"{prop} != null" for prop in props)
        args = ", ".join(f"{prop} as {types[index]}" for index, prop in enumerate(props))
        blocks.append(
            lines(
                "{",
                *(f"  const {prop} = '{prop}' in values ? values.{prop} : current?.{prop}" for prop in props),
                f"  if ({present} && (await {_repo(parent)}.{query_name(context, read)}({args})) === null)",
                f"    errors.push({{ field: '{', '.join(key['columns'])}', message: 'no {parent['entity']} has this key' }})",
                "}",
            )
        )
    # The key, what the database fills, and what the service itself keeps (the version, the soft-delete mark)
    unchangeable = [
        column
        for column in info["columns"]
        if column["generated"] or is_in(column, info["key"]) or column is info["version"] or column is info["soft"]
    ]
    entity = info["entity"]
    return [
        f'/** Checks the values against the rules of the "{info["name"]}" table, and the rows they point to; throws ValidationFailedError with every problem. */',
        f"private async validate(uow: UnitOfWork, values: Partial<Record<string, unknown>>, current: {entity} | null): Promise<void> {{",
        "  const creating = current === null",
        "  const errors: FieldError[] = []",
        f"  for (const name of Object.keys(values)) if (!FIELDS.has(name)) errors.push({{ field: name, message: 'is not a field of {entity}' }})",
        bool(unchangeable)
        and f"  if (!creating) for (const name of Object.keys(values)) if ([{_quoted([column['prop'] for column in unchangeable])}].includes(name)) errors.push({{ field: name, message: 'cannot be changed' }})",
        *(indent(block, 2) for block in blocks),
        f"  if (errors.length > 0) throw new ValidationFailedError('{entity}', errors)",
        "}",
    ]


def _unique_method(writer: dict) -> list:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    checks = []
    for unique in info["table"]["uniques"]:
        read = query(info, "findByUnique", unique["columns"])
        if not read:
            checks.append(
                f"// {', '.join(unique['columns'])} must be unique: the database refuses repeated values (ConflictError)"
            )
            continue
        imports.from_("src/errors", "ConflictError")
        columns = [column_of(info, name) for name in unique["columns"]]
        present = " && ".join(f"{column['prop']} != null" for column in columns)
        args = ", ".join(column["prop"] for column in columns)
        checks.append(
            lines(
                "{",
                *(
                    f"  const {column['prop']} = ('{column['prop']}' in values ? values.{column['prop']} : current?.{column['prop']}) as {column['ts']} | null | undefined"
                    for column in columns
                ),
                f"  if ({present}) {{",
                f"    const other = await {_repo(info)}.{query_name(context, read)}({args})",
                f"    if (other !== null && (current === null || {_other_row(info)}))",
                f"      throw new ConflictError('{info['entity']}', '{', '.join(unique['columns'])} is already taken', [{_quoted([column['prop'] for column in columns])}])",
                "  }",
                "}",
            )
        )
    if not checks:
        return []
    return [
        "/** Values that must be unique are not taken by another row. */",
        f"private async checkUnique(uow: UnitOfWork, values: Partial<Record<string, unknown>>, current: {info['entity']} | null): Promise<void> {{",
        *(indent(check, 2) for check in checks),
        "}",
    ]


def _check_method(writer: dict) -> list:
    info = writer["info"]
    return [
        "/** Every check before a write: the values, the rows they point to, the unique values. */",
        f"private async check(uow: UnitOfWork, values: Partial<Record<string, unknown>>, current: {info['entity']} | null): Promise<void> {{",
        "  await this.validate(uow, values, current)",
        bool(info["table"]["uniques"]) and "  await this.checkUnique(uow, values, current)",
        "}",
    ]


def _find_method(writer: dict) -> list:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    read = query(info, "getByKey")
    if not read:
        return []
    imports.from_("src/errors", "NotFoundError").type("src/unit-of-work", "UnitOfWork")
    entity = info["entity"]
    return [
        f"/** The {entity} with this key; NotFoundError when there is none. */",
        f"private async find(uow: UnitOfWork, {_key_params(info)}): Promise<{entity}> {{",
        f"  const entity = await {_repo(info)}.{query_name(context, read)}({_key_args(info)})",
        f"  if (entity === null) throw new NotFoundError('{entity}', {_key_value(info)})",
        "  return entity",
        "}",
    ]


def _read_method(writer: dict) -> list:
    if not writer["dtos"]:
        return []
    info = writer["info"]
    fields = ", ".join(f"{column['prop']}: entity.{column['prop']}" for column in read_columns(info))
    return [
        f"/** The {info['entity']} as services return it. */",
        f"private static read(entity: {info['entity']}): {read_dto(info)} {{",
        f"  return {{ {fields} }}",
        "}",
    ]


def _out(writer: dict, expression: str) -> str:
    return f"{service_class(writer['info'])}.read({expression})" if writer["dtos"] else expression


def _result_type(writer: dict) -> str:
    return read_dto(writer["info"]) if writer["dtos"] else writer["info"]["entity"]


def _defined(variable: str) -> str:
    """The values an object sets, leaving out what is undefined."""
    return f"Object.fromEntries(Object.entries({variable}).filter(([, value]) => value !== undefined))"


# Operations


def _version_check(writer: dict) -> list:
    version = writer["info"]["version"]
    if not version:
        return []
    writer["imports"].from_("src/errors", "ConflictError")
    return [
        f"if (current.{version['prop']} !== version)",
        f"  throw new ConflictError('{writer['info']['entity']}', 'was changed by someone else since it was read', ['{version['prop']}'])",
    ]


def _children_lines(writer: dict) -> list:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    if not info["children"]:
        return []
    result = []
    for link in info["children"]["links"]:
        child = find_info(context, link["table"])
        listing = query(child, "listByParent", link["columns"]) if child else None
        if not child or not listing:
            result.append(
                f"// TODO: rows of {link['table']} may point here; that table has no list by {', '.join(link['columns'])} to look for them"
            )
            continue
        args = ", ".join(f"current.{column_of(info, name)['prop']}" for name in link["references"])
        rows = f"await {_repo(child)}.{query_name(context, listing)}({args})"
        if info["children"]["policy"] == "block":
            imports.from_("src/errors", "ConflictError")
            result.append(
                f"if (({rows}).length > 0) throw new ConflictError('{info['entity']}', 'rows of {link['table']} still point to it', ['{link['table']}'])"
            )
        else:
            remove = query(child, "delete")
            if not remove:
                result.append(f"// TODO: rows of {link['table']} must be deleted first, and that table has no delete")
            else:
                result.append(f"for (const row of {rows}) await {_repo(child)}.{query_name(context, remove)}(row)")
    return result


def _list_lines(writer: dict, name: str) -> list:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    listing = query(info, "list")
    if not listing:
        return []
    method = f"this.uow.{info['attr']}.{query_name(context, listing)}"
    service = service_class(info)
    paging = context["settings"]["paging"]
    if paging in ("offset", "cursor"):
        offset = paging == "offset"
        imports.type("src/paging", "Page" if offset else "CursorPage")
        args = "offset, limit" if offset else "after, limit"
        return [
            f"/** A page of {info['name']}, by primary key. */"
            if offset
            else f"/** A page of {info['name']} after the key `after`, by primary key. */",
            f"async {name}(offset = 0, limit = 50): Promise<Page<{_result_type(writer)}>> {{"
            if offset
            else f"async {name}(after: unknown[] | null = null, limit = 50): Promise<CursorPage<{_result_type(writer)}>> {{",
            [
                f"  const page = await {method}({args})",
                f"  return {{ ...page, items: page.items.map((entity) => {service}.read(entity)) }}",
            ]
            if writer["dtos"]
            else f"  return {method}({args})",
            "}",
        ]
    return [
        f"/** Every {info['entity']}, by primary key. */",
        f"async {name}(): Promise<{_result_type(writer)}[]> {{",
        f"  return (await {method}()).map((entity) => {service}.read(entity))"
        if writer["dtos"]
        else f"  return {method}()",
        "}",
    ]


def _operation_lines(writer: dict, operation: dict) -> list:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    name = operation_name(context, operation)
    entity = info["entity"]
    kind = operation["kind"]
    dtos = writer["dtos"]
    if kind == "create":
        insert = query(info, "insert")
        if not insert:
            return []
        if dtos:
            imports.type(module_of(context, info, "dtos"), create_dto(info))
        variable = entity[:1].lower() + entity[1:]
        param = f"data: {create_dto(info)}" if dtos else f"{variable}: {entity}"
        values = (
            _defined("data")
            if dtos
            else f"Object.fromEntries([...FIELDS].map((field) => [field, ({variable} as unknown as Record<string, unknown>)[field]]))"
        )
        stored = f"Object.assign(new {entity}(), values)" if dtos else variable
        return [
            f"/** Stores a new {entity} after checking it. */",
            f"async {name}({param}): Promise<{_result_type(writer)}> {{",
            f"  const values: Partial<Record<string, unknown>> = {values}",
            indent(
                lines(
                    *_in_transaction(
                        [
                            "await this.check(uow, values, null)",
                            f"const created = await {_repo(info)}.{query_name(context, insert)}({stored})",
                            f"return {_out(writer, 'created')}",
                        ]
                    )
                ),
                2,
            ),
            "}",
        ]
    if kind == "get":
        if not query(info, "getByKey"):
            return []
        return [
            f"/** The {entity} with this key; NotFoundError when there is none. */",
            f"async {name}({_key_params(info)}): Promise<{_result_type(writer)}> {{",
            f"  return {_out(writer, f'await this.find(this.uow, {_key_args(info)})')}",
            "}",
        ]
    if kind == "list":
        return _list_lines(writer, name)
    if kind == "update":
        update = query(info, "update")
        if not update or not query(info, "getByKey"):
            return []
        if dtos:
            imports.type(module_of(context, info, "dtos"), update_dto(info))
        param = f"data: {update_dto(info)}" if dtos else f"changes: Partial<{entity}>"
        version = info["version"]
        version_param = f", version: {version['ts']}" if version else ""
        read_at = ", read at `version`" if version else ""
        return [
            f"/** Changes the given values of a {entity}{read_at}. */",
            f"async {name}({_key_params(info)}, {param}{version_param}): Promise<{_result_type(writer)}> {{",
            f"  const values: Partial<Record<string, unknown>> = {_defined('data' if dtos else 'changes')}",
            indent(
                lines(
                    *_in_transaction(
                        [
                            f"const current = await this.find(uow, {_key_args(info)})",
                            *_version_check(writer),
                            "await this.check(uow, values, current)",
                            "Object.assign(current, values)",
                            bool(version) and f"current.{version['prop']} = version + 1",
                            f"const updated = await {_repo(info)}.{query_name(context, update)}(current)",
                            f"return {_out(writer, 'updated')}",
                        ]
                    )
                ),
                2,
            ),
            "}",
        ]
    if kind == "delete":
        remove = query(info, "delete")
        update = query(info, "update")
        soft = info["soft"]
        if not query(info, "getByKey") or (not soft and not remove) or (soft and not update):
            return []
        version = info["version"]
        version_param = f", version: {version['ts']}" if version else ""
        if soft:
            mark = "true" if soft["column"]["type"]["kind"] == "boolean" else "new Date()"
            action = [f"current.{soft['prop']} = {mark}", f"await {_repo(info)}.{query_name(context, update)}(current)"]
            doc = f"/** Marks a {entity} as deleted ({soft['column']['name']}); reads leave it out from then on. */"
        else:
            action = [f"await {_repo(info)}.{query_name(context, remove)}(current)"]
            doc = f"/** Deletes a {entity}. */"
        return [
            doc,
            f"async {name}({_key_params(info)}{version_param}): Promise<void> {{",
            indent(
                lines(
                    *_in_transaction(
                        [
                            f"const current = await this.find(uow, {_key_args(info)})",
                            *_version_check(writer),
                            *_children_lines(writer),
                            *action,
                        ]
                    )
                ),
                2,
            ),
            "}",
        ]
    if kind in ("find", "listByParent"):
        read = query(info, "findByUnique" if kind == "find" else "listByParent", operation["columns"])
        if not read:
            return []
        columns = [column_of(info, column) for column in operation["columns"]]
        params = ", ".join(f"{column['prop']}: {column['ts']}" for column in columns)
        args = ", ".join(column["prop"] for column in columns)
        rows = f"await this.uow.{info['attr']}.{query_name(context, read)}({args})"
        joined = " and ".join(operation["columns"])
        service = service_class(info)
        if kind == "find":
            return [
                f"/** The {entity} with this {joined}, or null. */",
                f"async {name}({params}): Promise<{_result_type(writer)} | null> {{",
                [f"  const entity = {rows}", f"  return entity === null ? null : {service}.read(entity)"]
                if dtos
                else f"  return {rows}",
                "}",
            ]
        return [
            f"/** The {info['name']} with this {joined}. */",
            f"async {name}({params}): Promise<{_result_type(writer)}[]> {{",
            f"  return ({rows}).map((entity) => {service}.read(entity))" if dtos else f"  return {rows}",
            "}",
        ]
    if kind in ("link", "unlink"):
        return _link_lines(writer, operation, name)
    return []


def _link_lines(writer: dict, operation: dict, name: str) -> list:
    context, info, imports = writer["context"], writer["info"], writer["imports"]
    join = find_info(context, operation["through"]) if operation.get("through") else None
    if not join:
        return []
    own = next((key for key in join["table"]["foreignKeys"] if key["references"]["table"] == info["name"]), None)
    far = next((key for key in join["table"]["foreignKeys"] if key is not own), None)
    far_info = find_info(context, far["references"]["table"]) if far else None
    read = query(join, "getByKey")
    if not own or not far or not far_info or not read:
        return []
    own_cols = [column_of(join, column) for column in own["columns"]]
    far_cols = [column_of(join, column) for column in far["columns"]]
    params = ", ".join(f"{column['prop']}: {column['ts']}" for column in [*own_cols, *far_cols])
    join_key = ", ".join(column["prop"] for column in join["key"])
    found = f"await {_repo(join)}.{query_name(context, read)}({join_key})"
    imports.from_("src/errors", "NotFoundError").from_(module_of(context, join, "entity"), join["entity"])
    if operation["kind"] == "link":
        insert = query(join, "insert")
        far_read = query(far_info, "getByKey")
        if not insert or not far_read or not query(info, "getByKey"):
            return []
        imports.from_("src/errors", "ConflictError")
        far_args = ", ".join(column["prop"] for column in far_cols)
        far_key = far_args if len(far_cols) == 1 else f"[{far_args}]"
        own_args = ", ".join(column["prop"] for column in own_cols)
        all_props = ", ".join(column["prop"] for column in [*own_cols, *far_cols])
        return [
            f"/** Links a {info['entity']} and a {far_info['entity']} ({join['name']}). */",
            f"async {name}({params}): Promise<void> {{",
            indent(
                lines(
                    *_in_transaction(
                        [
                            f"await this.find(uow, {own_args})",
                            f"if ((await {_repo(far_info)}.{query_name(context, far_read)}({far_args})) === null) throw new NotFoundError('{far_info['entity']}', {far_key})",
                            f"if ({found} !== null) throw new ConflictError('{info['entity']}', 'is already linked to this {far_info['entity']}', [{_quoted([column['prop'] for column in far_cols])}])",
                            f"await {_repo(join)}.{query_name(context, insert)}(Object.assign(new {join['entity']}(), {{ {all_props} }}))",
                        ]
                    )
                ),
                2,
            ),
            "}",
        ]
    remove = query(join, "delete")
    if not remove:
        return []
    return [
        f"/** Removes the link between a {info['entity']} and a {far_info['entity']} ({join['name']}). */",
        f"async {name}({params}): Promise<void> {{",
        indent(
            lines(
                *_in_transaction(
                    [
                        f"const link = {found}",
                        f"if (link === null) throw new NotFoundError('{join['entity']}', [{join_key}])",
                        f"await {_repo(join)}.{query_name(context, remove)}(link)",
                    ]
                )
            ),
            2,
        ),
        "}",
    ]


TRANSACTIONS = {
    "operation": "Each write runs in its own transaction.",
    "caller": "It never commits: the caller owns the transaction.",
    "repository": "Repositories commit every write.",
}


def service_file(context: dict, info: dict) -> dict | None:
    if not info["service"]:
        return None
    module = module_of(context, info, "service")
    imports = (
        TsImports(module)
        .from_(module_of(context, info, "entity"), info["entity"])
        .type("src/unit-of-work", "UnitOfWork")
    )
    dtos = context["settings"]["serviceTypes"] == "dtos"
    writer = {"context": context, "info": info, "imports": imports, "dtos": dtos}
    if dtos:
        imports.type(module_of(context, info, "dtos"), read_dto(info))
    writes = info["role"] == "entity"
    operations = [block for block in (_operation_lines(writer, operation) for operation in info["operations"]) if block]
    helpers = [_find_method(writer), _read_method(writer)]
    if writes:
        helpers = [_validate_method(writer), _unique_method(writer), _check_method(writer), *helpers]
    hidden = bool(info["hidden"]) and not dtos
    one = len(info["hidden"]) == 1
    fields = _quoted([column["prop"] for column in create_columns(info)])
    content = lines(
        f"/** Operations on {info['name']}: what each one checks before it writes. */",
        imports.write(),
        "",
        writes
        and [
            "/** Properties a client may send: the database fills the others */",
            f"const FIELDS = new Set([{fields}])",
            "",
        ],
        f"/** Operations on {info['name']}. {TRANSACTIONS[context['settings']['transactions']]} */",
        f"export class {service_class(info)} {{",
        hidden
        and f"  // TODO: {', '.join(info['hidden'])} {'is' if one else 'are'} returned with the entity; use DTOs to leave {'it' if one else 'them'} out",
        "  constructor(private readonly uow: UnitOfWork) {}",
        *[item for block in [*helpers, *operations] if block for item in ("", indent(lines(*block), 2))],
        "}",
        "",
    )
    return {"path": path_of(module), "content": content}
