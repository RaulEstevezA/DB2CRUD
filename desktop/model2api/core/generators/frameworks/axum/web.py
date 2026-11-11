"""Services and routes of the Axum project. Mirrors web/src/core/generators/frameworks/axum/web.ts.

The service of a resource holds its rules: items that must exist, keys that must not repeat, references that must
point to stored items, and the values the server fills. Business endpoints get a method that answers 501 where their
logic goes. Presence, null and the declared validations are checked on the request body itself (common/body.rs).

The routes only translate HTTP to service calls: parameters, bodies, status codes and protection.
"""

from ....js import js_string, number_text
from ....openapi.build import PAGE_SIZE, shape_fields
from ...common.references import inner_object, referenced_resources
from ...common.samples import json_text
from ...common.text import file_text, lines
from ...languages.rust.rust import RsUses, rs_doc, rs_header, rs_name, rs_string, rs_type, rs_type_of
from .context import AxumContext, field_name, key_field, key_type, module_path, names, type_names
from .model import enum_variants
from .persistence import filter_fields


def endpoint_function(endpoint: dict) -> str:
    """The method of a service, and the handler, of an endpoint: list_customers."""
    return rs_name(endpoint["name"])


def _target(context: AxumContext, name: str) -> dict:
    return next(item for item in context.spec["resources"] if item["name"] == name)


def _rs_default(context: AxumContext, field: dict, uses: RsUses) -> str:
    """A default value written in Rust for the field's type, inside Some."""
    value = field.get("defaultValue")
    if value is None:
        return "None"
    type_ref = field["type"]
    if type_ref["kind"] == "enum":
        uses.add(type_names(context).shared(type_ref["name"]))
        item = next(entry for entry in context.spec["enums"] if entry["name"] == type_ref["name"])
        return f"Some({rs_type(type_ref['name'])}::{enum_variants(item)[item['values'].index(value)]})"
    if type_ref["kind"] == "scalar":
        scalar = type_ref["scalar"]
        if scalar == "integer":
            return f"Some({number_text(value)})"
        if scalar == "float":
            text = number_text(value)
            return f"Some({text}.0)" if float(value).is_integer() else f"Some({text})"
        if scalar == "decimal":
            uses.add("std::str::FromStr", "rust_decimal::Decimal")
            return f"Decimal::from_str({rs_string(js_string(value))}).ok()"
        if scalar == "boolean":
            return f"Some({'true' if value else 'false'})"
        if scalar == "date":
            uses.add("chrono::NaiveDate")
            return f'NaiveDate::parse_from_str({rs_string(js_string(value))}, "%Y-%m-%d").ok()'
        if scalar == "datetime":
            uses.add("chrono::{DateTime, Utc}")
            return f"DateTime::parse_from_rfc3339({rs_string(js_string(value))}).ok().map(|value| value.with_timezone(&Utc))"
        if scalar == "uuid":
            uses.add("uuid::Uuid")
            return f"Uuid::parse_str({rs_string(js_string(value))}).ok()"
        if scalar != "any":
            return f"Some({rs_string(js_string(value))}.to_string())"
    # Lists, maps, objects and values of any shape: written in JSON
    rust_type = rs_type_of(type_ref, uses, type_names(context))
    return f"serde_json::from_str::<{rust_type}>({rs_string(json_text(value))}).ok()"


def _server_value(context: AxumContext, field: dict, operation: str, uses: RsUses) -> str | None:
    """The value the server gives a read-only field, or None when it gives none in this operation."""
    if field["access"] != "readOnly" or field.get("server") == "key":
        return None

    def now() -> str:
        uses.add("crate::common::clock")
        scalar = field["type"].get("scalar") if field["type"]["kind"] == "scalar" else None
        if scalar == "date":
            return "Some(clock::today())"
        if scalar == "datetime":
            return "Some(clock::now())"
        return "Some(clock::text())"

    server = field.get("server")
    if server == "updated":
        return now()
    if operation != "create":
        return None
    if server == "created":
        return now()
    if server == "default":
        return _rs_default(context, field, uses)
    return None


