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


_CHECKS_EN = {
    "validate": "the values",
    "unique": "unique values",
    "parentExists": "the rows it points to",
    "version": "the version",
    "children": "rows that point here",
}
_CHECKS_ES = {
    "validate": "los valores",
    "unique": "los valores únicos",
    "parentExists": "las filas a las que apunta",
    "version": "la versión",
    "children": "las filas que apuntan aquí",
}


def _operation_en(operation: dict) -> str:
    parts = []
    if operation["checks"]:
        parts.append("checks " + ", ".join(_CHECKS_EN[check] for check in operation["checks"]))
    if operation["errors"]:
        parts.append("raises " + ", ".join(operation["errors"]))
    return " · ".join(parts)


def _operation_es(operation: dict) -> str:
    parts = []
    if operation["checks"]:
        parts.append("comprueba " + ", ".join(_CHECKS_ES[check] for check in operation["checks"]))
    if operation["errors"]:
        parts.append("lanza " + ", ".join(operation["errors"]))
    return " · ".join(parts)


def _query_en(kind: str, columns: list[str]) -> str:
    joined = ", ".join(columns)
    return {
        "getByKey": f"one row by its key ({joined})",
        "findByUnique": f"one row by {joined}",
        "findAllBy": f"rows by {joined}",
        "listByParent": f"rows that point to a {joined}",
        "list": "every row",
        "insert": "stores a new row",
        "update": "stores changes",
        "delete": "removes a row",
    }[kind]


def _query_es(kind: str, columns: list[str]) -> str:
    joined = ", ".join(columns)
    return {
        "getByKey": f"una fila por su clave ({joined})",
        "findByUnique": f"una fila por {joined}",
        "findAllBy": f"filas por {joined}",
        "listByParent": f"filas que apuntan a un {joined}",
        "list": "todas las filas",
        "insert": "guarda una fila nueva",
        "update": "guarda cambios",
        "delete": "elimina una fila",
    }[kind]


def _read_error_en(error: str, path: str | None = None) -> str:
    return {
        "notJson": "It is not JSON: open the .model2db.json file Model2DB saves.",
        "notProject": "It is not a Model2DB project.",
        "newerVersion": "The project was saved by a newer version of Model2DB.",
        "invalid": f"The project is damaged{f' ({path})' if path else ''}.",
        "unreadableInput": "The models inside the project cannot be read.",
        "noModels": "The project has no models.",
        "notRelational": "The project is for a database without tables (MongoDB, Redis, Cassandra…): not supported yet.",
        "unknownInput": "It is neither a Model2DB project, nor SQL DDL, nor ORM code it can read (SQLAlchemy, SQLModel, Django, Tortoise, Prisma, TypeORM, Sequelize, Drizzle, JPA/Hibernate, EF Core, Doctrine and Eloquent so far).",
        "noTables": "The code declares no table: a SQLAlchemy class needs its __tablename__, a SQLModel one table=True, a Django or Tortoise one Model, a Prisma schema a model block, a TypeORM class @Entity(), Sequelize models Model.init() or sequelize.define(), a Drizzle schema pgTable(), mysqlTable() or sqliteTable(), a JPA class @Entity, an EF Core model a DbContext with its DbSet<…>, a Doctrine class #[ORM\\Entity], Eloquent the migrations with Schema::create, and SQL DDL a CREATE TABLE.",
    }[error]


