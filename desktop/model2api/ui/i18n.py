"""English and Spanish texts. Mirrors web/src/i18n/messages.ts for the texts both versions share; the desktop says
"this computer" where the web says "this browser", and "Save" where it says "Download". Texts that depend on a
value are functions."""

from types import SimpleNamespace

from PySide6.QtCore import QLocale, QObject, QSettings, Signal

from ..core.js import js_string, number_text


def _en_number(value: int) -> str:
    return f"{value:,}"


def _es_number(value: int) -> str:
    # Spanish groups thousands only from five digits on: 1234, 12.345
    return f"{value:,}".replace(",", ".") if abs(value) >= 10000 else str(value)


def _p(params: dict | None, key: str) -> str:
    value = (params or {}).get(key)
    return "" if value is None else js_string(value)


def _plural(count, one: str, many: str) -> str:
    return one if count == 1 else many


_JSON_DETAIL_EN = {
    "json.unexpectedEnd": "The JSON ends too early: something is not closed.",
    "json.unexpectedCharacter": "Unexpected character.",
    "json.trailingComma": "Comma before the end of a list or object: remove it.",
    "json.invalidNumber": "Invalid number: JSON does not allow leading zeros or a dot without decimals.",
    "json.invalidEscape": "Unknown escape sequence.",
    "json.controlCharacter": "Line break or tab inside a text: write it as \\n or \\t.",
    "json.trailingContent": "There is more text after the end of the JSON.",
    "json.tooDeep": "The JSON is nested too deeply.",
    "modelSchema": "This model schema is not valid.",
}

_JSON_DETAIL_ES = {
    "json.unexpectedEnd": "El JSON termina antes de tiempo: algo no está cerrado.",
    "json.unexpectedCharacter": "Carácter inesperado.",
    "json.trailingComma": "Coma antes del final de una lista u objeto: quítala.",
    "json.invalidNumber": "Número no válido: JSON no admite ceros a la izquierda ni un punto sin decimales.",
    "json.invalidEscape": "Secuencia de escape desconocida.",
    "json.controlCharacter": "Salto de línea o tabulador dentro de un texto: escríbelo como \\n o \\t.",
    "json.trailingContent": "Hay más texto después del final del JSON.",
    "json.tooDeep": "El JSON tiene demasiados niveles.",
    "modelSchema": "Este esquema de modelos no es válido.",
}


def _parse_issue_en(issue: dict) -> str:
    params = issue.get("params")
    code = issue["code"]
    if code == "syntax":
        if params and params.get("detail"):
            detail = _JSON_DETAIL_EN.get(str(params["detail"]), str(params["detail"]))
            return detail + (f" ({_p(params, 'path')})" if params.get("path") else "")
        if params and params.get("message"):
            return f"It cannot be read as this format: {_p(params, 'message')}"
        return "It cannot be read as this format."
    return {
        "empty": "There is nothing to read.",
        "unexpectedToken": f"Unexpected “{_p(params, 'token')}”.",
        "unterminatedString": "A text is not closed.",
        "unterminatedComment": "A comment is not closed.",
        "unclosedBlock": "A block is not closed: a “}” is missing.",
        "noModels": "No model was found. Check the format or paste the declarations.",
        "unknownType": f"“{_p(params, 'type')}” is not declared here: you will choose its type.",
        "mixedTypes": f"“{_p(params, 'field')}” has values of different types.",
        "duplicateField": f"“{_p(params, 'field')}” is declared twice.",
        "duplicateModel": f"“{_p(params, 'model')}” is declared twice.",
        "emptyModel": f"“{_p(params, 'model')}” has no fields.",
        "truncatedRows": f"Only the first {_p(params, 'count')} rows were read.",
    }.get(code, code)


