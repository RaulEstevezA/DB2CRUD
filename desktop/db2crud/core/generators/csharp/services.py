"""The service of each table: its operations and what each one checks before it writes, in the order of the design
(docs/design.md, section 3): the values against the database's rules, the rows they point to, unique values, the
version; then children and soft deletes. The values of a create or an update are gathered in a dictionary of the fields
given, so every way an update can come is checked and applied the same way. Every write runs in
uow.TransactionAsync(...); errors are domain exceptions without HTTP codes. Mirrors
web/src/core/generators/csharp/services.ts."""

from ...js import number_text
from ..types import lines
from .context import (
    column_of,
    common_namespace,
    errors_namespace,
    find_info,
    namespace_of,
    operation_name,
    path_of,
    query,
    query_name,
    service_class,
)
from .csharp import CsUsings, cs_string
from .dtos import create_columns, create_dto, read_columns, read_dto, update_columns, update_namespace, update_type

NUMERIC = ("integer", "decimal", "float")


def _repo(info: dict, uow: str = "uow") -> str:
    return f"{uow}.{info['attr']}"


def _key_params(info: dict) -> str:
    return ", ".join(f"{column['cs']} {column['local']}" for column in info["key"])


def _key_args(info: dict) -> str:
    return ", ".join(column["local"] for column in info["key"])


def _key_value(info: dict) -> str:
    return info["key"][0]["local"] if len(info["key"]) == 1 else f"new object[] {{ {_key_args(info)} }}"


def _indent(items: list, spaces: int = 4) -> list:
    return [(("" if line == "" else " " * spaces + line) if isinstance(line, str) else line) for line in items]


def _text(value) -> str:
    return value if isinstance(value, str) else number_text(value)


def _given_or_current(column: dict) -> str:
    prop, local = column["prop"], column["local"]
    return f"var {local} = values.TryGetValue({cs_string(prop)}, out var given{prop}) ? ({column['cs']}?)given{prop} : current?.{prop};"


def _known(column: dict) -> str:
    """The value to pass on, once known not to be null."""
    return f"{column['local']}.Value" if column["valueType"] else column["local"]


def _value_rules(column: dict, checks: list[dict]) -> list[str]:
    rules = []
    name = column["column"]["name"]
    column_type = column["column"]["type"]

    def error(message: str) -> str:
        return f"errors.Add(new FieldError({cs_string(name)}, {cs_string(message)}));"

    if column_type["kind"] == "text" and column_type.get("length") is not None:
        length = column_type["length"]
        rules.append(
            f"if (value is string text && text.Length > {length}) {error(f'is longer than {length} characters')}"
        )
    for check in checks:
        parsed = check.get("parsed")
        if not parsed or parsed["column"] != name:
            continue
        if parsed["kind"] == "in":
            values = [_text(item) for item in parsed["values"]]
            message = f"must be one of: {', '.join(values)}"
            if column_type["kind"] in NUMERIC:
                choices = ", ".join(f"{value}m" for value in values)
                rules.append(f"if (!new[] {{ {choices} }}.Contains(Number(value))) {error(message)}")
            else:
                choices = ", ".join(cs_string(value) for value in values)
                rules.append(
                    f"if (!new[] {{ {choices} }}.Contains(Convert.ToString(value, CultureInfo.InvariantCulture))) {error(message)}"
                )
        if parsed["kind"] == "compare":
            op, bound = parsed["op"], _text(parsed["value"])
            rules.append(f"if (!(Number(value) {op} {bound}m)) {error(f'must be {op} {bound}')}")
        if parsed["kind"] == "length":
            op, bound = parsed["op"], _text(parsed["value"])
            rules.append(
                f"if (!(Convert.ToString(value, CultureInfo.InvariantCulture)!.Length {op} {bound})) {error(f'must have {op} {bound} characters')}"
            )
    return rules


