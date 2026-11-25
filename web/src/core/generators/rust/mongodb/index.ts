/**
 * Rust + the official MongoDB driver (Strategy of orm.ts): plain entities with a struct per nested document, which are
 * read from documents and written as them, repositories over Db (the database and the session of its transaction), and
 * tests on a database made empty for each one.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { fileOf, ind, moduleOf, rsFile, type ColumnInfo, type Context, type Crate, type TableInfo } from '../context.ts'
import { identifiedLists, nestedCrates, type NestedField, type NestedStruct } from '../documents.ts'
import type { RustOrm } from '../orm.ts'
import { RsUses, rsString } from '../rust.ts'
import { external, TESTS, unitOfWork } from '../tests.ts'
import { body } from './repository.ts'
import { reads, valueFunctions, writes } from './values.ts'

const VERSION = '3.10.2'
const TOKIO = '1.54.1'
const URL = 'mongodb://localhost:27017/app'

function databaseFile(): GeneratedFile {
  const session = (call: string) => `            Some(session) => ${call}.session(&mut *session.lock().await).await`
  const plain = (call: string) => `            None => ${call}.await`
  return rsFile(
    'src/database.rs',
    [
      'use std::sync::Arc;',
      '',
      'use mongodb::bson::Document;',
      'use mongodb::error::{Error, ErrorKind, WriteFailure};',
      'use mongodb::options::{ReturnDocument, UpdateModifications};',
      'use mongodb::{Client, ClientSession, Collection, Database};',
      'use tokio::sync::Mutex;',
      '',
      'use crate::errors::DomainError;',
    ].join('\n'),
    [
      `pub const DEFAULT_URL: &str = ${rsString(URL)};`,
      '',
      '/// The database DATABASE_URL names (DEFAULT_URL when it is not set). It creates no collection and no index: the',
      '/// database already exists.',
      'pub async fn connect() -> Result<Database, Error> {',
      '    let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| DEFAULT_URL.to_string());',
      '    database_at(&url).await',
      '}',
      '',
      '/// The database a URL names.',
      'pub async fn database_at(url: &str) -> Result<Database, Error> {',
      '    let client = Client::with_uri_str(url).await?;',
      '    client.default_database().ok_or_else(|| Error::custom("the URL names no database"))',
      '}',
      '',
      '/// A database and the session of its transaction, when there is one (MongoDB has them on replica sets only). A refused',
      '/// write is a Conflict.',
      '#[derive(Clone)]',
      'pub struct Db {',
      '    pub database: Database,',
      '    pub session: Option<Arc<Mutex<ClientSession>>>,',
      '}',
      '',
      'impl Db {',
      '    pub fn collection(&self, name: &str) -> Collection<Document> {',
      '        self.database.collection(name)',
      '    }',
      '',
      '    pub async fn find_one(&self, collection: &str, filter: Document) -> Result<Option<Document>, Error> {',
      '        let find = self.collection(collection);',
      '        match &self.session {',
      session('find.find_one(filter)') + ',',
      plain('find.find_one(filter)') + ',',
      '        }',
      '    }',
      '',
      '    /// The documents of a filter, in order; at most `limit` of them when it is not 0.',
      '    pub async fn find(&self, collection: &str, filter: Document, sort: Document, skip: u64, limit: u64) -> Result<Vec<Document>, Error> {',
      '        let source = self.collection(collection);',
      '        let find = source.find(filter).sort(sort).skip(skip).limit(limit as i64);',
      '        let mut found = Vec::new();',
      '        match &self.session {',
      '            Some(session) => {',
      '                let mut session = session.lock().await;',
      '                let mut cursor = find.session(&mut *session).await?;',
      '                while cursor.advance(&mut session).await? {',
      '                    found.push(cursor.deserialize_current()?);',
      '                }',
      '            }',
      '            None => {',
      '                let mut cursor = find.await?;',
      '                while cursor.advance().await? {',
      '                    found.push(cursor.deserialize_current()?);',
      '                }',
      '            }',
      '        }',
      '        Ok(found)',
      '    }',
      '',
      '    pub async fn count(&self, collection: &str, filter: Document) -> Result<u64, Error> {',
      '        let source = self.collection(collection);',
      '        match &self.session {',
      session('source.count_documents(filter)') + ',',
      plain('source.count_documents(filter)') + ',',
      '        }',
      '    }',
      '',
      '    pub async fn insert(&self, entity: &str, collection: &str, document: &Document) -> Result<(), DomainError> {',
      '        let target = self.collection(collection);',
      '        let result = match &self.session {',
      session('target.insert_one(document)') + ',',
      plain('target.insert_one(document)') + ',',
      '        };',
      '        result.map(|_| ()).map_err(|error| refused(entity, error))',
      '    }',
      '',
      '    pub async fn update(&self, entity: &str, collection: &str, filter: Document, change: Document) -> Result<(), DomainError> {',
      '        let target = self.collection(collection);',
      '        let result = match &self.session {',
      session('target.update_one(filter, change)') + ',',
      plain('target.update_one(filter, change)') + ',',
      '        };',
      '        result.map(|_| ()).map_err(|error| refused(entity, error))',
      '    }',
      '',
      '    pub async fn delete(&self, entity: &str, collection: &str, filter: Document) -> Result<(), DomainError> {',
      '        let target = self.collection(collection);',
      '        let result = match &self.session {',
      session('target.delete_one(filter)') + ',',
      plain('target.delete_one(filter)') + ',',
      '        };',
      '        result.map(|_| ()).map_err(|error| refused(entity, error))',
      '    }',
      '',
      '    /// Changes one document where it is, and gives it as it is then; None when there is none.',
      '    pub async fn change(',
      '        &self,',
      '        entity: &str,',
      '        collection: &str,',
      '        filter: Document,',
      '        change: impl Into<UpdateModifications>,',
      '    ) -> Result<Option<Document>, DomainError> {',
      '        let target = self.collection(collection);',
      '        let update = target.find_one_and_update(filter, change).return_document(ReturnDocument::After);',
      '        let result = match &self.session {',
      session('update') + ',',
      plain('update') + ',',
      '        };',
      '        result.map_err(|error| refused(entity, error))',
      '    }',
      '}',
      '',
      '/// A repeated value, or one the validator of the collection does not take, becomes a Conflict.',
      'fn refused(entity: &str, error: Error) -> DomainError {',
      '    let code = match error.kind.as_ref() {',
      '        ErrorKind::Write(WriteFailure::WriteError(refusal)) => refusal.code,',
      '        ErrorKind::Command(refusal) => refusal.code,',
      '        _ => 0,',
      '    };',
      '    if code == 11000 || code == 121 {',
      '        DomainError::conflict(entity, &format!("the database refused the change: {error}"), &[])',
      '    } else {',
      '        error.into()',
      '    }',
      '}',
    ],
    ['The database DATABASE_URL names, through the MongoDB driver. It never migrates: the database already exists.'],
  )
}

/** Every crate the types of the entities come from. */
const cratesInUse = (context: Context): Set<string> =>
  new Set(
    context.tables
      .flatMap((info) => [...info.columns.map((column) => column.crate), ...nestedCrates(info.nested.values())])
      .filter((item) => item !== null),
  )