def _parse_issue_es(issue: dict) -> str:
    params = issue.get("params")
    code = issue["code"]
    if code == "syntax":
        if params and params.get("detail"):
            detail = _JSON_DETAIL_ES.get(str(params["detail"]), str(params["detail"]))
            return detail + (f" ({_p(params, 'path')})" if params.get("path") else "")
        if params and params.get("message"):
            return f"No se puede leer con este formato: {_p(params, 'message')}"
        return "No se puede leer con este formato."
    return {
        "empty": "No hay nada que leer.",
        "unexpectedToken": f"No se esperaba «{_p(params, 'token')}».",
        "unterminatedString": "Hay un texto sin cerrar.",
        "unterminatedComment": "Hay un comentario sin cerrar.",
        "unclosedBlock": "Hay un bloque sin cerrar: falta una «}».",
        "noModels": "No se ha encontrado ningún modelo. Revisa el formato o pega las declaraciones.",
        "unknownType": f"«{_p(params, 'type')}» no está declarado aquí: elegirás su tipo.",
        "mixedTypes": f"«{_p(params, 'field')}» tiene valores de tipos distintos.",
        "duplicateField": f"«{_p(params, 'field')}» está declarado dos veces.",
        "duplicateModel": f"«{_p(params, 'model')}» está declarado dos veces.",
        "emptyModel": f"«{_p(params, 'model')}» no tiene campos.",
        "truncatedRows": f"Solo se han leído las primeras {_p(params, 'count')} filas.",
    }.get(code, code)


def _reason_en(reason: dict) -> str:
    params = reason.get("params")
    return {
        "entityDeclared": "The input declares it as a stored entity.",
        "hasKey": f"“{_p(params, 'field')}” identifies it, so it gets endpoints of its own.",
        "standalone": "No other model contains it, so it gets endpoints of its own.",
        "valueObject": f"It has no key and “{_p(params, 'model')}” contains it: it travels inside it.",
        "keyDeclared": f"The input declares “{_p(params, 'field')}” as its key.",
        "keyNamed": f"“{_p(params, 'field')}” is named like a key.",
        "keyCandidates": f"Fields that could identify it: {_p(params, 'fields')}.",
        "keyMissing": "The input declares no key: choose a field, or let the server generate one.",
        "targetIsResource": f"“{_p(params, 'model')}” has endpoints of its own: the client sends its key.",
        "targetIsValue": f"“{_p(params, 'model')}” has no endpoints of its own: it travels inside.",
        "selfReference": "It points to another item of the same resource: the client sends its key.",
        "listOfResources": f"A list of “{_p(params, 'model')}”, which has endpoints of its own: the client sends their keys.",
        "keyGenerated": "The server assigns the key: clients only read it.",
        "keyFromClient": "The client chooses the key when it creates an item.",
        "generatedValue": "The input says it is generated: clients only read it.",
        "secretNamed": "Its name says it is a secret: clients send it but never read it.",
        "auditNamed": "A timestamp the server keeps: clients only read it.",
        "plainField": "Clients send it and read it.",
        "unknownType": f"The input does not define “{_p(params, 'type')}”: choose how it travels.",
        "manual": "You chose it.",
    }.get(reason["code"], reason["code"])


def _reason_es(reason: dict) -> str:
    params = reason.get("params")
    return {
        "entityDeclared": "La entrada lo declara como entidad almacenada.",
        "hasKey": f"«{_p(params, 'field')}» lo identifica, así que tiene endpoints propios.",
        "standalone": "Ningún otro modelo lo contiene, así que tiene endpoints propios.",
        "valueObject": f"No tiene clave y «{_p(params, 'model')}» lo contiene: viaja dentro de él.",
        "keyDeclared": f"La entrada declara «{_p(params, 'field')}» como su clave.",
        "keyNamed": f"«{_p(params, 'field')}» tiene nombre de clave.",
        "keyCandidates": f"Campos que podrían identificarlo: {_p(params, 'fields')}.",
        "keyMissing": "La entrada no declara clave: elige un campo o deja que el servidor genere una.",
        "targetIsResource": f"«{_p(params, 'model')}» tiene endpoints propios: el cliente envía su clave.",
        "targetIsValue": f"«{_p(params, 'model')}» no tiene endpoints propios: viaja dentro.",
        "selfReference": "Apunta a otro elemento del mismo recurso: el cliente envía su clave.",
        "listOfResources": f"Una lista de «{_p(params, 'model')}», que tiene endpoints propios: el cliente envía sus claves.",
        "keyGenerated": "El servidor asigna la clave: los clientes solo la leen.",
        "keyFromClient": "El cliente elige la clave al crear un elemento.",
        "generatedValue": "La entrada dice que se genera: los clientes solo lo leen.",
        "secretNamed": "Su nombre dice que es un secreto: los clientes lo envían pero nunca lo leen.",
        "auditNamed": "Una marca de tiempo que mantiene el servidor: los clientes solo la leen.",
        "plainField": "Los clientes lo envían y lo leen.",
        "unknownType": f"La entrada no define «{_p(params, 'type')}»: elige cómo viaja.",
        "manual": "Lo has elegido tú.",
    }.get(reason["code"], reason["code"])


