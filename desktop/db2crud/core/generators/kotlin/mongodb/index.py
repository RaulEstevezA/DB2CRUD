"""Kotlin + the official MongoDB driver (Strategy of the Kotlin generator): plain entities with a data class per nested
document, repositories over Db (the database and the session of its transaction), and tests on a database made empty for
each one. Mirrors web/src/core/generators/kotlin/mongodb/index.ts."""

import re

from ..context import errors_package, kt_file, package_of, path_of, qualified
from ..documents import identified_lists, nested_imports
from ..kotlin import KtImports, kt_string
from ..tests import test_path
from .repository import body, head, helpers

_VERSION = "5.15.0"
_URL = "mongodb://localhost:27017/app"


def _database_file(context: dict) -> dict:
    pkg = context["base"]
    imports = KtImports(pkg).add(
        "com.mongodb.ConnectionString",
        "com.mongodb.MongoClientSettings",
        "com.mongodb.kotlin.client.MongoClient",
        "org.bson.UuidRepresentation",
    )
    return kt_file(
        path_of(pkg, "AppDatabase"),
        pkg,
        imports.write(),
        [
            "/** The MongoDB database DATABASE_URL names. It creates no collection and no index: the database already exists. */",
            "object AppDatabase {",
            f"    const val DEFAULT_URL = {kt_string(_URL)}",
            "",
            "    /** One client for the whole application: it keeps the connections. */",
            "    private val shared by lazy { client(url()) }",
            "",
            "    /** The URL of DATABASE_URL, or the default one. */",
            '    fun url(): String = System.getenv("DATABASE_URL") ?: DEFAULT_URL',
            "",
            "    /** The name of the database a URL names. */",
            '    fun name(url: String): String = checkNotNull(ConnectionString(url).database) { "The URL names no database" }',
            "",
            "    /** A client for the server at url, which keeps UUIDs as the standard says. */",
            "    fun client(url: String): MongoClient =",
            "        MongoClient.create(",
            "            MongoClientSettings.builder()",
            "                .applyConnectionString(ConnectionString(url))",
            "                .uuidRepresentation(UuidRepresentation.STANDARD)",
            "                .build(),",
            "        )",
            "",
            "    /** A Db over DATABASE_URL, one per unit of work; close it when done. */",
            "    fun open(): Db = Db(shared, name(url()))",
            "}",
        ],
    )