function valuesFile(context: Context): GeneratedFile {
  const crates = cratesInUse(context)
  const bson = ['Binary', 'Bson', 'Document', ...(crates.has('chrono') ? ['DateTime'] : []), 'oid::ObjectId', 'spec::BinarySubtype']
  return rsFile(
    'src/bson_values.rs',
    [`use mongodb::bson::{${bson.sort().join(', ')}};`, 'use mongodb::error::Error;'].join('\n'),
    [
      '/// The document an entity was read from, or stored as: a change writes only the fields that differ. It is no part of the',
      '/// value of the entity.',
      '#[derive(Debug, Clone, Default)]',
      'pub struct Loaded(pub Option<Document>);',
      '',
      'impl PartialEq for Loaded {',
      '    fn eq(&self, _other: &Self) -> bool {',
      '        true',
      '    }',
      '}',
      '',
      '/// The update that takes a document from what it was to what it is: only the fields that differ, and inside a nested',
      '/// document only its own.',
      'pub fn changes(before: Option<&Document>, now: &Document, fields: &[&str]) -> Document {',
      '    let mut set = Document::new();',
      '    let mut unset = Document::new();',
      '    for field in fields {',
      '        compare(field, before.and_then(|before| before.get(*field)), now.get(*field), &mut set, &mut unset);',
      '    }',
      '    let mut result = Document::new();',
      '    if !set.is_empty() {',
      '        result.insert("$set", set);',
      '    }',
      '    if !unset.is_empty() {',
      '        result.insert("$unset", unset);',
      '    }',
      '    result',
      '}',
      '',
      'fn compare(path: &str, before: Option<&Bson>, now: Option<&Bson>, set: &mut Document, unset: &mut Document) {',
      '    if before == now {',
      '        return;',
      '    }',
      '    match (before, now) {',
      '        (_, None) => {',
      '            unset.insert(path, "");',
      '        }',
      '        (Some(Bson::Document(before)), Some(Bson::Document(now))) => {',
      '            for name in before.keys().chain(now.keys().filter(|name| !before.contains_key(name))) {',
      '                compare(&format!("{path}.{name}"), before.get(name), now.get(name), set, unset);',
      '            }',
      '        }',
      '        (_, Some(value)) => {',
      '            set.insert(path, value.clone());',
      '        }',
      '    }',
      '}',
      '',
      '/// Adds a field of the document to what an update sets.',
      'pub fn also_set(changes: &mut Document, now: &Document, field: &str) {',
      '    let mut set = changes.get_document("$set").cloned().unwrap_or_default();',
      '    set.insert(field, now.get(field).cloned());',
      '    changes.insert("$set", set);',
      '}',
      '',
      '/// Whether a text is an identifier of MongoDB.',
      'pub fn is_object_id(text: &str) -> bool {',
      '    ObjectId::parse_str(text).is_ok()',
      '}',
      '',
      '/// A field of a document, if it has it.',
      'pub fn read<T>(document: &Document, field: &str, from: impl Fn(&Bson) -> Result<T, Error>) -> Result<Option<T>, Error> {',
      '    match document.get(field) {',
      '        None | Some(Bson::Null) => Ok(None),',
      '        Some(value) => from(value).map(Some),',
      '    }',
      '}',
      '',
      '/// Writes a field of a document, if there is a value: what is None is left out.',
      'pub fn write<T>(document: &mut Document, field: &str, value: &Option<T>, to: impl Fn(&T) -> Result<Bson, Error>) -> Result<(), Error> {',
      '    if let Some(value) = value {',
      '        document.insert(field, to(value)?);',
      '    }',
      '    Ok(())',
      '}',
      '',
      '/// Reads a list with the function of its items.',
      'pub fn as_list<T>(from: impl Fn(&Bson) -> Result<T, Error>) -> impl Fn(&Bson) -> Result<Vec<T>, Error> {',
      '    move |value| {',
      '        let items = value.as_array().ok_or_else(|| unexpected(value))?;',
      '        items.iter().filter(|item| **item != Bson::Null).map(&from).collect()',
      '    }',
      '}',
      '',
      '/// Writes a list with the function of its items.',
      'pub fn of_list<T>(to: impl Fn(&T) -> Result<Bson, Error>) -> impl Fn(&Vec<T>) -> Result<Bson, Error> {',
      '    move |items| Ok(Bson::Array(items.iter().map(&to).collect::<Result<_, _>>()?))',
      '}',
      '',
      '/// Reads a nested document with the function of its struct.',
      'pub fn as_nested<T>(from: impl Fn(&Document) -> Result<T, Error>) -> impl Fn(&Bson) -> Result<T, Error> {',
      '    move |value| from(value.as_document().ok_or_else(|| unexpected(value))?)',
      '}',
      '',
      '/// Writes a nested document with the function of its struct.',
      'pub fn of_nested<T>(to: impl Fn(&T) -> Result<Document, Error>) -> impl Fn(&T) -> Result<Bson, Error> {',
      '    move |value| to(value).map(Bson::Document)',
      '}',
      '',
      'fn unexpected(value: &Bson) -> Error {',
      '    Error::custom(format!("a document has a value of another type: {value}"))',
      '}',
      '',
      '/// A whole number, whatever the type it was stored with.',
      'fn whole(value: &Bson) -> Option<i64> {',
      '    match value {',
      '        Bson::Int32(number) => Some(i64::from(*number)),',
      '        Bson::Int64(number) => Some(*number),',
      '        Bson::Double(number) if number.fract() == 0.0 => Some(*number as i64),',
      '        _ => None,',
      '    }',
      '}',
      '',
      '/// A number, whatever the type it was stored with.',
      'fn number(value: &Bson) -> Option<f64> {',
      '    match value {',
      '        Bson::Double(number) => Some(*number),',
      '        Bson::Int32(number) => Some(f64::from(*number)),',
      '        Bson::Int64(number) => Some(*number as f64),',
      '        _ => None,',
      '    }',
      '}',
      '',
      ...(crates.has('rust_decimal')
        ? [
            '/// An exact number, whatever the type it was stored with.',
            'fn decimal(value: &Bson) -> Option<rust_decimal::Decimal> {',
            '    let text = match value {',
            '        Bson::Decimal128(number) => number.to_string(),',
            '        Bson::Int32(number) => number.to_string(),',
            '        Bson::Int64(number) => number.to_string(),',
            '        Bson::Double(number) => number.to_string(),',
            '        _ => return None,',
            '    };',
            '    text.parse().ok().or_else(|| rust_decimal::Decimal::from_scientific(&text).ok())',
            '}',
            '',
          ]
        : []),
      'fn binary(value: &Bson) -> Option<&Vec<u8>> {',
      '    match value {',
      '        Bson::Binary(binary) => Some(&binary.bytes),',
      '        _ => None,',
      '    }',
      '}',
      ...valueFunctions(crates),
    ],
    ['Values between Rust and the documents of MongoDB, and what changed in a document.'],
  )
}