def _read_error_es(error: str, path: str | None = None) -> str:
    return {
        "notJson": "No es JSON: abre el archivo .model2db.json que guarda Model2DB.",
        "notProject": "No es un proyecto de Model2DB.",
        "newerVersion": "El proyecto se guardó con una versión más reciente de Model2DB.",
        "invalid": f"El proyecto está dañado{f' ({path})' if path else ''}.",
        "unreadableInput": "No se pueden leer los modelos del proyecto.",
        "noModels": "El proyecto no tiene modelos.",
        "notRelational": "El proyecto es para una base de datos sin tablas (MongoDB, Redis, Cassandra…): todavía no se admite.",
        "unknownInput": "No es un proyecto de Model2DB, ni DDL de SQL, ni código ORM que sepa leer (por ahora, SQLAlchemy, SQLModel, Django, Tortoise, Prisma, TypeORM, Sequelize, Drizzle, JPA/Hibernate, EF Core, Doctrine y Eloquent).",
        "noTables": "El código no declara ninguna tabla: una clase de SQLAlchemy necesita su __tablename__; una de SQLModel, table=True, una de Django o Tortoise, Model; un schema de Prisma, un bloque model, una clase de TypeORM, @Entity(), los modelos de Sequelize, Model.init() o sequelize.define(), un schema de Drizzle, pgTable(), mysqlTable() o sqliteTable(), una clase JPA, @Entity, un modelo de EF Core, un DbContext con sus DbSet<…>, una clase de Doctrine, #[ORM\\Entity]; Eloquent, las migraciones con Schema::create, y el DDL de SQL, un CREATE TABLE.",
    }[error]


def _reason_en(reason: dict) -> str:
    params = reason.get("params")
    return {
        "primaryKey": f"The primary key ({_p(params, 'columns')}) identifies each row.",
        "uniqueConstraint": f"{_p(params, 'columns')} is unique: at most one row has each value.",
        "indexOnly": f"There is an index on {_p(params, 'columns')}, but it may exist only for speed: keep the query if "
        "the application looks rows up by it.",
        "foreignKey": f"Each row points to a row of {_p(params, 'table')}.",
        "readOnlyTable": "The table is read only.",
        "tableWithKey": "The table has a primary key: rows can be read, created, changed and deleted.",
        "noPrimaryKey": "The table has no primary key: a row cannot be told apart from another, so it is only read.",
        "joinTable": f"It only links {_p(params, 'tables')}: links are added and removed from them.",
        "softDeleteColumn": f"“{_p(params, 'column')}” suggests rows are marked as deleted instead of removed.",
        "noSoftDeleteColumn": "No column marks rows as deleted: deleting removes the row.",
        "versionColumn": f"“{_p(params, 'column')}” counts versions: a change made on an old version is refused.",
        "noVersionColumn": "No column counts versions.",
        "childrenWithoutAction": f"Rows of {_p(params, 'tables')} point here and the database does nothing on delete: "
        "refuse the delete while they exist, or delete them first.",
        "secretNamed": f"{_p(params, 'columns')} looks like a secret: it is never returned.",
        "noSecrets": "No column looks like a secret.",
        "modelName": f"The model {_p(params, 'model')} has the name of the table.",
        "modelNames": f"Several models have the name of the table ({_p(params, 'models')}): choose the one the service takes.",
        "noModel": "No model has the name of the table: the service works with the entity.",
        "fieldName": f"The field {_p(params, 'field')} has the name of the column.",
        "fieldWords": f"The field {_p(params, 'field')} has the name of the column in another convention.",
        "lookupUnique": f"{_p(params, 'field')} names a row of {_p(params, 'table')} by its {_p(params, 'column')}, which is unique: the service looks the key up.",
        "lookupNotUnique": f"{_p(params, 'field')} names a row of {_p(params, 'table')} by its {_p(params, 'column')}, but several rows may have it: check the lookup.",
        "generatedColumn": "The database fills the column: the model does not send it.",
        "noFieldRequired": "No field fills the column, and it needs a value: give it a field or a default.",
        "noField": "No field fills the column: it keeps its default or null.",
        "childRows": f"{_p(params, 'field')} lists the rows of {_p(params, 'table')}.",
        "childTables": f"{_p(params, 'field')} may list the rows of several tables ({_p(params, 'tables')}): choose one.",
        "manual": "You chose it.",
    }.get(reason["code"], reason["code"])