def _reference_checks(
    context: AxumContext, resource: dict, fields: list[dict], source: str, label: str, depth: int, counter: list[int]
) -> list[str]:
    """Rust statements that check every reference of an item, nested objects included."""
    checks: list[str] = []
    for field in fields:
        value = f"{source}.{field_name(field)}"
        where = f"{label}.{field['wire']}" if label else field["wire"]
        if field.get("reference"):
            target = _target(context, field["reference"])
            repository = (
                "self.repository"
                if field["reference"] == resource["name"]
                else f"self.{names(target)['one']}_repository"
            )
            variable = f"reference{counter[0]}"
            counter[0] += 1
            message = f"No {field['reference']} has this key"
            failure = f"return Err(ApiError::invalid({rs_string(where)}, {rs_string(message)}));"
            if field["type"]["kind"] == "array":
                checks.extend(
                    [
                        f"for {variable} in {value}.iter().flatten() {{",
                        f"    if {repository}.get({variable}.clone()).await?.is_none() {{",
                        f"        {failure}",
                        "    }",
                        "}",
                    ]
                )
            else:
                checks.extend(
                    [
                        f"if let Some({variable}) = &{value}",
                        f"    && {repository}.get({variable}.clone()).await?.is_none()",
                        "{",
                        f"    {failure}",
                        "}",
                    ]
                )
            continue
        inner = inner_object(field["type"])
        spec_object = next((item for item in context.spec["objects"] if item["name"] == inner), None) if inner else None
        if not spec_object or depth > 3 or field["type"]["kind"] == "map":
            continue
        variable = f"item{depth}"
        nested = _reference_checks(context, resource, spec_object["fields"], variable, where, depth + 1, counter)
        if not nested:
            continue
        if field["type"]["kind"] == "array":
            checks.extend([f"for {variable} in {value}.iter().flatten() {{", *(f"    {line}" for line in nested), "}"])
        elif field["type"]["kind"] == "object":
            checks.extend([f"if let Some({variable}) = &{value} {{", *(f"    {line}" for line in nested), "}"])
    return checks