interface Field {
  name: string
  field: string
  column: ColumnInfo['column']
  nested: NestedStruct | null
}

/** The functions that read a struct from a document and write it as one. */
function documentFunctions(name: string, fields: Field[], entity: boolean, identified: ColumnInfo[]): string[] {
  const read = fields.map(
    (item) => `${item.field}: bson_values::read(document, ${rsString(item.name)}, ${reads(item.column.type, item.nested)})?,`,
  )
  return [
    `impl ${name} {`,
    '    /// What a document holds.',
    `    pub fn from_document(${fields.length > 0 || entity ? '' : '_'}document: &Document) -> Result<Self, Error> {`,
    ...(entity
      ? [
          `        let mut entity = ${name} {`,
          ...ind(read, 12),
          '            loaded: Loaded::default(),',
          '        };',
          '        entity.loaded = Loaded(Some(entity.to_document()?));',
          '        Ok(entity)',
        ]
      : [`        Ok(${name} {`, ...ind(read, 12), '        })']),
    '    }',
    '',
    '    /// Its document: what is None is left out.',
    '    pub fn to_document(&self) -> Result<Document, Error> {',
    `        let ${fields.length > 0 ? 'mut ' : ''}document = Document::new();`,
    ...fields.map(
      (item) =>
        `        bson_values::write(&mut document, ${rsString(item.name)}, &self.${item.field}, ${writes(item.column.type, item.nested)})?;`,
    ),
    '        Ok(document)',
    '    }',
    ...(identified.length > 0
      ? [
          '',
          '    /// Gives an identifier to the documents of its lists that have none: MongoDB numbers only whole documents.',
          '    pub fn identify_items(&mut self) {',
          ...identified.flatMap((column) => [
            `        for item in self.${column.field}.iter_mut().flatten() {`,
            '            item.id.get_or_insert_with(|| ObjectId::new().to_hex());',
            '        }',
          ]),
          '    }',
        ]
      : []),
    '}',
  ]
}