def _key_option_en(value: dict) -> str:
    if value["kind"] == "field":
        return f"Field “{value['field']}”"
    return "A UUID the server generates" if value.get("type") == "uuid" else "A number the server generates"


def _key_option_es(value: dict) -> str:
    if value["kind"] == "field":
        return f"Campo «{value['field']}»"
    return "Un UUID que genera el servidor" if value.get("type") == "uuid" else "Un número que genera el servidor"


def _describe_constraints(c: dict, chars: str, items: str) -> str:
    parts: list[str] = []

    def n(key: str) -> str:
        return number_text(c[key])

    has = c.get
    if has("minLength") is not None or has("maxLength") is not None:
        if has("maxLength") is None:
            parts.append(f"≥ {n('minLength')} {chars}")
        elif has("minLength") is None:
            parts.append(f"≤ {n('maxLength')} {chars}")
        else:
            parts.append(f"{n('minLength')}–{n('maxLength')} {chars}")
    if has("minItems") is not None or has("maxItems") is not None:
        if has("maxItems") is None:
            parts.append(f"≥ {n('minItems')} {items}")
        elif has("minItems") is None:
            parts.append(f"≤ {n('maxItems')} {items}")
        else:
            parts.append(f"{n('minItems')}–{n('maxItems')} {items}")
    for key, sign in (("minimum", "≥"), ("exclusiveMinimum", ">"), ("maximum", "≤"), ("exclusiveMaximum", "<")):
        if has(key) is not None:
            parts.append(f"{sign} {n(key)}")
    if has("format"):
        parts.append(c["format"])
    if has("pattern"):
        parts.append(f"/{c['pattern']}/")
    return " · ".join(parts) or "—"


def _issue_en(issue: dict) -> str:
    params = issue.get("params")
    code = issue["code"]
    if code == "protectionIgnored":
        if (params or {}).get("auth") == "apiKey":
            return "API keys carry no roles: any valid key can call it."
        return "The project has no authentication: anyone can call it."
    return {
        "duplicateRoute": f"Same method and path as {_p(params, 'other')}: change one of them.",
        "duplicateName": f"Same operation name as {_p(params, 'other')}: names must be unique.",
        "invalidName": f"“{_p(params, 'name')}” cannot be an operation name: use letters, digits and “_”, not starting with a digit.",
        "invalidPath": f"“{_p(params, 'path')}” is not a valid path: segments of letters, digits, “-”, “_” and “.”, and each {{parameter}} once.",
        "missingKeyParam": f"The path needs {{{_p(params, 'param')}}} to know which item.",
        "unexpectedParam": f"This operation cannot use {{{_p(params, 'params')}}} in its path.",
        "invalidFilter": f"These fields cannot be filtered: {_p(params, 'fields')}.",
        "invalidSort": f"These fields cannot be sorted by: {_p(params, 'fields')}.",
        "noRoles": "Write at least one role, or choose another access.",
        "bodyOnGet": "A GET request has no body: choose another method or no body.",
        "invalidStatus": f"{_p(params, 'status')} is not a success status: use one from 200 to 299.",
        "noEndpoints": "Every endpoint is off: the resource has no routes.",
    }.get(code, code)