def _db_file(context: dict) -> dict:
    pkg = context["base"]
    imports = KtImports(pkg).add(
        "com.mongodb.MongoException",
        "com.mongodb.client.model.FindOneAndUpdateOptions",
        "com.mongodb.client.model.ReturnDocument",
        "com.mongodb.kotlin.client.ClientSession",
        "com.mongodb.kotlin.client.MongoClient",
        "org.bson.Document",
        qualified(errors_package(context), "ConflictException"),
    )
    return kt_file(
        path_of(pkg, "Db"),
        pkg,
        imports.write(),
        [
            "/** A database and the session of its transaction, when there is one (MongoDB has them on replica sets only). A refused write is a ConflictException. */",
            "class Db(private val client: MongoClient, name: String) : AutoCloseable {",
            "    val database = client.getDatabase(name)",
            "",
            "    private var session: ClientSession? = null",
            "",
            "    val inTransaction: Boolean get() = session != null",
            "",
            "    fun begin() {",
            "        session = client.startSession().also { it.startTransaction() }",
            "    }",
            "",
            "    fun commit() {",
            "        session?.commitTransaction()",
            "        end()",
            "    }",
            "",
            "    fun rollback() {",
            "        session?.let { if (it.hasActiveTransaction) it.abortTransaction() }",
            "        end()",
            "    }",
            "",
            "    override fun close() = rollback()",
            "",
            "    private fun end() {",
            "        session?.close()",
            "        session = null",
            "    }",
            "",
            "    fun collection(name: String) = database.getCollection<Document>(name)",
            "",
            "    fun find(collection: String, filter: Document, sort: Document? = null, skip: Int = 0, limit: Int = 0): List<Document> {",
            "        val found = session?.let { collection(collection).find(it, filter) } ?: collection(collection).find(filter)",
            "        return found.sort(sort).skip(skip).limit(limit).toList()",
            "    }",
            "",
            "    fun count(collection: String, filter: Document): Long =",
            "        session?.let { collection(collection).countDocuments(it, filter) } ?: collection(collection).countDocuments(filter)",
            "",
            "    fun insert(entity: String, collection: String, document: Document) {",
            "        write(entity) { session?.let { collection(collection).insertOne(it, document) } ?: collection(collection).insertOne(document) }",
            "    }",
            "",
            "    fun update(entity: String, collection: String, filter: Document, change: Document) {",
            "        write(entity) { session?.let { collection(collection).updateOne(it, filter, change) } ?: collection(collection).updateOne(filter, change) }",
            "    }",
            "",
            "    fun delete(entity: String, collection: String, filter: Document) {",
            "        write(entity) { session?.let { collection(collection).deleteOne(it, filter) } ?: collection(collection).deleteOne(filter) }",
            "    }",
            "",
            "    /** Changes one document where it is, and gives it as it is then; null when there is none. */",
            "    fun change(entity: String, collection: String, filter: Document, change: Document): Document? =",
            "        write(entity) {",
            "            val session = session",
            "            if (session == null) collection(collection).findOneAndUpdate(filter, change, AFTER)",
            "            else collection(collection).findOneAndUpdate(session, filter, change, AFTER)",
            "        }",
            "",
            "    /** The same, with the stages of a pipeline. */",
            "    fun rewrite(entity: String, collection: String, filter: Document, stages: List<Document>): Document? =",
            "        write(entity) {",
            "            val session = session",
            "            if (session == null) collection(collection).findOneAndUpdate(filter, stages, AFTER)",
            "            else collection(collection).findOneAndUpdate(session, filter, stages, AFTER)",
            "        }",
            "",
            "    /** A repeated value, or one the validator of the collection does not take, as a domain error. */",
            "    private fun <T> write(entity: String, work: () -> T): T =",
            "        try {",
            "            work()",
            "        } catch (error: MongoException) {",
            "            if (error.code != 11000 && error.code != 121) throw error",
            '            throw ConflictException(entity, "the database refused the change: ${error.message}")',
            "        }",
            "",
            "    private companion object {",
            "        val AFTER: FindOneAndUpdateOptions = FindOneAndUpdateOptions().returnDocument(ReturnDocument.AFTER)",
            "    }",
            "}",
        ],
    )


def _documents_file(context: dict) -> dict:
    pkg = context["base"]
    imports = KtImports(pkg).add(
        "java.math.BigDecimal",
        "java.util.Objects",
        "org.bson.Document",
        "org.bson.types.Binary",
        "org.bson.types.Decimal128",
    )
    return kt_file(
        path_of(pkg, "Documents"),
        pkg,
        imports.write(),
        [
            "/** Values of documents, and what changed in one. */",
            "object Documents {",
            "    /** An exact number of a document, whatever the type it was stored with. */",
            "    fun decimal(value: Any?): BigDecimal? =",
            "        when (value) {",
            "            null -> null",
            "            is Decimal128 -> value.bigDecimalValue()",
            "            else -> BigDecimal(value.toString())",
            "        }",
            "",
            "    /** The update that takes a document from what it was to what it is: only the fields that differ, and inside a nested document only its own. */",
            "    fun changes(before: Document?, now: Document, fields: List<String>): Document {",
            "        val set = Document()",
            "        val unset = Document()",
            '        for (field in fields) compare("", field, before?.get(field), now[field], set, unset)',
            "        val result = Document()",
            '        if (set.isNotEmpty()) result["\\$set"] = set',
            '        if (unset.isNotEmpty()) result["\\$unset"] = unset',
            "        return result",
            "    }",
            "",
            "    /** A copy of a value of a document, which stays as it is when the value changes. */",
            "    fun copy(value: Any?): Any? =",
            "        when (value) {",
            "            is Map<*, *> -> Document().also { document -> value.forEach { (name, item) -> document[name.toString()] = copy(item) } }",
            "            is List<*> -> value.map { copy(it) }",
            "            is Binary -> Binary(value.type, value.data.copyOf())",
            "            else -> value",
            "        }",
            "",
            "    private fun compare(path: String, field: String, before: Any?, now: Any?, set: Document, unset: Document) {",
            "        val name = path + field",
            "        if (Objects.deepEquals(before, now)) return",
            '        if (now == null) unset[name] = ""',
            "        else if (before is Document && now is Document)",
            '            (before.keys + now.keys).forEach { compare("$name.", it, before[it], now[it], set, unset) }',
            "        else set[name] = now",
            "    }",
            "}",
        ],
    )