def service_file(context: AxumContext, resource: dict) -> dict:
    name = names(resource)
    dto = f"crate::{context.layout.resource(resource, 'dto')}"
    uses = RsUses().add(
        "std::sync::Arc",
        "crate::common::error::ApiError",
        f"crate::{context.layout.resource(resource, 'model')}::{name['type']}",
    )
    key = key_type(resource)
    if key == "Uuid":
        uses.add("uuid::Uuid")
    key_name = field_name(key_field(resource))
    key_wire = key_field(resource)["wire"]
    needs = referenced_resources(context, resource)
    uses.add(
        f"crate::{context.layout.resource(resource, 'repository')}::{name['repository']}",
        *(f"crate::{context.layout.resource(item, 'repository')}::{names(item)['repository']}" for item in needs),
    )
    checks = _reference_checks(context, resource, resource["fields"], "item", "", 0, [0])
    client_key = resource["key"]["generated"] is None
    operations = {endpoint["operation"] for endpoint in resource["endpoints"]}
    custom_with_key = any(
        endpoint["operation"] == "custom"
        and any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
        for endpoint in resource["endpoints"]
    )
    uses_find = bool(operations & {"get", "replace", "update", "delete"}) or custom_with_key
    uses_apply = "create" in operations or "replace" in operations
    uses_changes = "update" in operations
    uses_checks = bool(checks) and (uses_apply or uses_changes)
    methods: list[str] = []
    if uses_find:
        methods.append(
            lines(
                f"    async fn find(&self, key: {key}) -> Result<{name['type']}, ApiError> {{",
                f"        self.repository.get(key).await?.ok_or_else(|| ApiError::not_found({rs_string(resource['singular'])}))",
                "    }",
            )
        )
    if uses_checks:
        methods.append(
            lines(
                "    /// Every reference must point to a stored item.",
                f"    async fn check_references(&self, item: &{name['type']}) -> Result<(), ApiError> {{",
                [f"        {line}" for line in checks],
                "        Ok(())",
                "    }",
            )
        )
    if uses_apply or uses_changes:
        uses.add("crate::common::body::Body")
    if uses_apply:
        uses.add(f"{dto}::{name['create']}")
        assignments = []
        for field in shape_fields(resource["fields"], "create"):
            if field["name"] == resource["key"]["field"] and not client_key:
                continue
            prop = field_name(field)
            if field["name"] == resource["key"]["field"]:
                assignments.append(f"        item.{prop} = data.{prop}.clone().unwrap_or_default();")
            elif "defaultValue" in field:
                assignments.append(
                    f"        item.{prop} = if body.has({rs_string(field['wire'])}) {{ data.{prop}.clone() }} else {{ {_rs_default(context, field, uses)} }};"
                )
            else:
                assignments.append(f"        item.{prop} = data.{prop}.clone();")
        methods.append(
            lines(
                "    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.",
                f"    fn apply(item: &mut {name['type']}, body: &Body<{name['create']}>) {{",
                "        let data = &body.value;",
                assignments,
                "    }",
            )
        )
    if uses_changes:
        uses.add(f"{dto}::{name['update']}")
        methods.append(
            lines(
                "    /// Sets the fields a partial change carries; the others stay as they are.",
                f"    fn apply_changes(item: &mut {name['type']}, body: &Body<{name['update']}>) {{",
                "        let data = &body.value;",
                [
                    [
                        f"        if body.has({rs_string(field['wire'])}) {{",
                        f"            item.{field_name(field)} = data.{field_name(field)}.clone();",
                        "        }",
                    ]
                    for field in shape_fields(resource["fields"], "update")
                    if field["name"] != resource["key"]["field"]
                ],
                "    }",
            )
        )

    def server(operation: str) -> list[str]:
        result = []
        for field in resource["fields"]:
            value = _server_value(context, field, operation, uses)
            if value is not None:
                result.append(f"        item.{field_name(field)} = {value};")
            elif operation == "create" and field["access"] == "readOnly" and field.get("server") == "pending":
                todo = field["todo"] if field.get("todo") is not None else f'fill "{field["name"]}"'
                result.append(f"        // TODO: {todo}")
        return result

    check = uses_checks and "        self.check_references(&item).await?;"
    exists = f"A {resource['singular']} with this key already exists"
    for endpoint in resource["endpoints"]:
        fn = endpoint_function(endpoint)
        doc = f"    /// {endpoint['summary']}."
        operation = endpoint["operation"]
        if operation == "list":
            uses.add(
                "crate::common::list::{ListQuery, ListResult}",
                f"crate::{context.layout.resource(resource, 'repository')}::{name['filters']}",
            )
            methods.append(
                lines(
                    doc,
                    f"    pub async fn {fn}(&self, query: ListQuery<{name['filters']}>) -> Result<ListResult<{name['type']}>, ApiError> {{",
                    "        self.repository.list(&query).await",
                    "    }",
                )
            )
        elif operation == "get":
            methods.append(
                lines(
                    doc,
                    f"    pub async fn {fn}(&self, key: {key}) -> Result<{name['type']}, ApiError> {{",
                    "        self.find(key).await",
                    "    }",
                )
            )
        elif operation == "create":
            methods.append(
                lines(
                    doc,
                    f"    pub async fn {fn}(&self, body: Body<{name['create']}>) -> Result<{name['type']}, ApiError> {{",
                    f"        let mut item = {name['type']}::default();",
                    "        Self::apply(&mut item, &body);",
                    client_key
                    and [
                        f"        if self.repository.get(item.{key_name}.clone()).await?.is_some() {{",
                        f"            return Err(ApiError::conflict({rs_string(exists)}));",
                        "        }",
                    ],
                    check,
                    server("create"),
                    "        self.repository.add(item).await",
                    "    }",
                )
            )
        elif operation == "replace":
            methods.append(
                lines(
                    f"    /// {endpoint['summary']}: every field the client may send takes the value of the body.",
                    f"    pub async fn {fn}(&self, key: {key}, body: Body<{name['create']}>) -> Result<{name['type']}, ApiError> {{",
                    client_key
                    and [
                        f"        if body.value.{key_name}.as_ref() != Some(&key) {{",
                        f'            return Err(ApiError::invalid({rs_string(key_wire)}, "The key cannot change"));',
                        "        }",
                    ],
                    "        let mut item = self.find(key).await?;",
                    "        Self::apply(&mut item, &body);",
                    check,
                    server("replace"),
                    "        self.repository.update(item).await",
                    "    }",
                )
            )
        elif operation == "update":
            changes_key = client_key and key_field(resource)["access"] != "readOnly"
            methods.append(
                lines(
                    f"    /// {endpoint['summary']}: only the fields in the body change.",
                    f"    pub async fn {fn}(&self, key: {key}, body: Body<{name['update']}>) -> Result<{name['type']}, ApiError> {{",
                    changes_key
                    and [
                        f"        if body.has({rs_string(key_wire)}) && body.value.{key_name}.as_ref() != Some(&key) {{",
                        f'            return Err(ApiError::invalid({rs_string(key_wire)}, "The key cannot change"));',
                        "        }",
                    ],
                    "        let mut item = self.find(key).await?;",
                    "        Self::apply_changes(&mut item, &body);",
                    check,
                    server("update"),
                    "        self.repository.update(item).await",
                    "    }",
                )
            )
        elif operation == "delete":
            methods.append(
                lines(
                    doc,
                    f"    pub async fn {fn}(&self, key: {key}) -> Result<(), ApiError> {{",
                    "        self.find(key.clone()).await?;",
                    "        self.repository.delete(key).await",
                    "    }",
                )
            )
        elif operation == "custom":
            has_key = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            body_class = (
                name["create"]
                if endpoint["input"] == "resource"
                else name["update"]
                if endpoint["input"] == "partial"
                else None
            )
            if body_class:
                uses.add(f"{dto}::{body_class}", "crate::common::body::Body")
            params = [
                item
                for item in ("&self", has_key and f"key: {key}", body_class and f"_body: Body<{body_class}>")
                if item
            ]
            returns = (
                "()"
                if endpoint["output"] == "none"
                else f"Vec<{name['type']}>"
                if endpoint["output"] == "list"
                else name["type"]
            )
            summary = endpoint["summary"]
            methods.append(
                lines(
                    doc,
                    f"    pub async fn {fn}({', '.join(params)}) -> Result<{returns}, ApiError> {{",
                    has_key and "        self.find(key).await?;",
                    f'        // TODO: write the logic of "{summary}" ({endpoint["method"]} {endpoint["path"]}).',
                    f"        Err(ApiError::not_implemented({rs_string(f'{summary} is not written yet')}))",
                    "    }",
                )
            )
    fields = [
        f"    repository: Arc<dyn {name['repository']}>,",
        *(f"    {names(item)['one']}_repository: Arc<dyn {names(item)['repository']}>," for item in needs),
    ]
    parameters = [
        f"repository: Arc<dyn {name['repository']}>",
        *(f"{names(item)['one']}_repository: Arc<dyn {names(item)['repository']}>" for item in needs),
    ]
    assigned = ", ".join(["repository", *(f"{names(item)['one']}_repository" for item in needs)])
    content = lines(
        *rs_header(f"Rules of {resource['plural']}: what each operation checks and changes.", uses),
        rs_doc(f"Rules of {resource['plural']}."),
        f"pub struct {name['service']} {{",
        fields,
        "}",
        "",
        f"impl {name['service']} {{",
        f"    pub fn new({', '.join(parameters)}) -> Self {{",
        f"        Self {{ {assigned} }}",
        "    }",
        "",
        "\n\n".join(methods),
        "}",
    )
    return {"path": module_path(context.layout.resource(resource, "service")), "content": file_text(content)}