def _issue_es(issue: dict) -> str:
    params = issue.get("params")
    code = issue["code"]
    if code == "protectionIgnored":
        if (params or {}).get("auth") == "apiKey":
            return "Las claves de API no llevan roles: cualquier clave válida puede llamarlo."
        return "El proyecto no tiene autenticación: cualquiera puede llamarlo."
    return {
        "duplicateRoute": f"Mismo método y ruta que {_p(params, 'other')}: cambia uno de los dos.",
        "duplicateName": f"Mismo nombre de operación que {_p(params, 'other')}: los nombres no se pueden repetir.",
        "invalidName": f"«{_p(params, 'name')}» no puede ser un nombre de operación: usa letras, dígitos y «_», sin empezar por un dígito.",
        "invalidPath": f"«{_p(params, 'path')}» no es una ruta válida: segmentos de letras, dígitos, «-», «_» y «.», y cada {{parámetro}} una vez.",
        "missingKeyParam": f"La ruta necesita {{{_p(params, 'param')}}} para saber de qué elemento se trata.",
        "unexpectedParam": f"Esta operación no puede usar {{{_p(params, 'params')}}} en su ruta.",
        "invalidFilter": f"Estos campos no se pueden filtrar: {_p(params, 'fields')}.",
        "invalidSort": f"No se puede ordenar por estos campos: {_p(params, 'fields')}.",
        "noRoles": "Escribe al menos un rol o elige otro acceso.",
        "bodyOnGet": "Una petición GET no tiene cuerpo: elige otro método o ningún cuerpo.",
        "invalidStatus": f"{_p(params, 'status')} no es un estado de éxito: usa uno entre 200 y 299.",
        "noEndpoints": "Todos los endpoints están desactivados: el recurso no tiene rutas.",
    }.get(code, code)


def _issues_summary(
    errors: int, warnings: int, number, error_texts: tuple[str, str], warning_texts: tuple[str, str]
) -> str:
    parts = []
    if errors > 0:
        parts.append(f"{number(errors)} {_plural(errors, *error_texts)}")
    if warnings > 0:
        parts.append(f"{number(warnings)} {_plural(warnings, *warning_texts)}")
    return " · ".join(parts)


_PROJECT_ERRORS_EN = {
    "notJson": "The file is not a Model2API project: it is not JSON.",
    "notProject": "The file is not a Model2API project.",
    "newerVersion": "The project was saved by a newer version of Model2API.",
    "noInput": "The project holds no models.",
}

_PROJECT_ERRORS_ES = {
    "notJson": "El archivo no es un proyecto de Model2API: no es JSON.",
    "notProject": "El archivo no es un proyecto de Model2API.",
    "newerVersion": "El proyecto se guardó con una versión más reciente de Model2API.",
    "noInput": "El proyecto no contiene modelos.",
}

_PERSISTENCE_EN = {
    "memory": "In memory, to try it",
    "none": "Interfaces to implement",
    "sqlalchemy": "SQLAlchemy",
    "djangoOrm": "Django ORM",
    "prisma": "Prisma",
    "mongoose": "Mongoose",
    "typeorm": "TypeORM",
    "jpa": "JPA / Hibernate",
    "eloquent": "Eloquent",
    "doctrine": "Doctrine ORM",
    "efCore": "Entity Framework Core",
    "exposed": "Exposed",
    "seaOrm": "SeaORM",
    "fluent": "Fluent",
}

_DATABASES = {
    "postgresql": "PostgreSQL",
    "mysql": "MySQL",
    "mariadb": "MariaDB",
    "sqlite": "SQLite",
    "mongodb": "MongoDB",
}
_LANGUAGES = {
    "python": "Python",
    "typescript": "TypeScript",
    "java": "Java",
    "php": "PHP",
    "csharp": "C#",
    "kotlin": "Kotlin",
    "rust": "Rust",
    "swift": "Swift",
}