def _parameters(fields: list[tuple[str, str, str | None]]) -> list[str]:
    """The parameters of a class: every property is null until it is set or read."""
    result = []
    for prop, kt, comment in fields:
        if comment:
            text = re.sub(r"\s+", " ", comment.replace("*/", "* /"))
            result.append(f"    /** {text} */")
        result.append(f"    var {prop}: {kt}? = null,")
    return result


def _indented(items: list[str]) -> list[str]:
    return ["" if line == "" else f"    {line}" for line in items]


def _nested_block(item: dict) -> list[str]:
    doc = "/** A nested document: it is stored with the one that holds it. */"
    if not item["fields"]:
        return [doc, f"class {item['name']}"]
    fields = [(field["prop"], field["kt"], field["column"].get("comment")) for field in item["fields"]]
    block = [doc, f"data class {item['name']}(", *_parameters(fields)]
    if not item["classes"]:
        return [*block, ")"]
    inner: list[str] = []
    for index, nested in enumerate(item["classes"]):
        inner += ([""] if index > 0 else []) + _nested_block(nested)
    return [*block, ") {", *_indented(inner), "}"]


def _entity_file(context: dict, info: dict) -> dict:
    pkg = package_of(context, info, "entity")
    imports = KtImports(pkg).add(*nested_imports(info["nested"].values()))
    for column in info["columns"]:
        if column["ktImport"]:
            imports.add(column["ktImport"])
    lists = identified_lists(info)
    members: list[str] = []
    if lists:
        imports.add("org.bson.types.ObjectId")
        members += [
            "/** Gives an identifier to the documents of its lists that have none: MongoDB numbers only whole documents. */",
            "fun identifyItems() {",
            *(f"    {column['prop']}?.forEach {{ it.id = it.id ?: ObjectId().toHexString() }}" for column in lists),
            "}",
            "",
        ]
    for item in info["nested"].values():
        members += [*_nested_block(item), ""]
    members = members[:-1]
    fields = [(column["prop"], column["kt"], column["column"].get("comment")) for column in info["columns"]]
    return kt_file(
        path_of(pkg, info["entity"]),
        pkg,
        imports.write(),
        [
            f'/** A document of the "{info["name"]}" collection; a property stays null until it is set or read. */',
            f"class {info['entity']}(",
            *_parameters(fields),
            *([") {", *_indented(members), "}"] if members else [")"]),
        ],
    )


_TRANSACTION = [
    "    override fun <T> transaction(work: (UnitOfWork) -> T): T {",
    "        // Joins the transaction already open",
    "        if (db.inTransaction) return work(this)",
    "        db.begin()",
    "        try {",
    "            val result = work(this)",
    "            db.commit()",
    "            return result",
    "        } catch (error: Throwable) {",
    "            db.rollback()",
    "            throw error",
    "        }",
    "    }",
]


def _index_lines(context: dict) -> list[str]:
    """The indexes of the collections, for the tests."""
    result = []
    for info in context["tables"]:
        table = info["table"]
        nullable = {column["name"] for column in table["columns"] if column["nullable"]}
        every = [*((item, True) for item in table["uniques"]), *((item, False) for item in table["indexes"])]
        for item, unique in every:
            options = f".name({kt_string(item['name'])})" if item.get("name") else ""
            if unique:
                options += ".unique(true)"
                if all(column in nullable for column in item["columns"]):
                    options += ".sparse(true)"
            first, *others = item["columns"]
            keys = f"Document({kt_string(first)}, 1)"
            keys += "".join(f".append({kt_string(column)}, 1)" for column in others)
            given = f", IndexOptions(){options}" if options else ""
            result.append(f"        db.collection({kt_string(info['name'])}).createIndex({keys}{given})")
    return result