def _validate_method(writer: dict) -> list:
    context, info, usings = writer["context"], writer["info"], writer["usings"]
    usings.add(errors_namespace(context), context["base"])
    blocks = []
    for column in create_columns(info):
        name = column["column"]["name"]
        prop = cs_string(column["prop"])
        if column["required"]:
            missing = f'if (creating || values.ContainsKey({prop})) errors.Add(new FieldError({cs_string(name)}, "is required"));'
        elif not column["column"]["nullable"]:
            missing = f'if (!creating && values.ContainsKey({prop})) errors.Add(new FieldError({cs_string(name)}, "cannot be empty"));'
        else:
            missing = None
        rules = _value_rules(column, info["table"]["checks"])
        if not missing and not rules:
            continue
        if missing:
            inner = ["    if (value is null)", f"        {missing}"]
            if rules:
                inner += ["    else", "    {", *(f"        {rule}" for rule in rules), "    }"]
        else:
            inner = ["    if (value is not null)", "    {", *(f"        {rule}" for rule in rules), "    }"]
        blocks.append(["{", f"    var value = values.GetValueOrDefault({prop});", *inner, "}"])
    # Parents
    for key in info["table"]["foreignKeys"]:
        parent = find_info(context, key["references"]["table"])
        read = query(parent, "getByKey") if parent else None
        same_key = parent and ",".join(column["column"]["name"] for column in parent["key"]) == ",".join(
            key["references"]["columns"]
        )
        if not parent or not read or not same_key:
            blocks.append(
                [
                    f"// TODO: {', '.join(key['columns'])} must point to a row of {key['references']['table']}; that table has no read by key to check it"
                ]
            )
            continue
        columns = [column_of(info, name) for name in key["columns"]]
        condition = " && ".join(f"{column['local']} is not null" for column in columns)
        args = ", ".join(_known(column) for column in columns)
        blocks.append(
            [
                "{",
                *(f"    {_given_or_current(column)}" for column in columns),
                f"    if ({condition} && await {_repo(parent)}.{query_name(context, read)}({args}) is null)",
                f"        errors.Add(new FieldError({cs_string(', '.join(key['columns']))}, {cs_string('no ' + parent['entity'] + ' has this key')}));",
                "}",
            ]
        )
    created = {column["column"]["name"] for column in create_columns(info)}
    parsed = [
        check["parsed"]
        for check in info["table"]["checks"]
        if check.get("parsed") is not None and check["parsed"]["column"] in created
    ]
    numbers = any(
        item["kind"] == "compare"
        or (item["kind"] == "in" and column_of(info, item["column"])["column"]["type"]["kind"] in NUMERIC)
        for item in parsed
    )
    if numbers or any(item["kind"] in ("length", "in") for item in parsed):
        usings.add("System.Globalization")
    result = [
        f'/// <summary>Checks the values against the rules of the "{info["name"]}" table, and the rows they point to; throws ValidationFailedException with every problem.</summary>',
        f"private static async Task ValidateAsync(IUnitOfWork uow, Dictionary<string, object?> values, {info['entity']}? current)",
        "{",
        "    var creating = current is null;",
        "    var errors = new List<FieldError>();",
        *[line for block in blocks for line in _indent(block)],
        f"    if (errors.Count > 0) throw new ValidationFailedException({cs_string(info['entity'])}, errors);",
        "}",
    ]
    if numbers:
        result += [
            "",
            "/// <summary>A number of any type, to compare it.</summary>",
            "private static decimal Number(object value) => Convert.ToDecimal(value, CultureInfo.InvariantCulture);",
        ]
    return result


def _unique_method(writer: dict) -> list:
    context, info, usings = writer["context"], writer["info"], writer["usings"]
    checks = []
    for unique in info["table"]["uniques"]:
        read = query(info, "findByUnique", unique["columns"])
        if not read:
            checks.append(
                [
                    f"// {', '.join(unique['columns'])} must be unique: the database refuses repeated values (ConflictException)"
                ]
            )
            continue
        usings.add(errors_namespace(context))
        columns = [column_of(info, name) for name in unique["columns"]]
        other = " || ".join(f"!Equals(other.{column['prop']}, current.{column['prop']})" for column in info["key"])
        taken = cs_string(f"{', '.join(unique['columns'])} is already taken")
        fields = ", ".join(cs_string(column["prop"]) for column in columns)
        checks.append(
            [
                "{",
                *(f"    {_given_or_current(column)}" for column in columns),
                f"    if ({' && '.join(column['local'] + ' is not null' for column in columns)})",
                "    {",
                f"        var other = await {_repo(info)}.{query_name(context, read)}({', '.join(_known(column) for column in columns)});",
                f"        if (other is not null && (current is null || {other}))",
                f"            throw new ConflictException({cs_string(info['entity'])}, {taken}, [{fields}]);",
                "    }",
                "}",
            ]
        )
    if not checks:
        return []
    return [
        "/// <summary>Values that must be unique are not taken by another row.</summary>",
        f"private static async Task CheckUniqueAsync(IUnitOfWork uow, Dictionary<string, object?> values, {info['entity']}? current)",
        "{",
        *[line for block in checks for line in _indent(block)],
        "}",
    ]


