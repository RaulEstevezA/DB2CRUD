"""Rust + the official MongoDB driver (Strategy of the Rust generator): plain entities with a struct per nested document,
which are read from documents and written as them, repositories over Db (the database and the session of its transaction),
and tests on a database made empty for each one. Mirrors web/src/core/generators/rust/mongodb/index.ts."""

import re

from ..context import file_of, module_of, rs_file
from ..documents import identified_lists, nested_crates
from ..rust import RsUses, rs_string
from ..tests import TESTS, external, unit_of_work
from .repository import body
from .values import reads, value_functions, writes

_VERSION = "3.10.2"
_TOKIO = "1.54.1"
_URL = "mongodb://localhost:27017/app"


def _session(call: str) -> str:
    return f"            Some(session) => {call}.session(&mut *session.lock().await).await,"


def _plain(call: str) -> str:
    return f"            None => {call}.await,"


def _database_file(_context: dict) -> dict:
    return rs_file(
        "src/database.rs",
        "\n".join(
            [
                "use std::sync::Arc;",
                "",
                "use mongodb::bson::Document;",
                "use mongodb::error::{Error, ErrorKind, WriteFailure};",
                "use mongodb::options::{ReturnDocument, UpdateModifications};",
                "use mongodb::{Client, ClientSession, Collection, Database};",
                "use tokio::sync::Mutex;",
                "",
                "use crate::errors::DomainError;",
            ]
        ),
        [
            f"pub const DEFAULT_URL: &str = {rs_string(_URL)};",
            "",
            "/// The database DATABASE_URL names (DEFAULT_URL when it is not set). It creates no collection and no index: the",
            "/// database already exists.",
            "pub async fn connect() -> Result<Database, Error> {",
            '    let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| DEFAULT_URL.to_string());',
            "    database_at(&url).await",
            "}",
            "",
            "/// The database a URL names.",
            "pub async fn database_at(url: &str) -> Result<Database, Error> {",
            "    let client = Client::with_uri_str(url).await?;",
            '    client.default_database().ok_or_else(|| Error::custom("the URL names no database"))',
            "}",
            "",
            "/// A database and the session of its transaction, when there is one (MongoDB has them on replica sets only). A refused",
            "/// write is a Conflict.",
            "#[derive(Clone)]",
            "pub struct Db {",
            "    pub database: Database,",
            "    pub session: Option<Arc<Mutex<ClientSession>>>,",
            "}",
            "",
            "impl Db {",
            "    pub fn collection(&self, name: &str) -> Collection<Document> {",
            "        self.database.collection(name)",
            "    }",
            "",
            "    pub async fn find_one(&self, collection: &str, filter: Document) -> Result<Option<Document>, Error> {",
            "        let find = self.collection(collection);",
            "        match &self.session {",
            _session("find.find_one(filter)"),
            _plain("find.find_one(filter)"),
            "        }",
            "    }",
            "",
            "    /// The documents of a filter, in order; at most `limit` of them when it is not 0.",
            "    pub async fn find(&self, collection: &str, filter: Document, sort: Document, skip: u64, limit: u64) -> Result<Vec<Document>, Error> {",
            "        let source = self.collection(collection);",
            "        let find = source.find(filter).sort(sort).skip(skip).limit(limit as i64);",
            "        let mut found = Vec::new();",
            "        match &self.session {",
            "            Some(session) => {",
            "                let mut session = session.lock().await;",
            "                let mut cursor = find.session(&mut *session).await?;",
            "                while cursor.advance(&mut session).await? {",
            "                    found.push(cursor.deserialize_current()?);",
            "                }",
            "            }",
            "            None => {",
            "                let mut cursor = find.await?;",
            "                while cursor.advance().await? {",
            "                    found.push(cursor.deserialize_current()?);",
            "                }",
            "            }",
            "        }",
            "        Ok(found)",
            "    }",
            "",
            "    pub async fn count(&self, collection: &str, filter: Document) -> Result<u64, Error> {",
            "        let source = self.collection(collection);",
            "        match &self.session {",
            _session("source.count_documents(filter)"),
            _plain("source.count_documents(filter)"),
            "        }",
            "    }",
            "",
            "    pub async fn insert(&self, entity: &str, collection: &str, document: &Document) -> Result<(), DomainError> {",
            "        let target = self.collection(collection);",
            "        let result = match &self.session {",
            _session("target.insert_one(document)"),
            _plain("target.insert_one(document)"),
            "        };",
            "        result.map(|_| ()).map_err(|error| refused(entity, error))",
            "    }",
            "",
            "    pub async fn update(&self, entity: &str, collection: &str, filter: Document, change: Document) -> Result<(), DomainError> {",
            "        let target = self.collection(collection);",
            "        let result = match &self.session {",
            _session("target.update_one(filter, change)"),
            _plain("target.update_one(filter, change)"),
            "        };",
            "        result.map(|_| ()).map_err(|error| refused(entity, error))",
            "    }",
            "",
            "    pub async fn delete(&self, entity: &str, collection: &str, filter: Document) -> Result<(), DomainError> {",
            "        let target = self.collection(collection);",
            "        let result = match &self.session {",
            _session("target.delete_one(filter)"),
            _plain("target.delete_one(filter)"),
            "        };",
            "        result.map(|_| ()).map_err(|error| refused(entity, error))",
            "    }",
            "",
            "    /// Changes one document where it is, and gives it as it is then; None when there is none.",
            "    pub async fn change(",
            "        &self,",
            "        entity: &str,",
            "        collection: &str,",
            "        filter: Document,",
            "        change: impl Into<UpdateModifications>,",
            "    ) -> Result<Option<Document>, DomainError> {",
            "        let target = self.collection(collection);",
            "        let update = target.find_one_and_update(filter, change).return_document(ReturnDocument::After);",
            "        let result = match &self.session {",
            _session("update"),
            _plain("update"),
            "        };",
            "        result.map_err(|error| refused(entity, error))",
            "    }",
            "}",
            "",
            "/// A repeated value, or one the validator of the collection does not take, becomes a Conflict.",
            "fn refused(entity: &str, error: Error) -> DomainError {",
            "    let code = match error.kind.as_ref() {",
            "        ErrorKind::Write(WriteFailure::WriteError(refusal)) => refusal.code,",
            "        ErrorKind::Command(refusal) => refusal.code,",
            "        _ => 0,",
            "    };",
            "    if code == 11000 || code == 121 {",
            '        DomainError::conflict(entity, &format!("the database refused the change: {error}"), &[])',
            "    } else {",
            "        error.into()",
            "    }",
            "}",
        ],
        [
            "The database DATABASE_URL names, through the MongoDB driver. It never migrates: the database already exists."
        ],
    )