const commentLines = (comment: string | undefined) => (comment ? [`    /// ${comment.replace(/\s+/g, ' ')}`] : [])

function nestedBlock(item: NestedStruct): string[] {
  const field = (written: NestedField) => [...commentLines(written.column.comment), `    pub ${written.field}: Option<${written.rs}>,`]
  return [
    '',
    '/// A nested document: it is stored with the one that holds it.',
    '#[derive(Debug, Clone, Default, PartialEq)]',
    item.fields.length > 0 ? `pub struct ${item.name} {` : `pub struct ${item.name} {}`,
    ...item.fields.flatMap(field),
    ...(item.fields.length > 0 ? ['}'] : []),
    '',
    ...documentFunctions(
      item.name,
      item.fields.map((written) => ({ name: written.column.name, field: written.field, column: written.column, nested: written.nested })),
      false,
      [],
    ),
    ...item.structs.flatMap(nestedBlock),
  ]
}

function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const comment = info.table.comment ? `: ${info.table.comment}` : ''
  const identified = identifiedLists(info)
  const uses = new RsUses().add('crate::bson_values', 'crate::bson_values::Loaded', 'mongodb::bson::Document', 'mongodb::error::Error')
  if (identified.length > 0) uses.add('mongodb::bson::oid::ObjectId')
  const module = moduleOf(context, info, 'entity')
  const body = [
    `/// A document of the "${info.name}" collection${comment}. A field stays \`None\` until it is set or read.`,
    '#[derive(Debug, Clone, Default, PartialEq)]',
    `pub struct ${info.entity} {`,
    ...info.columns.flatMap((column) => [...commentLines(column.column.comment), `    pub ${column.field}: Option<${column.rs}>,`]),
    '    /// As it was read: a change writes only what differs',
    '    pub loaded: Loaded,',
    '}',
    '',
    ...documentFunctions(
      info.entity,
      info.columns.map((column) => ({
        name: column.column.name,
        field: column.field,
        column: column.column,
        nested: info.nested.get(column.column.name) ?? null,
      })),
      true,
      identified,
    ),
    ...[...info.nested.values()].flatMap(nestedBlock),
  ]
  // The structs of the module name each other without it
  return rsFile(
    fileOf(module),
    uses.write(),
    body.map((line) => line.replaceAll(`${module}::`, '')),
  )
}