def _filter_read(context: AxumContext, field: dict, uses: RsUses) -> str:
    """The expression that reads a filter of the query string with the type of its field."""
    wire = rs_string(field["wire"])

    def helper(fn: str) -> str:
        uses.add(f"crate::common::query::{fn}")
        return fn

    if field.get("reference"):
        key = key_type(_target(context, field["reference"]))
        if key == "i64":
            return f"filter(&query, {wire}, |text| text.parse().ok())?"
        if key == "Uuid":
            return f"filter(&query, {wire}, {helper('parse_uuid')})?"
        return f"filter(&query, {wire}, |text| Some(text.to_string()))?"
    type_ref = field["type"]
    if type_ref["kind"] == "enum":
        item = next(entry for entry in context.spec["enums"] if entry["name"] == type_ref["name"])
        uses.add(type_names(context).shared(type_ref["name"]))
        enum_type = rs_type(type_ref["name"])
        if item["valueType"] == "integer":
            return f"filter(&query, {wire}, |text| text.parse().ok().and_then({enum_type}::from_value))?"
        return f"filter(&query, {wire}, {enum_type}::from_value)?"
    if type_ref["kind"] == "scalar":
        scalar = type_ref["scalar"]
        if scalar in ("integer", "float", "decimal"):
            return f"filter(&query, {wire}, |text| text.parse().ok())?"
        if scalar == "boolean":
            return f'filter(&query, {wire}, |text| match text {{ "true" => Some(true), "false" => Some(false), _ => None }})?'
        if scalar == "date":
            return f"filter(&query, {wire}, {helper('parse_date')})?"
        if scalar == "datetime":
            return f"filter(&query, {wire}, {helper('parse_date_time')})?"
        if scalar == "uuid":
            return f"filter(&query, {wire}, {helper('parse_uuid')})?"
    return f"filter(&query, {wire}, |text| Some(text.to_string()))?"