def _crates_in_use(context: dict) -> set[str]:
    """Every crate the types of the entities come from."""
    result: set[str] = set()
    for info in context["tables"]:
        result.update(column["crate"] for column in info["columns"] if column["crate"])
        result.update(nested_crates(info["nested"].values()))
    return result


_DECIMAL = [
    "/// An exact number, whatever the type it was stored with.",
    "fn decimal(value: &Bson) -> Option<rust_decimal::Decimal> {",
    "    let text = match value {",
    "        Bson::Decimal128(number) => number.to_string(),",
    "        Bson::Int32(number) => number.to_string(),",
    "        Bson::Int64(number) => number.to_string(),",
    "        Bson::Double(number) => number.to_string(),",
    "        _ => return None,",
    "    };",
    "    text.parse().ok().or_else(|| rust_decimal::Decimal::from_scientific(&text).ok())",
    "}",
    "",
]


def _values_file(context: dict) -> dict:
    crates = _crates_in_use(context)
    names = ["Binary", "Bson", "Document", "oid::ObjectId", "spec::BinarySubtype"]
    if "chrono" in crates:
        names.append("DateTime")
    return rs_file(
        "src/bson_values.rs",
        f"use mongodb::bson::{{{', '.join(sorted(names))}}};\nuse mongodb::error::Error;",
        [
            "/// The document an entity was read from, or stored as: a change writes only the fields that differ. It is no part of the",
            "/// value of the entity.",
            "#[derive(Debug, Clone, Default)]",
            "pub struct Loaded(pub Option<Document>);",
            "",
            "impl PartialEq for Loaded {",
            "    fn eq(&self, _other: &Self) -> bool {",
            "        true",
            "    }",
            "}",
            "",
            "/// The update that takes a document from what it was to what it is: only the fields that differ, and inside a nested",
            "/// document only its own.",
            "pub fn changes(before: Option<&Document>, now: &Document, fields: &[&str]) -> Document {",
            "    let mut set = Document::new();",
            "    let mut unset = Document::new();",
            "    for field in fields {",
            "        compare(field, before.and_then(|before| before.get(*field)), now.get(*field), &mut set, &mut unset);",
            "    }",
            "    let mut result = Document::new();",
            "    if !set.is_empty() {",
            '        result.insert("$set", set);',
            "    }",
            "    if !unset.is_empty() {",
            '        result.insert("$unset", unset);',
            "    }",
            "    result",
            "}",
            "",
            "fn compare(path: &str, before: Option<&Bson>, now: Option<&Bson>, set: &mut Document, unset: &mut Document) {",
            "    if before == now {",
            "        return;",
            "    }",
            "    match (before, now) {",
            "        (_, None) => {",
            '            unset.insert(path, "");',
            "        }",
            "        (Some(Bson::Document(before)), Some(Bson::Document(now))) => {",
            "            for name in before.keys().chain(now.keys().filter(|name| !before.contains_key(name))) {",
            '                compare(&format!("{path}.{name}"), before.get(name), now.get(name), set, unset);',
            "            }",
            "        }",
            "        (_, Some(value)) => {",
            "            set.insert(path, value.clone());",
            "        }",
            "    }",
            "}",
            "",
            "/// Adds a field of the document to what an update sets.",
            "pub fn also_set(changes: &mut Document, now: &Document, field: &str) {",
            '    let mut set = changes.get_document("$set").cloned().unwrap_or_default();',
            "    set.insert(field, now.get(field).cloned());",
            '    changes.insert("$set", set);',
            "}",
            "",
            "/// Whether a text is an identifier of MongoDB.",
            "pub fn is_object_id(text: &str) -> bool {",
            "    ObjectId::parse_str(text).is_ok()",
            "}",
            "",
            "/// A field of a document, if it has it.",
            "pub fn read<T>(document: &Document, field: &str, from: impl Fn(&Bson) -> Result<T, Error>) -> Result<Option<T>, Error> {",
            "    match document.get(field) {",
            "        None | Some(Bson::Null) => Ok(None),",
            "        Some(value) => from(value).map(Some),",
            "    }",
            "}",
            "",
            "/// Writes a field of a document, if there is a value: what is None is left out.",
            "pub fn write<T>(document: &mut Document, field: &str, value: &Option<T>, to: impl Fn(&T) -> Result<Bson, Error>) -> Result<(), Error> {",
            "    if let Some(value) = value {",
            "        document.insert(field, to(value)?);",
            "    }",
            "    Ok(())",
            "}",
            "",
            "/// Reads a list with the function of its items.",
            "pub fn as_list<T>(from: impl Fn(&Bson) -> Result<T, Error>) -> impl Fn(&Bson) -> Result<Vec<T>, Error> {",
            "    move |value| {",
            "        let items = value.as_array().ok_or_else(|| unexpected(value))?;",
            "        items.iter().filter(|item| **item != Bson::Null).map(&from).collect()",
            "    }",
            "}",
            "",
            "/// Writes a list with the function of its items.",
            "pub fn of_list<T>(to: impl Fn(&T) -> Result<Bson, Error>) -> impl Fn(&Vec<T>) -> Result<Bson, Error> {",
            "    move |items| Ok(Bson::Array(items.iter().map(&to).collect::<Result<_, _>>()?))",
            "}",
            "",
            "/// Reads a nested document with the function of its struct.",
            "pub fn as_nested<T>(from: impl Fn(&Document) -> Result<T, Error>) -> impl Fn(&Bson) -> Result<T, Error> {",
            "    move |value| from(value.as_document().ok_or_else(|| unexpected(value))?)",
            "}",
            "",
            "/// Writes a nested document with the function of its struct.",
            "pub fn of_nested<T>(to: impl Fn(&T) -> Result<Document, Error>) -> impl Fn(&T) -> Result<Bson, Error> {",
            "    move |value| to(value).map(Bson::Document)",
            "}",
            "",
            "fn unexpected(value: &Bson) -> Error {",
            '    Error::custom(format!("a document has a value of another type: {value}"))',
            "}",
            "",
            "/// A whole number, whatever the type it was stored with.",
            "fn whole(value: &Bson) -> Option<i64> {",
            "    match value {",
            "        Bson::Int32(number) => Some(i64::from(*number)),",
            "        Bson::Int64(number) => Some(*number),",
            "        Bson::Double(number) if number.fract() == 0.0 => Some(*number as i64),",
            "        _ => None,",
            "    }",
            "}",
            "",
            "/// A number, whatever the type it was stored with.",
            "fn number(value: &Bson) -> Option<f64> {",
            "    match value {",
            "        Bson::Double(number) => Some(*number),",
            "        Bson::Int32(number) => Some(f64::from(*number)),",
            "        Bson::Int64(number) => Some(*number as f64),",
            "        _ => None,",
            "    }",
            "}",
            "",
            *(_DECIMAL if "rust_decimal" in crates else []),
            "fn binary(value: &Bson) -> Option<&Vec<u8>> {",
            "    match value {",
            "        Bson::Binary(binary) => Some(&binary.bytes),",
            "        _ => None,",
            "    }",
            "}",
            *value_functions(crates),
        ],
        ["Values between Rust and the documents of MongoDB, and what changed in a document."],
    )