const UNIT = {
  uses: ['mongodb::ClientSession', 'mongodb::Database', 'std::sync::Arc', 'tokio::sync::Mutex'],
  constructors: [
    '    /// The repositories over a database: every write outside a transaction is stored at once.',
    '    pub fn new(database: Database) -> Self {',
    '        Self { db: Db { database, session: None }, joined: false }',
    '    }',
    '',
    '    /// The repositories inside the transaction of a session someone else opened; commit() commits it.',
    '    pub fn in_transaction(database: Database, session: ClientSession) -> Self {',
    '        Self { db: Db { database, session: Some(Arc::new(Mutex::new(session))) }, joined: false }',
    '    }',
  ],
  fields: ['    /// Whether someone else opened the transaction, and commits it', '    joined: bool,'],
  begin: [
    '        // Joins the transaction already open: whoever opened it commits it',
    '        if self.db.session.is_some() {',
    '            return Ok(Box::new(SqlUnitOfWork { db: self.db.clone(), joined: true }));',
    '        }',
    '        let mut session = self.db.database.client().start_session().await?;',
    '        session.start_transaction().await?;',
    '        Ok(Box::new(SqlUnitOfWork::in_transaction(self.db.database.clone(), session)))',
  ],
  commit: [
    '        if let (Some(session), false) = (&self.db.session, self.joined) {',
    '            session.lock().await.commit_transaction().await?;',
    '        }',
    '        Ok(())',
  ],
}