def _check_method(writer: dict) -> list:
    info = writer["info"]
    return [
        "/// <summary>Every check before a write: the values, the rows they point to, the unique values.</summary>",
        f"private static async Task CheckAsync(IUnitOfWork uow, Dictionary<string, object?> values, {info['entity']}? current)",
        "{",
        "    await ValidateAsync(uow, values, current);",
        bool(info["table"]["uniques"]) and "    await CheckUniqueAsync(uow, values, current);",
        "}",
    ]


def _apply_method(writer: dict) -> list:
    info = writer["info"]
    return [
        "/// <summary>Sets the given values on the entity.</summary>",
        f"private static void Apply({info['entity']} entity, Dictionary<string, object?> values)",
        "{",
        *(
            f"    if (values.TryGetValue({cs_string(column['prop'])}, out var {column['local']})) entity.{column['prop']} = ({column['propType']}){column['local']}{'' if column['optional'] else '!'};"
            for column in create_columns(info)
        ),
        "}",
    ]


def _find_method(writer: dict) -> list:
    context, info, usings = writer["context"], writer["info"], writer["usings"]
    read = query(info, "getByKey")
    if not read:
        return []
    usings.add(errors_namespace(context), context["base"])
    return [
        f"/// <summary>The {info['entity']} with this key; NotFoundException when there is none.</summary>",
        f"private static async Task<{info['entity']}> FindAsync(IUnitOfWork uow, {_key_params(info)}) =>",
        f"    await {_repo(info)}.{query_name(context, read)}({_key_args(info)}) ?? throw new NotFoundException({cs_string(info['entity'])}, {_key_value(info)});",
    ]


def _read_method(writer: dict) -> list:
    if not writer["dtos"]:
        return []
    context, info = writer["context"], writer["info"]
    if context["settings"]["dtoKind"] == "class":
        values = ", ".join(f"{column['prop']} = entity.{column['prop']}" for column in read_columns(info))
        body = f"private static {read_dto(info)} Read({info['entity']} entity) => new() {{ {values} }};"
    else:
        values = ", ".join(f"entity.{column['prop']}" for column in read_columns(info))
        body = f"private static {read_dto(info)} Read({info['entity']} entity) => new({values});"
    return [f"/// <summary>The {info['entity']} as services return it.</summary>", body]


def _given_method(writer: dict) -> list:
    context, info, usings = writer["context"], writer["info"], writer["usings"]
    if update_namespace(context, info) != namespace_of(context, info, "service"):
        usings.add(update_namespace(context, info))
    body = []
    for column in update_columns(info):
        prop = cs_string(column["prop"])
        if context["settings"]["updates"] == "patch":
            body.append(
                f"if (changes.{column['prop']} is {{ IsPresent: true }} {column['local']}) values[{prop}] = {column['local']}.Value;"
            )
        else:
            body.append(f"values[{prop}] = changes.{column['prop']};")
    return [
        "/// <summary>The values an update gives, by field.</summary>",
        f"private static Dictionary<string, object?> Given({update_type(context, info)} changes)",
        "{",
        "    var values = new Dictionary<string, object?>();",
        *(f"    {line}" for line in body),
        "    return values;",
        "}",
    ]


def _out(writer: dict, expression: str) -> str:
    return f"Read({expression})" if writer["dtos"] else expression