def _document_functions(name: str, fields: list[dict], entity: bool, identified: list[dict]) -> list[str]:
    """The functions that read a struct from a document and write it as one; a field is {"column", "field", "nested"}."""
    read = []
    write = []
    for item in fields:
        column = item["column"]
        stored = rs_string(column["name"])
        from_ = reads(column["type"], item["nested"])
        read.append(f"            {item['field']}: bson_values::read(document, {stored}, {from_})?,")
        to = writes(column["type"], item["nested"])
        write.append(f"        bson_values::write(&mut document, {stored}, &self.{item['field']}, {to})?;")
    if entity:
        built = [
            f"        let mut entity = {name} {{",
            *read,
            "            loaded_document: Loaded::default(),",
            "        };",
            "        entity.loaded_document = Loaded(Some(entity.to_document()?));",
            "        Ok(entity)",
        ]
    else:
        built = [f"        Ok({name} {{", *read, "        })"]
    identify = []
    for column in identified:
        identify += [
            f"        for item in self.{column['field']}.iter_mut().flatten() {{",
            "            item.id.get_or_insert_with(|| ObjectId::new().to_hex());",
            "        }",
        ]
    return [
        f"impl {name} {{",
        "    /// What a document holds.",
        f"    pub fn from_document({'' if fields or entity else '_'}document: &Document) -> Result<Self, Error> {{",
        *built,
        "    }",
        "",
        "    /// Its document: what is None is left out.",
        "    pub fn to_document(&self) -> Result<Document, Error> {",
        f"        let {'mut ' if fields else ''}document = Document::new();",
        *write,
        "        Ok(document)",
        "    }",
        *(
            [
                "",
                "    /// Gives an identifier to the documents of its lists that have none: MongoDB numbers only whole documents.",
                "    pub fn identify_items(&mut self) {",
                *identify,
                "    }",
            ]
            if identify
            else []
        ),
        "}",
    ]