EN = SimpleNamespace(
    language_label="Language",
    processed_locally="Processed locally",
    tagline="Turn data models into the code of a REST API you can run",
    intro_description="Paste or open your models. Model2API proposes the endpoints of the API, explains each proposal "
    "and lets you change them. Choose the framework and save a project ready to run, with its tests and OpenAPI "
    "contract.",
    developed_by="Developed by",
    pending_count=lambda count: f"{_en_number(count)} {_plural(count, 'item', 'items')} to review",
    workspace_parts={"models": "Models", "endpoints": "Endpoints", "project": "Project"},
    endpoints_empty="The proposed resources and endpoints will appear here once the models are read.",
    project_empty="The files of the generated project will appear here.",
    # Examples
    examples_label="Try an example",
    examples={"store": "Online shop", "library": "Library", "catalog": "JPA catalogue"},
    example_descriptions={
        "store": "TypeScript interfaces: references, value objects, lists, an enum and a password",
        "library": "Pydantic models with lengths, ranges, a pattern and UUID keys",
        "catalog": "JPA entities with Bean Validation and a category tree",
    },
    confirm_replace="Your current models and the decisions made on them will be replaced. Continue?",
    # Input
    input_label="Models to analyze",
    input_placeholder="Paste classes, DTOs, JSON or a schema here, or drop a file…",
    editor_keys="Tab indents. To leave the editor with the keyboard, press Escape and then Tab.",
    open_file="Open",
    open_dialog="Open models",
    model_files="Models",
    all_files="All files",
    clear="Clear",
    format_label="Format",
    format_auto=lambda detected: f"Detect ({detected})" if detected else "Detect automatically",
    file_too_large=lambda name: f"“{name}” is larger than 10 MB.",
    file_error=lambda name: f"“{name}” could not be read.",
    received_from=lambda tool: f"Models received from {tool}.",
    input_empty="Paste or open your models to start.",
    undetected="The format could not be detected: choose it in the list.",
    input_summary=lambda format_label, models, fields: (
        f"{format_label} · {_en_number(models)} "
        f"{_plural(models, 'model', 'models')} · {_en_number(fields)} {_plural(fields, 'field', 'fields')}"
    ),
    warnings_count=lambda count: f"{_en_number(count)} {_plural(count, 'note', 'notes')}",
    error_position=lambda line, column: f"Line {_en_number(line)}, column {_en_number(column)}",
    parse_issue=_parse_issue_en,
    # Endpoints pane
    undo="Undo",
    redo="Redo",
    reset="Reset",
    undo_title="Undo (Ctrl/Cmd+Z)",
    redo_title="Redo (Ctrl/Cmd+Shift+Z)",
    reset_title="Back to the proposal: every choice you made is discarded",
    confirm_reset="Every choice you made on this design will be discarded. Continue?",
    design_summary=lambda resources, endpoints: (
        f"{_en_number(resources)} {_plural(resources, 'resource', 'resources')}"
        f" · {_en_number(endpoints)} {_plural(endpoints, 'endpoint', 'endpoints')}"
    ),
    issues_summary=lambda errors, warnings: _issues_summary(
        errors,
        warnings,
        _en_number,
        ("endpoint left out of the code", "problems leave endpoints out of the code"),
        ("warning", "warnings"),
    ),
    no_resources="No model has endpoints of its own yet: make one of them a resource.",
    embedded_section="Inside other resources",
    embedded_hint="These models have no endpoints: they travel inside the resources that contain them.",
    status={
        "exact": "Exact",
        "high": "High",
        "probable": "Likely",
        "review": "Review",
        "conflict": "Conflict",
        "none": "None",
        "manual": "Your choice",
    },
    accept="Confirm",
    accept_title=lambda subject: f"Confirm the suggestion for {subject}",
    reason=_reason_en,
    expose_label="Endpoints",
    key_label="Key",
    expose_subject=lambda model: f"{model}: endpoints",
    key_subject=lambda model: f"{model}: key",
    access_subject=lambda field: f"{field}: access",
    relation_subject=lambda field: f"{field}: how it travels",
    unknown_type_subject=lambda field: f"{field}: type",
    expose_options={"resource": "A resource with endpoints", "embedded": "Only inside other resources"},
    key_option=_key_option_en,
    access_options={"readWrite": "Send and read", "readOnly": "Read only", "writeOnly": "Send only"},
    relation_options={"reference": "Its key", "embedded": "The whole item"},
    unknown_type_options={"any": "Any JSON value", "string": "Text"},
    resource_path_label=lambda model: f"Path of {model}",
    fields_summary=lambda total, included: (
        f"{_en_number(total)} {_plural(total, 'field', 'fields')}"
        if included == total
        else f"{_en_number(included)} of {_en_number(total)} fields in the API"
    ),
    endpoints_count=lambda enabled, total: f"{_en_number(enabled)} of {_en_number(total)} endpoints on",
    show_fields="Show fields",
    hide_fields="Hide fields",
    field_include="In the API",
    field_name="Field",
    field_access="Clients can",
    field_travels="Travels as",
    field_validations="Validations",
    include_field=lambda field: f"Include “{field}” in the API",
    key_always_included="The key is always in the API",
    key_badge="key",
    travels_as_value="Its value",
    describe_constraints=lambda c: _describe_constraints(c, "chars", "items"),
    enable_endpoint=lambda endpoint: f"Generate {endpoint}",
    custom_badge="business",
    endpoint_off="off",
    not_generated="not generated",
    edit="Edit",
    done="Done",
    add_endpoint="Add a business endpoint",
    remove_endpoint="Remove",
    method_label="Method",
    path_label="Path",
    name_label="Operation name",
    summary_label="Summary (in the code, in English)",
    access_label="Who may call it",
    endpoint_access={
        "default": "Project default",
        "public": "Anyone",
        "authenticated": "Clients with credentials",
        "roles": "Some roles",
    },
    roles_label="Roles, separated by commas",
    status_label="Success status",
    status_default="Usual one",
    input_body_label="Body",
    output_label="Returns",
    custom_input={"none": "Nothing", "resource": "A whole item", "partial": "Some fields"},
    custom_output={"none": "Nothing", "resource": "The item", "list": "A list of items"},
    pagination_label="In pages (page and size)",
    filters_label="Filters",
    sort_label="Sort by",
    access_needs_auth="The project has no authentication: this protection has no effect until you choose one.",
    custom_note="The code gets the route and a service method marked with TODO; it answers 501 until you write its "
    "logic.",
    issue=_issue_en,
    # Project pane
    project_name="Project name",
    framework_label="Framework",
    languages=_LANGUAGES,
    not_written_yet=lambda framework: f"{framework} · not available yet",
    architecture_label="Architecture",
    architectures={"layered": "By layers", "modular": "One folder per resource"},
    persistence_label="Storage",
    persistence=_PERSISTENCE_EN,
    database_label="Database",
    databases=_DATABASES,
    auth_label="Authentication",
    auth={"none": "None: every endpoint is public", "apiKey": "API key (X-API-Key)", "jwt": "JWT bearer token"},
    default_access_label="By default, endpoints are for",
    java_package_label="JVM package",
    file_tree_label="Generated files",
    file_label=lambda path: f"Content of {path}",
    copy="Copy",
    copied="Copied",
    save_file="Save file",
    save_open_api="OpenAPI",
    save_zip=lambda count: f"Save .zip ({_en_number(count)} {_plural(count, 'file', 'files')})",
    saved=lambda path: f"Saved to {path}",
    todo_count=lambda count: f"{_en_number(count)} TODO {_plural(count, 'mark', 'marks')} left for you",
    # Projects
    open_project="Open project",
    save_project="Save project",
    project_files="Model2API projects",
    remember="Remember on this computer",
    remember_hint="Keeps your models, decisions and settings on this computer only, so you can continue another day. "
    "Nothing is sent anywhere.",
    clear_saved="Delete the saved work",
    clear_saved_confirm="The work kept on this computer will be deleted. Continue?",
    restored="Your work kept on this computer has been restored.",
    saved_cleared="The work kept on this computer has been deleted.",
    project_loaded=lambda name: f"“{name}” opened.",
    project_error=lambda error: _PROJECT_ERRORS_EN.get(error, error),
)

