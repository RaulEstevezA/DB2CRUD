"""English and Spanish texts. Mirrors web/src/i18n/messages.ts for the texts both versions share; the desktop says
"this computer" where the web says "this browser", and "Save" where it says "Download". Texts that depend on a
value are functions."""

from types import SimpleNamespace

from PySide6.QtCore import QLocale, QObject, QSettings, Signal

from ..core.js import js_string


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
    return {
        "manual": "You chose it.",
    }.get(reason["code"], reason["code"])


def _reason_es(reason: dict) -> str:
    return {
        "manual": "Lo has elegido tú.",
    }.get(reason["code"], reason["code"])


EN = SimpleNamespace(
    processed_locally="Processed locally",
    tagline="Generate the repositories and services of a database you already have",
    intro_description="Paste or open your database schema (a Model2DB project, ORM code or SQL DDL) and, if you have them, your "
    "application models. DB2CRUD proposes the repositories, the services and any missing ORM entities, explains "
    "each proposal and lets you change it. Save the code with its tests.",
    developed_by="Developed by",
    workspace_parts={"models": "Models"},
    examples_label="Try an example",
    examples={"store": "Online shop", "library": "Library", "catalog": "JPA catalogue"},
    example_descriptions={
        "store": "TypeScript interfaces: references, value objects, lists, an enum and a password",
        "library": "Pydantic models with lengths, ranges, a pattern and UUID keys",
        "catalog": "JPA entities with Bean Validation and a category tree",
    },
    confirm_replace="Your current models and the decisions made on them will be replaced. Continue?",
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
)

ES = SimpleNamespace(
    processed_locally="Procesado en local",
    tagline="Genera los repositorios y servicios de una base de datos que ya tienes",
    intro_description="Pega o abre el esquema de tu base de datos (un proyecto de Model2DB, código ORM o DDL de SQL) y, si los "
    "tienes, tus modelos de aplicación. DB2CRUD propone los repositorios, los servicios y las entidades ORM que "
    "falten, explica cada propuesta y te deja cambiarla. Guarda el código con sus pruebas.",
    developed_by="Desarrollado por",
    workspace_parts={"models": "Modelos"},
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