def _field_lines(column: dict, field: str, rs: str) -> list[str]:
    comment = column.get("comment")
    doc = ["    /// " + re.sub(r"\s+", " ", comment)] if comment else []
    return [*doc, f"    pub {field}: Option<{rs}>,"]


def _nested_block(item: dict) -> list[str]:
    fields: list[str] = []
    for field in item["fields"]:
        fields += _field_lines(field["column"], field["field"], field["rs"])
    return [
        "",
        "/// A nested document: it is stored with the one that holds it.",
        "#[derive(Debug, Clone, Default, PartialEq)]",
        *([f"pub struct {item['name']} {{", *fields, "}"] if fields else [f"pub struct {item['name']} {{}}"]),
        "",
        *_document_functions(item["name"], item["fields"], False, []),
        *(line for inner in item["structs"] for line in _nested_block(inner)),
    ]


def _entity_file(context: dict, info: dict) -> dict:
    comment = f": {info['table']['comment']}" if info["table"].get("comment") else ""
    identified = identified_lists(info)
    uses = RsUses().add(
        "crate::bson_values", "crate::bson_values::Loaded", "mongodb::bson::Document", "mongodb::error::Error"
    )
    if identified:
        uses.add("mongodb::bson::oid::ObjectId")
    module = module_of(context, info, "entity")
    fields: list[str] = []
    for column in info["columns"]:
        fields += _field_lines(column["column"], column["field"], column["rs"])
    written = [
        {"column": column["column"], "field": column["field"], "nested": info["nested"].get(column["column"]["name"])}
        for column in info["columns"]
    ]
    body_lines = [
        f'/// A document of the "{info["name"]}" collection{comment}. A field stays `None` until it is set or read.',
        "#[derive(Debug, Clone, Default, PartialEq)]",
        f"pub struct {info['entity']} {{",
        *fields,
        "    /// As it was read: a change writes only what differs",
        "    pub loaded_document: Loaded,",
        "}",
        "",
        *_document_functions(info["entity"], written, True, identified),
        *(line for item in info["nested"].values() for line in _nested_block(item)),
    ]
    # The structs of the module name each other without it
    return rs_file(file_of(module), uses.write(), [line.replace(f"{module}::", "") for line in body_lines])