def _result_type(writer: dict) -> str:
    return read_dto(writer["info"]) if writer["dtos"] else writer["info"]["entity"]


def _version_check(writer: dict) -> list[str]:
    version = writer["info"]["version"]
    if not version:
        return []
    writer["usings"].add(errors_namespace(writer["context"]))
    return [
        f"if (!Equals(current.{version['prop']}, version))",
        f'    throw new ConflictException({cs_string(writer["info"]["entity"])}, "was changed by someone else since it was read", [{cs_string(version["prop"])}]);',
    ]


def _children_lines(writer: dict) -> list[str]:
    context, info, usings = writer["context"], writer["info"], writer["usings"]
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
        args = []
        for name in link["references"]:
            column = column_of(info, name)
            args.append(f"current.{column['prop']}{'!.Value' if column['optional'] and column['valueType'] else ''}")
        rows = f"await {_repo(child)}.{query_name(context, listing)}({', '.join(args)})"
        if info["children"]["policy"] == "block":
            usings.add(errors_namespace(context))
            reason = cs_string(f"rows of {link['table']} still point to it")
            result.append(
                f"if (({rows}).Count > 0) throw new ConflictException({cs_string(info['entity'])}, {reason}, [{cs_string(link['table'])}]);"
            )
        else:
            remove = query(child, "delete")
            if not remove:
                result.append(f"// TODO: rows of {link['table']} must be deleted first, and that table has no delete")
            else:
                result.append(f"foreach (var row in {rows}) await {_repo(child)}.{query_name(context, remove)}(row);")
    return result


def _in_transaction(items: list[str], returns: bool) -> list[str]:
    return [
        f"{'return ' if returns else ''}await this.uow.TransactionAsync(async uow =>",
        "{",
        *(f"    {line}" for line in items),
        "});",
    ]