/** The indexes of the collections, for the tests. */
function indexLines(context: Context): string[] {
  return context.tables.flatMap((info) => {
    const nullable = new Set(info.table.columns.filter((column) => column.nullable).map((column) => column.name))
    const index = (item: { name?: string; columns: string[] }, unique: boolean) => {
      const options = [
        ...(item.name ? [`.name(${rsString(item.name)}.to_string())`] : []),
        ...(unique ? ['.unique(true)'] : []),
        ...(unique && item.columns.every((column) => nullable.has(column)) ? ['.sparse(true)'] : []),
      ]
      const keys = `doc! { ${item.columns.map((column) => `${rsString(column)}: 1`).join(', ')} }`
      const given = options.length > 0 ? `.options(IndexOptions::builder()${options.join('')}.build())` : ''
      return [
        `    let index = IndexModel::builder().keys(${keys})${given}.build();`,
        `    database.collection::<Document>(${rsString(info.name)}).create_index(index).await.expect("an index");`,
      ]
    }
    return [...info.table.uniques.flatMap((item) => index(item, true)), ...info.table.indexes.flatMap((item) => index(item, false))]
  })
}

function testDatabaseFile(context: Context): GeneratedFile {
  const indexes = indexLines(context)
  const uses = new RsUses().add(
    'tokio::sync::Mutex',
    'tokio::sync::MutexGuard',
    'mongodb::Database',
    `${unitOfWork(context)}::SqlUnitOfWork`,
    external(context, 'crate::database::database_at'),
  )
  if (indexes.length > 0) uses.add('mongodb::IndexModel', 'mongodb::bson::Document', 'mongodb::bson::doc')
  if (indexes.some((line) => line.includes('IndexOptions'))) uses.add('mongodb::options::IndexOptions')
  return {
    path: `${TESTS}/database.rs`,
    content: [
      '//! The test database: the MongoDB database TEST_DATABASE_URL names, with every collection created empty before every test.',
      '',
      uses.write(),
      '',
      '/// Every test empties the same database: they take turns',
      'static TURN: Mutex<()> = Mutex::const_new(());',
      '',
      '/// The test database.',
      'pub async fn connect() -> Database {',
      '    let url = std::env::var("TEST_DATABASE_URL").expect(',
      '        "The database tests need a disposable MongoDB database (a replica set, for its transactions): set TEST_DATABASE_URL (it is emptied)",',
      '    );',
      '    database_at(&url).await.expect("the test database")',
      '}',
      '',
      '/// The repositories over the test database, with its collections and their indexes created again, and the turn of the',
      '/// test that holds it.',
      "pub async fn open() -> (MutexGuard<'static, ()>, SqlUnitOfWork) {",
      '    let turn = TURN.lock().await;',
      '    let database = connect().await;',
      '    database.drop().await.expect("an empty database");',
      ...context.tables.map((info) => `    database.create_collection(${rsString(info.name)}).await.expect("a collection");`),
      ...indexes,
      '    (turn, SqlUnitOfWork::new(database))',
      '}',
      '',
      '#[tokio::test]',
      'async fn is_the_one_test_database_url_names() {',
      '    let _turn = TURN.lock().await;',
      '    let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");',
      "    let name = url.rsplit('/').next().and_then(|name| name.split('?').next());",
      '    assert_eq!(name, Some(connect().await.name()));',
      '}',
      '',
    ].join('\n'),
  }
}

export const mongodbOrm: RustOrm = {
  id: 'mongorust',
  label: 'the MongoDB driver',
  error: 'mongodb::error::Error',
  documents: true,
  prefix: 'Mongo',
  url: URL,
  emptyList: () => 'Vec::new()',
  databaseFiles: (context) => [databaseFile(), valuesFile(context)],
  entityFiles: (context, info) => [entityFile(context, info)],
  repository: { uses: () => [], body, helpers: () => [] },
  unitOfWork: () => UNIT,
  testDatabaseFile,
  dependencies: (_context, _used: Set<Crate>) => [
    `mongodb = { version = "${VERSION}", default-features = false, features = ["compat-3-3-0", "bson-3", "rustls-tls", "dns-resolver"] }`,
    `tokio = { version = "${TOKIO}", features = ["sync"] }`,
  ],
  readme: {
    intro: 'plain entities, repositories and services with the MongoDB driver',
    layout: ['src/bson_values.rs       values of documents, and what changed in one'],
    entities: 'one entity per collection',
    table: 'entity, repositories and service of each collection',
    folder: 'The entities of every collection.',
  },
}