_UNIT = {
    "uses": [
        "mongodb::ClientSession",
        "mongodb::Database",
        "std::sync::Arc",
        "tokio::sync::Mutex",
    ],
    "constructors": [
        "    /// The repositories over a database: every write outside a transaction is stored at once.",
        "    pub fn new(database: Database) -> Self {",
        "        Self { db: Db { database, session: None }, joined: false }",
        "    }",
        "",
        "    /// The repositories inside the transaction of a session someone else opened; commit() commits it.",
        "    pub fn in_transaction(database: Database, session: ClientSession) -> Self {",
        "        Self { db: Db { database, session: Some(Arc::new(Mutex::new(session))) }, joined: false }",
        "    }",
    ],
    "fields": [
        "    /// Whether someone else opened the transaction, and commits it",
        "    joined: bool,",
    ],
    "begin": [
        "        // Joins the transaction already open: whoever opened it commits it",
        "        if self.db.session.is_some() {",
        "            return Ok(Box::new(SqlUnitOfWork { db: self.db.clone(), joined: true }));",
        "        }",
        "        let mut session = self.db.database.client().start_session().await?;",
        "        session.start_transaction().await?;",
        "        Ok(Box::new(SqlUnitOfWork::in_transaction(self.db.database.clone(), session)))",
    ],
    "commit": [
        "        if let (Some(session), false) = (&self.db.session, self.joined) {",
        "            session.lock().await.commit_transaction().await?;",
        "        }",
        "        Ok(())",
    ],
}