def _operation_lines(writer: dict, operation: dict) -> list:
    context, info, usings = writer["context"], writer["info"], writer["usings"]
    name = operation_name(context, operation)
    entity = info["entity"]
    dtos = writer["dtos"]
    kind = operation["kind"]
    paging = context["settings"]["paging"]
    if kind == "create":
        insert = query(info, "insert")
        if not insert:
            return []
        if dtos:
            usings.add(namespace_of(context, info, "dtos"))
        variable = entity[:1].lower() + entity[1:]
        source = "data" if dtos else variable
        puts = []
        for column in create_columns(info):
            prop = column["prop"]
            if column["optional"] or not column["valueType"]:
                puts.append(f"    if ({source}.{prop} is not null) values[{cs_string(prop)}] = {source}.{prop};")
            else:
                puts.append(f"    values[{cs_string(prop)}] = {source}.{prop};")
        stored = _out(writer, f"await {_repo(info)}.{query_name(context, insert)}({'entity' if dtos else variable})")
        param = f"{create_dto(info)} data" if dtos else f"{entity} {variable}"
        return [
            f"/// <summary>Stores a new {entity} after checking it.</summary>",
            f"public async Task<{_result_type(writer)}> {name}({param})",
            "{",
            "    var values = new Dictionary<string, object?>();",
            *puts,
            *_indent(
                _in_transaction(
                    [
                        "await CheckAsync(uow, values, null);",
                        *([f"var entity = new {entity}();", "Apply(entity, values);"] if dtos else []),
                        f"return {stored};",
                    ],
                    True,
                )
            ),
            "}",
        ]
    if kind == "get":
        if not query(info, "getByKey"):
            return []
        return [
            f"/// <summary>The {entity} with this key; NotFoundException when there is none.</summary>",
            f"public async Task<{_result_type(writer)}> {name}({_key_params(info)}) => {_out(writer, f'await FindAsync(uow, {_key_args(info)})')};",
        ]
    if kind == "list":
        listing = query(info, "list")
        if not listing:
            return []
        method = f"{_repo(info)}.{query_name(context, listing)}"

        def mapped(expression: str, shape: str) -> str:
            if not dtos:
                return expression
            return f"({expression}).Map(Read)" if shape == "page" else f"({expression}).Select(Read).ToList()"

        if paging == "offset":
            usings.add(common_namespace(context))
            return [
                f"/// <summary>A page of {info['name']}, by primary key.</summary>",
                f"public async Task<Page<{_result_type(writer)}>> {name}(int offset, int limit) => {mapped(f'await {method}(offset, limit)', 'page')};",
            ]
        if paging == "cursor":
            usings.add(common_namespace(context))
            return [
                f"/// <summary>A page of {info['name']} after the key after (null for the first page), by primary key.</summary>",
                f"public async Task<CursorPage<{_result_type(writer)}>> {name}(IReadOnlyList<object>? after, int limit) => {mapped(f'await {method}(after, limit)', 'page')};",
            ]
        return [
            f"/// <summary>Every {entity}, by primary key.</summary>",
            f"public async Task<List<{_result_type(writer)}>> {name}() => {mapped(f'await {method}()', 'list')};",
        ]
    if kind == "update":
        update = query(info, "update")
        if not update or not query(info, "getByKey"):
            return []
        version = info["version"]
        version_param = f", {version['cs']} version" if version else ""
        bump = []
        if version:
            bump = [
                f"current.{version['prop']} = {'(short)(version + 1)' if version['cs'] == 'short' else 'version + 1'};"
            ]
        return [
            f"/// <summary>Changes the given values of a {entity}{', read at version' if version else ''}.</summary>",
            f"public async Task<{_result_type(writer)}> {name}({_key_params(info)}, {update_type(context, info)} changes{version_param})",
            "{",
            "    var values = Given(changes);",
            *_indent(
                _in_transaction(
                    [
                        f"var current = await FindAsync(uow, {_key_args(info)});",
                        *_version_check(writer),
                        "await CheckAsync(uow, values, current);",
                        "Apply(current, values);",
                        *bump,
                        f"return {_out(writer, f'await {_repo(info)}.{query_name(context, update)}(current)')};",
                    ],
                    True,
                )
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
        version_param = f", {version['cs']} version" if version else ""
        if not soft:
            mark = ""
        elif soft["column"]["type"]["kind"] == "boolean":
            mark = "true"
        else:
            mark = "DateTimeOffset.UtcNow" if soft["cs"] == "DateTimeOffset" else "DateTime.Now"
        if soft:
            action = [
                f"current.{soft['prop']} = {mark};",
                f"await {_repo(info)}.{query_name(context, update)}(current);",
            ]
            doc = f"/// <summary>Marks a {entity} as deleted ({soft['column']['name']}); reads leave it out from then on.</summary>"
        else:
            action = [f"await {_repo(info)}.{query_name(context, remove)}(current);"]
            doc = f"/// <summary>Deletes a {entity}.</summary>"
        return [
            doc,
            f"public async Task {name}({_key_params(info)}{version_param})",
            "{",
            *_indent(
                _in_transaction(
                    [
                        f"var current = await FindAsync(uow, {_key_args(info)});",
                        *_version_check(writer),
                        *_children_lines(writer),
                        *action,
                    ],
                    False,
                )
            ),
            "}",
        ]
    if kind in ("find", "listByParent"):
        read = query(info, "findByUnique" if kind == "find" else "listByParent", operation["columns"])
        if not read:
            return []
        columns = [column_of(info, column) for column in operation["columns"]]
        params = ", ".join(f"{column['cs']} {column['local']}" for column in columns)
        rows = f"await {_repo(info)}.{query_name(context, read)}({', '.join(column['local'] for column in columns)})"
        joined = " and ".join(operation["columns"])
        if kind == "find":
            body = f"{rows} is {{ }} entity ? Read(entity) : null" if dtos else rows
            return [
                f"/// <summary>The {entity} with this {joined}, or null.</summary>",
                f"public async Task<{_result_type(writer)}?> {name}({params}) => {body};",
            ]
        body = f"({rows}).Select(Read).ToList()" if dtos else rows
        return [
            f"/// <summary>The {info['name']} with this {joined}.</summary>",
            f"public async Task<List<{_result_type(writer)}>> {name}({params}) => {body};",
        ]
    if kind in ("link", "unlink"):
        return _link_lines(writer, operation, name)
    return []


def _link_lines(writer: dict, operation: dict, name: str) -> list:
    context, info, usings = writer["context"], writer["info"], writer["usings"]
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
    params = ", ".join(f"{column['cs']} {column['local']}" for column in [*own_cols, *far_cols])
    join_key = ", ".join(column["local"] for column in join["key"])
    found = f"await {_repo(join)}.{query_name(context, read)}({join_key})"
    usings.add(errors_namespace(context), namespace_of(context, join, "entity"))
    if operation["kind"] == "link":
        insert = query(join, "insert")
        far_read = query(far_info, "getByKey")
        if not insert or not far_read or not query(info, "getByKey"):
            return []
        far_args = ", ".join(column["local"] for column in far_cols)
        missing_key = far_args if len(far_cols) == 1 else f"new object[] {{ {far_args} }}"
        linked = cs_string(f"is already linked to this {far_info['entity']}")
        far_fields = ", ".join(cs_string(column["prop"]) for column in far_cols)
        values = ", ".join(f"{column['prop']} = {column['local']}" for column in [*own_cols, *far_cols])
        return [
            f"/// <summary>Links a {info['entity']} and a {far_info['entity']} ({join['name']}).</summary>",
            f"public async Task {name}({params})",
            "{",
            *_indent(
                _in_transaction(
                    [
                        f"await FindAsync(uow, {', '.join(column['local'] for column in own_cols)});",
                        f"if (await {_repo(far_info)}.{query_name(context, far_read)}({far_args}) is null) throw new NotFoundException({cs_string(far_info['entity'])}, {missing_key});",
                        f"if ({found} is not null) throw new ConflictException({cs_string(info['entity'])}, {linked}, [{far_fields}]);",
                        f"await {_repo(join)}.{query_name(context, insert)}(new {join['entity']} {{ {values} }});",
                    ],
                    False,
                )
            ),
            "}",
        ]
    remove = query(join, "delete")
    if not remove:
        return []
    return [
        f"/// <summary>Removes the link between a {info['entity']} and a {far_info['entity']} ({join['name']}).</summary>",
        f"public async Task {name}({params})",
        "{",
        *_indent(
            _in_transaction(
                [
                    f"var link = {found} ?? throw new NotFoundException({cs_string(join['entity'])}, new object[] {{ {join_key} }});",
                    f"await {_repo(join)}.{query_name(context, remove)}(link);",
                ],
                False,
            )
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
    ns = namespace_of(context, info, "service")
    usings = CsUsings(ns).add(namespace_of(context, info, "entity"), context["base"])
    dtos = context["settings"]["serviceTypes"] == "dtos"
    writer = {"context": context, "info": info, "usings": usings, "dtos": dtos}
    if dtos:
        usings.add(namespace_of(context, info, "dtos"))
    writes = info["role"] == "entity"
    operations = [block for block in (_operation_lines(writer, operation) for operation in info["operations"]) if block]
    updates = (
        any(operation["kind"] == "update" for operation in info["operations"])
        and query(info, "update")
        and query(info, "getByKey")
    )
    helpers = [_find_method(writer), _read_method(writer)]
    if writes:
        helpers = [
            _validate_method(writer),
            _unique_method(writer),
            _check_method(writer),
            _apply_method(writer),
            *helpers,
        ]
    if writes and updates:
        helpers.append(_given_method(writer))
    hidden = bool(info["hidden"]) and not dtos
    members = []
    for block in [*helpers, *operations]:
        if block:
            members += ["", *_indent(block)]
    one = len(info["hidden"]) == 1
    written = usings.write()
    content = lines(
        written != "" and [written, ""],
        f"namespace {ns};",
        "",
        f"/// <summary>Operations on {info['name']}. {TRANSACTIONS[context['settings']['transactions']]}</summary>",
        f"public class {service_class(info)}(IUnitOfWork unitOfWork)",
        "{",
        hidden
        and f"    // TODO: {', '.join(info['hidden'])} {'is' if one else 'are'} returned with the entity; use DTOs to leave {'it' if one else 'them'} out",
        "    private readonly IUnitOfWork uow = unitOfWork;",
        *members,
        "}",
        "",
    )
    return {"path": path_of(ns, service_class(info)), "content": content}