def _reason_es(reason: dict) -> str:
    params = reason.get("params")
    return {
        "primaryKey": f"La clave primaria ({_p(params, 'columns')}) identifica cada fila.",
        "uniqueConstraint": f"{_p(params, 'columns')} es único: como mucho una fila tiene cada valor.",
        "indexOnly": f"Hay un índice en {_p(params, 'columns')}, pero puede existir solo por rendimiento: mantén la "
        "consulta si la aplicación busca filas por él.",
        "foreignKey": f"Cada fila apunta a una fila de {_p(params, 'table')}.",
        "readOnlyTable": "La tabla es de solo lectura.",
        "tableWithKey": "La tabla tiene clave primaria: sus filas se pueden leer, crear, cambiar y borrar.",
        "noPrimaryKey": "La tabla no tiene clave primaria: no se puede distinguir una fila de otra, así que solo se lee.",
        "joinTable": f"Solo relaciona {_p(params, 'tables')}: los vínculos se añaden y se quitan desde ellas.",
        "softDeleteColumn": f"«{_p(params, 'column')}» indica que las filas se marcan como borradas en lugar de "
        "eliminarse.",
        "noSoftDeleteColumn": "Ninguna columna marca filas como borradas: borrar elimina la fila.",
        "versionColumn": f"«{_p(params, 'column')}» cuenta versiones: se rechaza un cambio hecho sobre una versión "
        "antigua.",
        "noVersionColumn": "Ninguna columna cuenta versiones.",
        "childrenWithoutAction": f"Filas de {_p(params, 'tables')} apuntan aquí y la base de datos no hace nada al "
        "borrar: rechaza el borrado mientras existan, o bórralas antes.",
        "secretNamed": f"{_p(params, 'columns')} parece un secreto: nunca se devuelve.",
        "noSecrets": "Ninguna columna parece un secreto.",
        "modelName": f"El modelo {_p(params, 'model')} tiene el nombre de la tabla.",
        "modelNames": f"Varios modelos tienen el nombre de la tabla ({_p(params, 'models')}): elige el que recibe el servicio.",
        "noModel": "Ningún modelo tiene el nombre de la tabla: el servicio trabaja con la entidad.",
        "fieldName": f"El campo {_p(params, 'field')} tiene el nombre de la columna.",
        "fieldWords": f"El campo {_p(params, 'field')} tiene el nombre de la columna en otra convención.",
        "lookupUnique": f"{_p(params, 'field')} nombra una fila de {_p(params, 'table')} por su {_p(params, 'column')}, que es único: el servicio busca la clave.",
        "lookupNotUnique": f"{_p(params, 'field')} nombra una fila de {_p(params, 'table')} por su {_p(params, 'column')}, pero varias filas pueden tenerlo: revisa la búsqueda.",
        "generatedColumn": "La base de datos rellena la columna: el modelo no la envía.",
        "noFieldRequired": "Ningún campo rellena la columna, y necesita un valor: dale un campo o un valor por defecto.",
        "noField": "Ningún campo rellena la columna: se queda con su valor por defecto o nulo.",
        "childRows": f"{_p(params, 'field')} enumera las filas de {_p(params, 'table')}.",
        "childTables": f"{_p(params, 'field')} puede enumerar las filas de varias tablas ({_p(params, 'tables')}): elige una.",
        "manual": "Lo has elegido tú.",
    }.get(reason["code"], reason["code"])