def _index_lines(context: dict) -> list[str]:
    """The indexes of the collections, for the tests."""
    result = []
    for info in context["tables"]:
        table = info["table"]
        nullable = {column["name"] for column in table["columns"] if column["nullable"]}
        every = [*((item, True) for item in table["uniques"]), *((item, False) for item in table["indexes"])]
        for item, unique in every:
            options = f".name({rs_string(item['name'])}.to_string())" if item.get("name") else ""
            if unique:
                options += ".unique(true)"
                if all(column in nullable for column in item["columns"]):
                    options += ".sparse(true)"
            keys = ", ".join(f"{rs_string(column)}: 1" for column in item["columns"])
            given = f".options(IndexOptions::builder(){options}.build())" if options else ""
            collection = f"database.collection::<Document>({rs_string(info['name'])})"
            result += [
                f"    let index = IndexModel::builder().keys(doc! {{ {keys} }}){given}.build();",
                f'    {collection}.create_index(index).await.expect("an index");',
            ]
    return result


def _test_database_file(context: dict) -> dict:
    indexes = _index_lines(context)
    uses = RsUses().add(
        "tokio::sync::Mutex",
        "tokio::sync::MutexGuard",
        "mongodb::Database",
        f"{unit_of_work(context)}::SqlUnitOfWork",
        external(context, "crate::database::database_at"),
    )
    if indexes:
        uses.add("mongodb::IndexModel", "mongodb::bson::Document", "mongodb::bson::doc")
    if any("IndexOptions" in line for line in indexes):
        uses.add("mongodb::options::IndexOptions")
    collections = [
        f'    database.create_collection({rs_string(info["name"])}).await.expect("a collection");'
        for info in context["tables"]
    ]
    return {
        "path": f"{TESTS}/database.rs",
        "content": "\n".join(
            [
                "//! The test database: the MongoDB database TEST_DATABASE_URL names, with every collection created empty before every test.",
                "",
                uses.write(),
                "",
                "/// Every test empties the same database: they take turns",
                "static TURN: Mutex<()> = Mutex::const_new(());",
                "",
                "/// The test database.",
                "pub async fn connect() -> Database {",
                '    let url = std::env::var("TEST_DATABASE_URL").expect(',
                '        "The database tests need a disposable MongoDB database (a replica set, for its transactions): set TEST_DATABASE_URL (it is emptied)",',
                "    );",
                '    database_at(&url).await.expect("the test database")',
                "}",
                "",
                "/// The repositories over the test database, with its collections and their indexes created again, and the turn of the",
                "/// test that holds it.",
                "pub async fn open() -> (MutexGuard<'static, ()>, SqlUnitOfWork) {",
                "    let turn = TURN.lock().await;",
                "    let database = connect().await;",
                '    database.drop().await.expect("an empty database");',
                *collections,
                *indexes,
                "    (turn, SqlUnitOfWork::new(database))",
                "}",
                "",
                "#[tokio::test]",
                "async fn is_the_one_test_database_url_names() {",
                "    let _turn = TURN.lock().await;",
                '    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");',
                "    let name = url.rsplit('/').next().and_then(|name| name.split('?').next());",
                "    assert_eq!(name, Some(connect().await.name()));",
                "}",
                "",
            ]
        ),
    }


MONGODB_ORM = {
    "id": "mongorust",
    "label": "the MongoDB driver",
    "error": "mongodb::error::Error",
    "documents": True,
    "prefix": "Mongo",
    "url": _URL,
    "emptyList": lambda _context: "Vec::new()",
    "databaseFiles": lambda context: [_database_file(context), _values_file(context)],
    "entityFiles": lambda context, info: [_entity_file(context, info)],
    "repository": {"uses": lambda *_: [], "body": body, "helpers": lambda *_: []},
    "unitOfWork": lambda *_: _UNIT,
    "testDatabaseFile": _test_database_file,
    "dependencies": lambda *_: [
        f'mongodb = {{ version = "{_VERSION}", default-features = false, features = ["compat-3-3-0", "bson-3", "rustls-tls", "dns-resolver"] }}',
        f'tokio = {{ version = "{_TOKIO}", features = ["sync"] }}',
    ],
    "readme": {
        "intro": "plain entities, repositories and services with the MongoDB driver",
        "layout": ["src/bson_values.rs       values of documents, and what changed in one"],
        "entities": "one entity per collection",
        "table": "entity, repositories and service of each collection",
        "folder": "The entities of every collection.",
    },
}