ES = SimpleNamespace(
    language_label="Idioma",
    processed_locally="Procesado en local",
    tagline="Convierte modelos de datos en el código de una API REST que puedes ejecutar",
    intro_description="Pega o abre tus modelos. Model2API propone los endpoints de la API, explica cada propuesta y te "
    "deja cambiarlos. Elige el framework y guarda un proyecto listo para ejecutar, con sus pruebas y su contrato "
    "OpenAPI.",
    developed_by="Desarrollado por",
    pending_count=lambda count: f"{_es_number(count)} {_plural(count, 'elemento', 'elementos')} por revisar",
    workspace_parts={"models": "Modelos", "endpoints": "Endpoints", "project": "Proyecto"},
    endpoints_empty="Los recursos y endpoints propuestos aparecerán aquí cuando se lean los modelos.",
    project_empty="Los archivos del proyecto generado aparecerán aquí.",
    examples_label="Prueba un ejemplo",
    examples={"store": "Tienda online", "library": "Biblioteca", "catalog": "Catálogo JPA"},
    example_descriptions={
        "store": "Interfaces de TypeScript: referencias, objetos de valor, listas, un enum y una contraseña",
        "library": "Modelos de Pydantic con longitudes, rangos, un patrón y claves UUID",
        "catalog": "Entidades JPA con Bean Validation y un árbol de categorías",
    },
    confirm_replace="Se sustituirán tus modelos actuales y las decisiones tomadas sobre ellos. ¿Continuar?",
    input_label="Modelos para analizar",
    input_placeholder="Pega aquí clases, DTOs, JSON o un esquema, o suelta un archivo…",
    editor_keys="Tab sangra. Para salir del editor con el teclado, pulsa Escape y después Tab.",
    open_file="Abrir",
    open_dialog="Abrir modelos",
    model_files="Modelos",
    all_files="Todos los archivos",
    clear="Limpiar",
    format_label="Formato",
    format_auto=lambda detected: f"Detectar ({detected})" if detected else "Detectar automáticamente",
    file_too_large=lambda name: f"«{name}» supera los 10 MB.",
    file_error=lambda name: f"«{name}» no se ha podido leer.",
    received_from=lambda tool: f"Modelos recibidos de {tool}.",
    input_empty="Pega o abre tus modelos para empezar.",
    undetected="No se ha podido detectar el formato: elígelo en la lista.",
    input_summary=lambda format_label, models, fields: (
        f"{format_label} · {_es_number(models)} "
        f"{_plural(models, 'modelo', 'modelos')} · {_es_number(fields)} {_plural(fields, 'campo', 'campos')}"
    ),
    warnings_count=lambda count: f"{_es_number(count)} {_plural(count, 'nota', 'notas')}",
    error_position=lambda line, column: f"Línea {_es_number(line)}, columna {_es_number(column)}",
    parse_issue=_parse_issue_es,
    undo="Deshacer",
    redo="Rehacer",
    reset="Restablecer",
    undo_title="Deshacer (Ctrl/Cmd+Z)",
    redo_title="Rehacer (Ctrl/Cmd+Mayús+Z)",
    reset_title="Volver a la propuesta: se descartan todas tus elecciones",
    confirm_reset="Se descartarán todas las elecciones que has hecho en este diseño. ¿Continuar?",
    design_summary=lambda resources, endpoints: (
        f"{_es_number(resources)} {_plural(resources, 'recurso', 'recursos')}"
        f" · {_es_number(endpoints)} {_plural(endpoints, 'endpoint', 'endpoints')}"
    ),
    issues_summary=lambda errors, warnings: _issues_summary(
        errors,
        warnings,
        _es_number,
        ("problema deja un endpoint fuera del código", "problemas dejan endpoints fuera del código"),
        ("aviso", "avisos"),
    ),
    no_resources="Ningún modelo tiene todavía endpoints propios: convierte alguno en recurso.",
    embedded_section="Dentro de otros recursos",
    embedded_hint="Estos modelos no tienen endpoints: viajan dentro de los recursos que los contienen.",
    status={
        "exact": "Exacta",
        "high": "Alta",
        "probable": "Probable",
        "review": "Revisar",
        "conflict": "Conflicto",
        "none": "Ninguna",
        "manual": "Elegida por ti",
    },
    accept="Confirmar",
    accept_title=lambda subject: f"Confirmar la sugerencia para {subject}",
    reason=_reason_es,
    expose_label="Endpoints",
    key_label="Clave",
    expose_subject=lambda model: f"{model}: endpoints",
    key_subject=lambda model: f"{model}: clave",
    access_subject=lambda field: f"{field}: acceso",
    relation_subject=lambda field: f"{field}: cómo viaja",
    unknown_type_subject=lambda field: f"{field}: tipo",
    expose_options={"resource": "Un recurso con endpoints", "embedded": "Solo dentro de otros recursos"},
    key_option=_key_option_es,
    access_options={"readWrite": "Enviar y leer", "readOnly": "Solo leer", "writeOnly": "Solo enviar"},
    relation_options={"reference": "Su clave", "embedded": "El elemento completo"},
    unknown_type_options={"any": "Cualquier valor JSON", "string": "Texto"},
    resource_path_label=lambda model: f"Ruta de {model}",
    fields_summary=lambda total, included: (
        f"{_es_number(total)} {_plural(total, 'campo', 'campos')}"
        if included == total
        else f"{_es_number(included)} de {_es_number(total)} campos en la API"
    ),
    endpoints_count=lambda enabled, total: f"{_es_number(enabled)} de {_es_number(total)} endpoints activos",
    show_fields="Ver campos",
    hide_fields="Ocultar campos",
    field_include="En la API",
    field_name="Campo",
    field_access="Los clientes pueden",
    field_travels="Viaja como",
    field_validations="Validaciones",
    include_field=lambda field: f"Incluir «{field}» en la API",
    key_always_included="La clave siempre está en la API",
    key_badge="clave",
    travels_as_value="Su valor",
    describe_constraints=lambda c: _describe_constraints(c, "car.", "elem."),
    enable_endpoint=lambda endpoint: f"Generar {endpoint}",
    custom_badge="negocio",
    endpoint_off="desactivado",
    not_generated="no se genera",
    edit="Editar",
    done="Hecho",
    add_endpoint="Añadir un endpoint de negocio",
    remove_endpoint="Quitar",
    method_label="Método",
    path_label="Ruta",
    name_label="Nombre de la operación",
    summary_label="Resumen (en el código, en inglés)",
    access_label="Quién puede llamarlo",
    endpoint_access={
        "default": "Lo del proyecto",
        "public": "Cualquiera",
        "authenticated": "Clientes con credenciales",
        "roles": "Algunos roles",
    },
    roles_label="Roles, separados por comas",
    status_label="Estado de éxito",
    status_default="El habitual",
    input_body_label="Cuerpo",
    output_label="Devuelve",
    custom_input={"none": "Nada", "resource": "Un elemento completo", "partial": "Algunos campos"},
    custom_output={"none": "Nada", "resource": "El elemento", "list": "Una lista de elementos"},
    pagination_label="Por páginas (page y size)",
    filters_label="Filtros",
    sort_label="Ordenar por",
    access_needs_auth="El proyecto no tiene autenticación: esta protección no tiene efecto hasta que elijas una.",
    custom_note="El código recibe la ruta y un método del servicio marcado con TODO; responde 501 hasta que escribas "
    "su lógica.",
    issue=_issue_es,
    project_name="Nombre del proyecto",
    framework_label="Framework",
    languages=_LANGUAGES,
    not_written_yet=lambda framework: f"{framework} · todavía no disponible",
    architecture_label="Arquitectura",
    architectures={"layered": "Por capas", "modular": "Una carpeta por recurso"},
    persistence_label="Almacenamiento",
    persistence={**_PERSISTENCE_EN, "memory": "En memoria, para probarla", "none": "Interfaces por implementar"},
    database_label="Base de datos",
    databases=_DATABASES,
    auth_label="Autenticación",
    auth={
        "none": "Ninguna: todos los endpoints son públicos",
        "apiKey": "Clave de API (X-API-Key)",
        "jwt": "Token JWT (bearer)",
    },
    default_access_label="Por defecto, los endpoints son para",
    java_package_label="Paquete JVM",
    file_tree_label="Archivos generados",
    file_label=lambda path: f"Contenido de {path}",
    copy="Copiar",
    copied="Copiado",
    save_file="Guardar archivo",
    save_open_api="OpenAPI",
    save_zip=lambda count: f"Guardar .zip ({_es_number(count)} {_plural(count, 'archivo', 'archivos')})",
    saved=lambda path: f"Guardado en {path}",
    todo_count=lambda count: f"{_es_number(count)} {_plural(count, 'marca', 'marcas')} TODO para ti",
    open_project="Abrir proyecto",
    save_project="Guardar proyecto",
    project_files="Proyectos de Model2API",
    remember="Recordar en este equipo",
    remember_hint="Guarda tus modelos, decisiones y ajustes solo en este equipo, para seguir otro día. No se envía "
    "nada a ningún sitio.",
    clear_saved="Borrar el trabajo guardado",
    clear_saved_confirm="Se borrará el trabajo guardado en este equipo. ¿Continuar?",
    restored="Se ha recuperado el trabajo guardado en este equipo.",
    saved_cleared="Se ha borrado el trabajo guardado en este equipo.",
    project_loaded=lambda name: f"«{name}» abierto.",
    project_error=lambda error: _PROJECT_ERRORS_ES.get(error, error),
)

MESSAGES = {"en": EN, "es": ES}


class I18n(QObject):
    """The current language, remembered in the settings. Widgets listen to changed to update their texts."""

    changed = Signal()

    def __init__(self, settings: QSettings):
        super().__init__()
        self._settings = settings
        stored = settings.value("language")
        if stored not in MESSAGES:
            stored = "es" if QLocale.system().name().startswith("es") else "en"
        self.language: str = stored

    @property
    def t(self) -> SimpleNamespace:
        return MESSAGES[self.language]

    def set_language(self, language: str) -> None:
        if language == self.language:
            return
        self.language = language
        self._settings.setValue("language", language)
        self.changed.emit()