def routes_file(context: AxumContext, resource: dict) -> dict:
    name = names(resource)
    dto = f"crate::{context.layout.resource(resource, 'dto')}"
    uses = RsUses().add(
        "axum::Router",
        "axum::extract::State",
        "axum::response::IntoResponse",
        "crate::AppState",
        "crate::common::error::{ApiError, status}",
        f"{dto}::{name['response']}",
    )

    def key_read() -> str:
        scalar = resource["key"]["type"].get("scalar")
        fn = "long_key" if scalar == "integer" else "uuid_key" if scalar == "uuid" else "text_key"
        uses.add(f"crate::common::query::{fn}")
        return f"let key = {fn}(&params, {rs_string(resource['key']['param'])})?;"

    filter_struct = filter_fields(resource)
    handlers = []
    for endpoint in resource["endpoints"]:
        fn = endpoint_function(endpoint)
        params = ["State(state): State<AppState>"]
        body: list[str] = []
        if context.security and endpoint["access"] != "public":
            uses.add("crate::security::Authenticated")
            if endpoint["access"] == "roles" and context.settings["auth"] == "jwt":
                params.append("auth: Authenticated")
                body.append(f"auth.require_roles(&[{', '.join(rs_string(role) for role in endpoint['roles'])}])?;")
            else:
                params.append("_auth: Authenticated")
        has_key = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
        if endpoint["pathParams"]:
            uses.add("axum::extract::Path", "crate::common::query::Params")
            params.append(f"Path({'' if has_key else '_'}params): Path<Params>")
            if has_key:
                body.append(key_read())
        status = f"status({number_text(endpoint['status'])})"
        service = f"state.{name['state']}.{fn}"
        operation = endpoint["operation"]
        if operation == "list":
            uses.add(
                "axum::Json",
                "crate::common::list::ListQuery",
                f"crate::{context.layout.resource(resource, 'repository')}::{name['filters']}",
            )
            if endpoint["pagination"] or endpoint["filters"] or endpoint["sort"]:
                uses.add("axum::extract::Query", "crate::common::query::Params")
                params.append("Query(query): Query<Params>")
            if endpoint["pagination"]:
                uses.add("crate::common::query::int_query", "crate::common::list::PageResponse")
                body.extend(
                    [
                        'let page = int_query(&query, "page", 1, 1, None)?;',
                        f'let size = int_query(&query, "size", {number_text(PAGE_SIZE["default"])}, 1, Some({number_text(PAGE_SIZE["max"])}))?;',
                    ]
                )
            own = [
                field for field in resource["fields"] if field["wire"] in endpoint["filters"] and field in filter_struct
            ]
            if own:
                uses.add("crate::common::query::filter")
                body.extend(
                    [
                        f"let filters = {name['filters']} {{",
                        *(f"    {field_name(field)}: {_filter_read(context, field, uses)}," for field in own),
                        "    ..Default::default()" if len(own) < len(filter_struct) else "",
                        "};",
                    ]
                )
            else:
                body.append(f"let filters = {name['filters']}::default();")
            if endpoint["sort"]:
                uses.add("crate::common::query::choice_query")
                choices = ", ".join(
                    choice for wire in endpoint["sort"] for choice in (rs_string(wire), rs_string(f"-{wire}"))
                )
                body.append(f'let sort = choice_query(&query, "sort", &[{choices}])?;')
            sort = "sort" if endpoint["sort"] else "None"
            if endpoint["pagination"]:
                body.extend(
                    [
                        f"let result = {service}(ListQuery::new(filters, {sort}, (page - 1) * size, Some(size))).await?;",
                        f"let items = result.items.into_iter().map({name['response']}::from).collect();",
                        f"Ok(({status}, Json(PageResponse {{ items, total: result.total, page, size }})))",
                    ]
                )
            else:
                body.extend(
                    [
                        f"let result = {service}(ListQuery::new(filters, {sort}, 0, None)).await?;",
                        f"Ok(({status}, Json(result.items.into_iter().map({name['response']}::from).collect::<Vec<_>>())))",
                    ]
                )
        else:
            if endpoint["input"] != "none":
                body_class = name["update"] if endpoint["input"] == "partial" else name["create"]
                uses.add("axum::body::Bytes", "crate::common::body::read_body", f"{dto}::{body_class}")
                params.append("body: Bytes")
                body.append(f"let body = read_body::<{body_class}>(&body, {body_class}::rules)?;")
            if operation in ("get", "create", "replace", "update"):
                uses.add("axum::Json")
                arguments = {"get": "key", "create": "body"}.get(operation, "key, body")
                body.append(f"Ok(({status}, Json({name['response']}::from({service}({arguments}).await?))))")
            elif operation == "delete":
                body.extend([f"{service}(key).await?;", f"Ok({status})"])
            elif operation == "custom":
                arguments = ", ".join(
                    item for item in (has_key and "key", endpoint["input"] != "none" and "body") if item
                )
                call = f"{service}({arguments}).await?"
                if endpoint["output"] == "none" or endpoint["status"] == 204:
                    body.extend([f"{call};", f"Ok({status}.into_response())"])
                elif endpoint["output"] == "list":
                    uses.add("axum::Json")
                    body.append(
                        f"Ok(({status}, Json({call}.into_iter().map({name['response']}::from).collect::<Vec<_>>())).into_response())"
                    )
                else:
                    uses.add("axum::Json")
                    body.append(f"Ok(({status}, Json({name['response']}::from({call}))).into_response())")
        handlers.append(
            lines(
                f"/// {endpoint['summary']}.",
                f"async fn {fn}({', '.join(params)}) -> Result<impl IntoResponse, ApiError> {{",
                [f"    {line}" for line in body if line != ""],
                "}",
            )
        )
    # Endpoints of the same path share a route, one method each
    methods: dict[str, list[str]] = {}
    for endpoint in resource["endpoints"]:
        methods.setdefault(endpoint["path"], []).append(f"{endpoint['method'].lower()}({endpoint_function(endpoint)})")
    routes = []
    for path, calls in methods.items():
        uses.add(f"axum::routing::{calls[0][: calls[0].index('(')]}")
        routes.append(f"        .route({rs_string(path)}, {'.'.join(calls)})")
    content = lines(
        *rs_header(f"Routes of {resource['plural']}: HTTP in, service calls, HTTP out.", uses),
        rs_doc(f"The routes of {resource['plural']}."),
        "pub fn router() -> Router<AppState> {",
        "    Router::new()",
        routes,
        "}",
        "",
        "\n\n".join(handlers),
    )
    return {"path": module_path(context.layout.resource(resource, "routes")), "content": file_text(content)}