EN = SimpleNamespace(
    processed_locally="Processed locally",
    tagline="Generate the repositories and services of a database you already have",
    intro_description="Paste or open your database schema (a Model2DB project, ORM code or SQL DDL) and, if you have them, your "
    "application models. DB2CRUD proposes the repositories, the services and any missing ORM entities, explains "
    "each proposal and lets you change it. Save the code with its tests.",
    developed_by="Developed by",
    workspace_parts={"database": "Database", "design": "Design", "project": "Project"},
    examples_label="Try an example",
    examples={"store": "Online shop", "library": "Library", "catalog": "Catalogue"},
    example_descriptions={
        "store": "Model2DB project for PostgreSQL: customers, products and orders with a password and an enum",
        "library": "Model2DB project with SQLAlchemy entities: authors and books with UUID keys",
        "catalog": "Model2DB project for MySQL: a catalogue of items in a category tree",
    },
    confirm_replace="Your current database and the decisions made on it will be replaced. Continue?",
    input_label="Database to read",
    input_placeholder="Paste a Model2DB project (the .model2db.json file Model2DB saves) or ORM models (SQLAlchemy, SQLModel, Django, Tortoise, a Prisma schema, TypeORM entities, Sequelize models, a Drizzle schema, JPA entities, an EF Core model, Doctrine entities, Laravel migrations and Eloquent models) or SQL DDL (CREATE TABLE…), or drop the files or the folder of a project here…",
    editor_keys="Tab indents. To leave the editor with the keyboard, press Escape and then Tab.",
    input_sources_label="What to read",
    input_sources={"database": "Database schema", "models": "Application models"},
    models_label="Application models",
    models_dialog="Open the application models",
    models_placeholder="Optional: paste or open the models of your application (classes, DTOs, records… in "
    "TypeScript, Python, Java, C#, Kotlin, Dart, Go, Rust, PHP, Swift, Scala; JSON, JSON Schema, OpenAPI, "
    "GraphQL…). The services will take and return them.",
    models_empty="No application models: the services take and return the entities.",
    models_error=lambda code: (
        "The format of these models is not one DB2CRUD reads."
        if code == "unknownFormat"
        else "There is no model in this text."
        if code == "noModels"
        else f"These models cannot be read ({code})."
    ),
    models_summary=lambda form, count: f"{form} · {_en_number(count)} {_plural(count, 'model', 'models')}",
    model_titles={"both": "Application model", "input": "Model written", "output": "Model read"},
    no_model="none",
    source_none="no field",
    source_field=lambda field: f"← {field}",
    source_lookup=lambda field, table, by: f"← {field}, looked up in {table}.{by}",
    target_field=lambda field: f"→ {field}",
    target_lookup=lambda field, table, by: f"→ {field}, from {table}.{by}",
    source_database="filled by the database",
    source_children=lambda table: f"rows of {table}" if table else "no table",
    unused_fields=lambda fields, direction: (
        f"{'Not filled' if direction == 'output' else 'Not saved'}: {', '.join(fields)}"
    ),
    conflict_length=lambda model, column: (
        f"the model allows {_en_number(model)} characters, the column {_en_number(column)}"
    ),
    conflict_nullable="optional in the model, required in the column",
    conflict_nullable_output="required in the model, may be null in the column",
    conflict_type=lambda model, column: f"{model} in the model, {column} in the column",
    conflict_values=lambda missing: f"the column does not accept {', '.join(missing)}",
    conflict_unknown_values=lambda values: f"the model does not accept {', '.join(values)}",
    open_file="Open files",
    open_folder="Open folder",
    open_dialog="Open the database: a Model2DB project, ORM code or SQL DDL",
    folder_dialog="Open the folder of a project",
    files_label="Files of the input",
    too_many_files="The folder has more than 2,000 files to read or more than 20 MB of them: open the folder of the "
    "models or of the migrations.",
    no_readable_files="Nothing to read there: no Model2DB project, ORM code or SQL.",
    project_files="Model2DB projects and ORM code",
    all_files="All files",
    clear="Clear",
    file_too_large=lambda name: f"“{name}” is larger than 10 MB.",
    file_error=lambda name: f"“{name}” could not be read.",
    input_empty="Open files or a folder, or paste a Model2DB project, ORM code or SQL DDL, to start.",
    warnings_count=lambda count: f"{_en_number(count)} {_plural(count, 'note', 'notes')}",
    read_error=_read_error_en,
    database_summary=lambda source, dialect, tables, columns: (
        f"{source} · {dialect or 'any database'} · {_en_number(tables)} {_plural(tables, 'table', 'tables')} · "
        f"{_en_number(columns)} {_plural(columns, 'column', 'columns')}"
    ),
    undo="Undo",
    redo="Redo",
    reset="Reset",
    undo_title="Undo (Ctrl/Cmd+Z)",
    redo_title="Redo (Ctrl/Cmd+Shift+Z)",
    reset_title="Back to the proposal: every choice you made is discarded",
    confirm_reset="Every choice you made on this design will be discarded. Continue?",
    design_empty="The repositories and services proposed for each table will appear here once the database is read.",
    design_summary=lambda repositories, services: (
        f"{_en_number(repositories)} {_plural(repositories, 'repository', 'repositories')} · "
        f"{_en_number(services)} {_plural(services, 'service', 'services')}"
    ),
    pending_count=lambda count: f"{_en_number(count)} {_plural(count, 'item', 'items')} to review",
    policy_kinds={
        "role": "Table",
        "delete": "Delete",
        "concurrency": "Concurrent changes",
        "children": "Rows that point here",
        "hidden": "Never returned",
    },
    policy_subject=lambda table, kind: f"{table}: {kind.lower()}",
    item_subject=lambda table, kind, item: f"{table}: {kind if item == kind else item}",
    field_subject=lambda table, name, model: f"{table}.{name}: {model.lower()}",
    roles={"entity": "Read and written", "join": "Links two tables", "readOnly": "Read only"},
    delete_hard="Remove the row",
    delete_soft=lambda column: f"Mark it in “{column}”",
    concurrency_none="Last change wins",
    concurrency_version=lambda column: f"Check “{column}”",
    children_policies={"block": "Refuse the delete", "deleteFirst": "Delete them first"},
    hidden_none="Nothing hidden",
    entity_missing="entity written",
    queries_title="Repository",
    query_description=_query_en,
    operation_description=_operation_en,
    project_name="Project name",
    stack_label="Language and ORM",
    languages={
        "python": "Python",
        "typescript": "TypeScript",
        "java": "Java",
        "csharp": "C#",
        "php": "PHP",
        "kotlin": "Kotlin",
        "rust": "Rust",
        "swift": "Swift",
    },
    database_label="Database",
    databases={
        "postgresql": "PostgreSQL",
        "mysql": "MySQL",
        "mariadb": "MariaDB",
        "sqlite": "SQLite",
        "sqlserver": "SQL Server",
        "oracle": "Oracle",
    },
    execution_label="Code",
    executions={"sync": "Synchronous", "async": "Asynchronous"},
    entities_label="Entities",
    entities_modes={"missing": "Only the missing ones", "all": "All, written again", "none": "None: import them"},
    entities_module_label="Module of the entities",
    services_label="Services",
    yes="Yes",
    no="No",
    service_types_label="Services take and return",
    service_types={"entities": "The entities", "dtos": "DTOs"},
    dto_kind_label="DTOs as",
    dto_kinds={
        "pydantic": "Pydantic models",
        "dataclass": "Dataclasses",
        "interface": "Interfaces",
        "class": "Classes",
        "record": "Records",
        "readonly": "Readonly classes",
        "data": "Data classes",
        "struct": "Structs",
    },
    updates_label="Updates take",
    updates_modes={
        "partial": "The changed fields",
        "patch": "Patch<T> per field",
        "optional": "Optional<T> per field",
        "full": "Every field (PUT)",
    },
    transactions_label="Transactions",
    transactions={"operation": "One per operation", "caller": "The caller’s", "repository": "One per write"},
    errors_label="Errors",
    error_styles={"exceptions": "Exceptions", "results": "Result values"},
    paging_label="Lists",
    pagings={"offset": "Pages (offset)", "cursor": "Pages (cursor)", "none": "Every row"},
    architecture_label="Folders",
    architectures={"layer": "By layer", "table": "By table"},
    verbs_label="Reads named",
    verbs={"getFind": "get / find", "get": "get", "find": "find"},
    interfaces_label="Repository interfaces",
    memory_label="In-memory repositories",
    tests_label="Tests",
    tests_modes={
        "all": "Services and repositories",
        "services": "Services",
        "repositories": "Repositories",
        "none": "None",
    },
    stack_verified="Verified: a project with this language, ORM, database and code has passed its tests in Docker.",
    stack_not_verified="Not verified yet with this database and code: review it before using it.",
    project_empty="The files of the generated project will appear here.",
    file_tree_label="Generated files",
    file_label=lambda path: f"Content of {path}",
    copy="Copy",
    copied="Copied",
    save_file="Save file",
    save_zip=lambda count: f"Save .zip ({_en_number(count)} {_plural(count, 'file', 'files')})",
    saved=lambda name: f"Saved as “{name}”.",
    todo_count=lambda count: f"{_en_number(count)} TODO {_plural(count, 'mark', 'marks')} left for you",
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
    workspace_parts={"database": "Base de datos", "design": "Diseño", "project": "Proyecto"},
    examples_label="Prueba un ejemplo",
    examples={"store": "Tienda online", "library": "Biblioteca", "catalog": "Catálogo"},
    example_descriptions={
        "store": "Proyecto de Model2DB para PostgreSQL: clientes, productos y pedidos con una contraseña y un enum",
        "library": "Proyecto de Model2DB con entidades de SQLAlchemy: autores y libros con claves UUID",
        "catalog": "Proyecto de Model2DB para MySQL: un catálogo de artículos en un árbol de categorías",
    },
    confirm_replace="Se sustituirán tu base de datos actual y las decisiones tomadas sobre ella. ¿Continuar?",
    input_label="Base de datos que leer",
    input_placeholder="Pega un proyecto de Model2DB (el archivo .model2db.json que guarda Model2DB) o modelos de un ORM (SQLAlchemy, SQLModel, Django, Tortoise, un schema de Prisma, entidades de TypeORM, modelos de Sequelize, un schema de Drizzle, entidades JPA, un modelo de EF Core, entidades de Doctrine, migraciones de Laravel y modelos de Eloquent) o DDL de SQL (CREATE TABLE…), o suelta aquí los archivos o la carpeta de un proyecto…",
    editor_keys="Tab sangra. Para salir del editor con el teclado, pulsa Escape y después Tab.",
    input_sources_label="Qué leer",
    input_sources={"database": "Esquema de la base de datos", "models": "Modelos de aplicación"},
    models_label="Modelos de aplicación",
    models_dialog="Abrir los modelos de aplicación",
    models_placeholder="Opcional: pega o abre los modelos de tu aplicación (clases, DTOs, records… en TypeScript, "
    "Python, Java, C#, Kotlin, Dart, Go, Rust, PHP, Swift, Scala; JSON, JSON Schema, OpenAPI, GraphQL…). Los "
    "servicios los recibirán y devolverán.",
    models_empty="Sin modelos de aplicación: los servicios reciben y devuelven las entidades.",
    models_error=lambda code: (
        "DB2CRUD no lee el formato de estos modelos."
        if code == "unknownFormat"
        else "Este texto no tiene ningún modelo."
        if code == "noModels"
        else f"No se pueden leer estos modelos ({code})."
    ),
    models_summary=lambda form, count: f"{form} · {_es_number(count)} {_plural(count, 'modelo', 'modelos')}",
    model_titles={"both": "Modelo de aplicación", "input": "Modelo que se escribe", "output": "Modelo que se lee"},
    no_model="ninguno",
    source_none="sin campo",
    source_field=lambda field: f"← {field}",
    source_lookup=lambda field, table, by: f"← {field}, buscado en {table}.{by}",
    target_field=lambda field: f"→ {field}",
    target_lookup=lambda field, table, by: f"→ {field}, desde {table}.{by}",
    source_database="la rellena la base de datos",
    source_children=lambda table: f"filas de {table}" if table else "ninguna tabla",
    unused_fields=lambda fields, direction: (
        f"{'No se rellenan' if direction == 'output' else 'No se guardan'}: {', '.join(fields)}"
    ),
    conflict_length=lambda model, column: (
        f"el modelo admite {_es_number(model)} caracteres; la columna, {_es_number(column)}"
    ),
    conflict_nullable="opcional en el modelo, obligatoria en la columna",
    conflict_nullable_output="obligatorio en el modelo, la columna admite nulos",
    conflict_type=lambda model, column: f"{model} en el modelo, {column} en la columna",
    conflict_values=lambda missing: f"la columna no admite {', '.join(missing)}",
    conflict_unknown_values=lambda values: f"el modelo no admite {', '.join(values)}",
    open_file="Abrir archivos",
    open_folder="Abrir carpeta",
    open_dialog="Abrir la base de datos: un proyecto de Model2DB, código ORM o DDL de SQL",
    folder_dialog="Abrir la carpeta de un proyecto",
    files_label="Archivos de la entrada",
    too_many_files="La carpeta tiene más de 2000 archivos que leer o más de 20 MB: abre la carpeta de los modelos o "
    "de las migraciones.",
    no_readable_files="No hay nada que leer: ni proyecto de Model2DB, ni código ORM, ni SQL.",
    project_files="Proyectos de Model2DB y código ORM",
    all_files="Todos los archivos",
    clear="Limpiar",
    file_too_large=lambda name: f"«{name}» ocupa más de 10 MB.",
    file_error=lambda name: f"No se ha podido leer «{name}».",
    input_empty="Abre archivos o una carpeta, o pega un proyecto de Model2DB, código ORM o DDL de SQL, para empezar.",
    warnings_count=lambda count: f"{_es_number(count)} {_plural(count, 'nota', 'notas')}",
    read_error=_read_error_es,
    database_summary=lambda source, dialect, tables, columns: (
        f"{source} · {dialect or 'cualquier base de datos'} · {_es_number(tables)} {_plural(tables, 'tabla', 'tablas')} · "
        f"{_es_number(columns)} {_plural(columns, 'columna', 'columnas')}"
    ),
    undo="Deshacer",
    redo="Rehacer",
    reset="Restablecer",
    undo_title="Deshacer (Ctrl/Cmd+Z)",
    redo_title="Rehacer (Ctrl/Cmd+Mayús+Z)",
    reset_title="Volver a la propuesta: se descartan todas tus elecciones",
    confirm_reset="Se descartarán todas las elecciones que has hecho en este diseño. ¿Continuar?",
    design_empty="Aquí aparecerán los repositorios y servicios propuestos para cada tabla en cuanto se lea la base de datos.",
    design_summary=lambda repositories, services: (
        f"{_es_number(repositories)} {_plural(repositories, 'repositorio', 'repositorios')} · "
        f"{_es_number(services)} {_plural(services, 'servicio', 'servicios')}"
    ),
    pending_count=lambda count: f"{_es_number(count)} {_plural(count, 'elemento', 'elementos')} por revisar",
    policy_kinds={
        "role": "Tabla",
        "delete": "Borrado",
        "concurrency": "Cambios a la vez",
        "children": "Filas que apuntan aquí",
        "hidden": "Nunca se devuelve",
    },
    policy_subject=lambda table, kind: f"{table}: {kind.lower()}",
    item_subject=lambda table, kind, item: f"{table}: {kind if item == kind else item}",
    field_subject=lambda table, name, model: f"{table}.{name}: {model.lower()}",
    roles={"entity": "Se lee y se escribe", "join": "Relaciona dos tablas", "readOnly": "Solo lectura"},
    delete_hard="Eliminar la fila",
    delete_soft=lambda column: f"Marcarla en «{column}»",
    concurrency_none="Gana el último cambio",
    concurrency_version=lambda column: f"Comprobar «{column}»",
    children_policies={"block": "Rechazar el borrado", "deleteFirst": "Borrarlas antes"},
    hidden_none="Nada oculto",
    entity_missing="entidad generada",
    queries_title="Repositorio",
    query_description=_query_es,
    operation_description=_operation_es,
    project_name="Nombre del proyecto",
    stack_label="Lenguaje y ORM",
    languages={
        "python": "Python",
        "typescript": "TypeScript",
        "java": "Java",
        "csharp": "C#",
        "php": "PHP",
        "kotlin": "Kotlin",
        "rust": "Rust",
        "swift": "Swift",
    },
    database_label="Base de datos",
    databases={
        "postgresql": "PostgreSQL",
        "mysql": "MySQL",
        "mariadb": "MariaDB",
        "sqlite": "SQLite",
        "sqlserver": "SQL Server",
        "oracle": "Oracle",
    },
    execution_label="Código",
    executions={"sync": "Síncrono", "async": "Asíncrono"},
    entities_label="Entidades",
    entities_modes={
        "missing": "Solo las que faltan",
        "all": "Todas, escritas de nuevo",
        "none": "Ninguna: se importan",
    },
    entities_module_label="Módulo de las entidades",
    services_label="Servicios",
    yes="Sí",
    no="No",
    service_types_label="Los servicios reciben y devuelven",
    service_types={"entities": "Las entidades", "dtos": "DTOs"},
    dto_kind_label="DTOs como",
    dto_kinds={
        "pydantic": "Modelos de Pydantic",
        "dataclass": "Dataclasses",
        "interface": "Interfaces",
        "class": "Clases",
        "record": "Records",
        "readonly": "Clases readonly",
        "data": "Data classes",
        "struct": "Structs",
    },
    updates_label="Las actualizaciones reciben",
    updates_modes={
        "partial": "Los campos que cambian",
        "patch": "Patch<T> por campo",
        "optional": "Optional<T> por campo",
        "full": "Todos los campos (PUT)",
    },
    transactions_label="Transacciones",
    transactions={"operation": "Una por operación", "caller": "Las de quien llama", "repository": "Una por escritura"},
    errors_label="Errores",
    error_styles={"exceptions": "Excepciones", "results": "Valores de resultado"},
    paging_label="Listas",
    pagings={"offset": "Páginas (desplazamiento)", "cursor": "Páginas (cursor)", "none": "Todas las filas"},
    architecture_label="Carpetas",
    architectures={"layer": "Por capa", "table": "Por tabla"},
    verbs_label="Lecturas con",
    verbs={"getFind": "get / find", "get": "get", "find": "find"},
    interfaces_label="Interfaces de repositorio",
    memory_label="Repositorios en memoria",
    tests_label="Pruebas",
    tests_modes={
        "all": "Servicios y repositorios",
        "services": "Servicios",
        "repositories": "Repositorios",
        "none": "Ninguna",
    },
    stack_verified="Verificado: un proyecto con este lenguaje, ORM, base de datos y código ha pasado sus pruebas en Docker.",
    stack_not_verified="Todavía sin verificar con esta base de datos y este código: revísalo antes de usarlo.",
    project_empty="Aquí aparecerán los archivos del proyecto generado.",
    file_tree_label="Archivos generados",
    file_label=lambda path: f"Contenido de {path}",
    copy="Copiar",
    copied="Copiado",
    save_file="Guardar archivo",
    save_zip=lambda count: f"Guardar .zip ({_es_number(count)} {_plural(count, 'archivo', 'archivos')})",
    saved=lambda name: f"Guardado como «{name}».",
    todo_count=lambda count: f"{_es_number(count)} {_plural(count, 'marca', 'marcas')} TODO para ti",
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