def _test_database_files(context: dict) -> list[dict]:
    indexes = _index_lines(context)
    imports = KtImports(context["base"])
    if indexes:
        imports.add("org.bson.Document")
    if any("IndexOptions()" in line for line in indexes):
        imports.add("com.mongodb.client.model.IndexOptions")
    return [
        kt_file(
            test_path(context, "TestDatabase"),
            context["base"],
            imports.write(),
            [
                "/** The test database: the MongoDB database TEST_DATABASE_URL names, with every collection created empty before every test. */",
                "object TestDatabase {",
                "    val url: String by lazy {",
                '        checkNotNull(System.getenv("TEST_DATABASE_URL")) {',
                '            "The database tests need a disposable MongoDB database (a replica set, for its transactions): set TEST_DATABASE_URL (it is emptied)"',
                "        }",
                "    }",
                "",
                "    val client by lazy { AppDatabase.client(url) }",
                "",
                "    /** The repositories over the test database, with its collections and their indexes created again. */",
                "    fun open(): SqlUnitOfWork {",
                "        val db = Db(client, AppDatabase.name(url))",
                "        db.database.drop()",
                *(f"        db.database.createCollection({kt_string(info['name'])})" for info in context["tables"]),
                *indexes,
                "        return SqlUnitOfWork(db)",
                "    }",
                "}",
            ],
        ),
        kt_file(
            test_path(context, "DatabaseTest"),
            context["base"],
            KtImports(context["base"]).add("kotlin.test.Test", "kotlin.test.assertEquals").write(),
            [
                "/** The tests run on the database they were asked to. */",
                "class DatabaseTest {",
                "    @Test",
                "    fun isTheOneTestDatabaseUrlNames() {",
                "        assertEquals(AppDatabase.name(TestDatabase.url), TestDatabase.open().db.database.name)",
                "    }",
                "}",
            ],
        ),
    ]


MONGODB_ORM = {
    "id": "mongokotlin",
    "documents": True,
    "prefix": "Mongo",
    "url": _URL,
    "holder": {"name": "db", "type": "Db", "ktImport": "app.Db", "text": "Db"},
    "emptyList": lambda _context: "emptyList()",
    "databaseFiles": lambda context: [_database_file(context), _db_file(context), _documents_file(context)],
    "entityFiles": lambda context, info: [_entity_file(context, info)],
    "repository": {
        "imports": lambda *_: [],
        "doc": lambda context: (
            "through the MongoDB driver. Every write is stored at once."
            if context["settings"]["transactions"] == "repository"
            else "through the MongoDB driver. It runs in the transaction already open, when there is one."
        ),
        "head": head,
        "kept": lambda context: "db" if context["settings"]["repositoryInterfaces"] else "held",
        "body": body,
        "helpers": helpers,
    },
    "transaction": lambda *_: _TRANSACTION,
    "testDatabaseFiles": _test_database_files,
    "openTest": lambda context: (
        ["// The caller owns the transaction: the test opens it, and it ends with the test", "uow.db.begin()"]
        if context["settings"]["transactions"] == "caller"
        else []
    ),
    "closeTest": ["uow.db.close()"],
    "dependencies": lambda *_: [f'    implementation("org.mongodb:mongodb-driver-kotlin-sync:{_VERSION}")'],
    "readme": {
        "intro": "plain entities, repositories and services with the MongoDB driver",
        "layout": [
            "src/main/kotlin/app/AppDatabase.kt      opens the database DATABASE_URL names",
            "src/main/kotlin/app/Db.kt               a database and the session of its transaction",
            "src/main/kotlin/app/Documents.kt        values of documents, and what changed in one",
        ],
        "entities": "one entity per collection",
        "table": "entity, repositories and service of each collection",
    },
}
