/**
 * Kotlin + the official MongoDB driver (Strategy of orm.ts): plain entities with a data class per nested document,
 * repositories over Db (the database and the session of its transaction), and tests on a database made empty for each
 * one.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { errorsPackage, ktFile, packageOf, pathOf, qualified, type Context, type TableInfo } from '../context.ts'
import { identifiedLists, nestedImports, type NestedClass } from '../documents.ts'
import { KtImports, ktString } from '../kotlin.ts'
import type { KotlinOrm } from '../orm.ts'
import { testPath } from '../tests.ts'
import { body, head, helpers } from './repository.ts'

const VERSION = '5.15.0'
const URL = 'mongodb://localhost:27017/app'

function databaseFile(context: Context): GeneratedFile {
  const pkg = context.base
  const imports = new KtImports(pkg).add(
    'com.mongodb.ConnectionString',
    'com.mongodb.MongoClientSettings',
    'com.mongodb.kotlin.client.MongoClient',
    'org.bson.UuidRepresentation',
  )
  return ktFile(pathOf(pkg, 'AppDatabase'), pkg, imports.write(), [
    '/** The MongoDB database DATABASE_URL names. It creates no collection and no index: the database already exists. */',
    'object AppDatabase {',
    `    const val DEFAULT_URL = ${ktString(URL)}`,
    '',
    '    /** One client for the whole application: it keeps the connections. */',
    '    private val shared by lazy { client(url()) }',
    '',
    '    /** The URL of DATABASE_URL, or the default one. */',
    '    fun url(): String = System.getenv("DATABASE_URL") ?: DEFAULT_URL',
    '',
    '    /** The name of the database a URL names. */',
    '    fun name(url: String): String = checkNotNull(ConnectionString(url).database) { "The URL names no database" }',
    '',
    '    /** A client for the server at url, which keeps UUIDs as the standard says. */',
    '    fun client(url: String): MongoClient =',
    '        MongoClient.create(',
    '            MongoClientSettings.builder()',
    '                .applyConnectionString(ConnectionString(url))',
    '                .uuidRepresentation(UuidRepresentation.STANDARD)',
    '                .build(),',
    '        )',
    '',
    '    /** A Db over DATABASE_URL, one per unit of work; close it when done. */',
    '    fun open(): Db = Db(shared, name(url()))',
    '}',
  ])
}

function dbFile(context: Context): GeneratedFile {
  const pkg = context.base
  const imports = new KtImports(pkg).add(
    'com.mongodb.MongoException',
    'com.mongodb.client.model.FindOneAndUpdateOptions',
    'com.mongodb.client.model.ReturnDocument',
    'com.mongodb.kotlin.client.ClientSession',
    'com.mongodb.kotlin.client.MongoClient',
    'org.bson.Document',
    qualified(errorsPackage(context), 'ConflictException'),
  )
  return ktFile(pathOf(pkg, 'Db'), pkg, imports.write(), [
    '/** A database and the session of its transaction, when there is one (MongoDB has them on replica sets only). A refused write is a ConflictException. */',
    'class Db(private val client: MongoClient, name: String) : AutoCloseable {',
    '    val database = client.getDatabase(name)',
    '',
    '    private var session: ClientSession? = null',
    '',
    '    val inTransaction: Boolean get() = session != null',
    '',
    '    fun begin() {',
    '        session = client.startSession().also { it.startTransaction() }',
    '    }',
    '',
    '    fun commit() {',
    '        session?.commitTransaction()',
    '        end()',
    '    }',
    '',
    '    fun rollback() {',
    '        session?.let { if (it.hasActiveTransaction) it.abortTransaction() }',
    '        end()',
    '    }',
    '',
    '    override fun close() = rollback()',
    '',
    '    private fun end() {',
    '        session?.close()',
    '        session = null',
    '    }',
    '',
    '    fun collection(name: String) = database.getCollection<Document>(name)',
    '',
    '    fun find(collection: String, filter: Document, sort: Document? = null, skip: Int = 0, limit: Int = 0): List<Document> {',
    '        val found = session?.let { collection(collection).find(it, filter) } ?: collection(collection).find(filter)',
    '        return found.sort(sort).skip(skip).limit(limit).toList()',
    '    }',
    '',
    '    fun count(collection: String, filter: Document): Long =',
    '        session?.let { collection(collection).countDocuments(it, filter) } ?: collection(collection).countDocuments(filter)',
    '',
    '    fun insert(entity: String, collection: String, document: Document) {',
    '        write(entity) { session?.let { collection(collection).insertOne(it, document) } ?: collection(collection).insertOne(document) }',
    '    }',
    '',
    '    fun update(entity: String, collection: String, filter: Document, change: Document) {',
    '        write(entity) { session?.let { collection(collection).updateOne(it, filter, change) } ?: collection(collection).updateOne(filter, change) }',
    '    }',
    '',
    '    fun delete(entity: String, collection: String, filter: Document) {',
    '        write(entity) { session?.let { collection(collection).deleteOne(it, filter) } ?: collection(collection).deleteOne(filter) }',
    '    }',
    '',
    '    /** Changes one document where it is, and gives it as it is then; null when there is none. */',
    '    fun change(entity: String, collection: String, filter: Document, change: Document): Document? =',
    '        write(entity) {',
    '            val session = session',
    '            if (session == null) collection(collection).findOneAndUpdate(filter, change, AFTER)',
    '            else collection(collection).findOneAndUpdate(session, filter, change, AFTER)',
    '        }',
    '',
    '    /** The same, with the stages of a pipeline. */',
    '    fun rewrite(entity: String, collection: String, filter: Document, stages: List<Document>): Document? =',
    '        write(entity) {',
    '            val session = session',
    '            if (session == null) collection(collection).findOneAndUpdate(filter, stages, AFTER)',
    '            else collection(collection).findOneAndUpdate(session, filter, stages, AFTER)',
    '        }',
    '',
    '    /** A repeated value, or one the validator of the collection does not take, as a domain error. */',
    '    private fun <T> write(entity: String, work: () -> T): T =',
    '        try {',
    '            work()',
    '        } catch (error: MongoException) {',
    '            if (error.code != 11000 && error.code != 121) throw error',
    '            throw ConflictException(entity, "the database refused the change: ${error.message}")',
    '        }',
    '',
    '    private companion object {',
    '        val AFTER: FindOneAndUpdateOptions = FindOneAndUpdateOptions().returnDocument(ReturnDocument.AFTER)',
    '    }',
    '}',
  ])
}

function documentsFile(context: Context): GeneratedFile {
  const pkg = context.base
  const imports = new KtImports(pkg).add(
    'java.math.BigDecimal',
    'java.util.Objects',
    'org.bson.Document',
    'org.bson.types.Binary',
    'org.bson.types.Decimal128',
  )
  return ktFile(pathOf(pkg, 'Documents'), pkg, imports.write(), [
    '/** Values of documents, and what changed in one. */',
    'object Documents {',
    '    /** An exact number of a document, whatever the type it was stored with. */',
    '    fun decimal(value: Any?): BigDecimal? =',
    '        when (value) {',
    '            null -> null',
    '            is Decimal128 -> value.bigDecimalValue()',
    '            else -> BigDecimal(value.toString())',
    '        }',
    '',
    '    /** The update that takes a document from what it was to what it is: only the fields that differ, and inside a nested document only its own. */',
    '    fun changes(before: Document?, now: Document, fields: List<String>): Document {',
    '        val set = Document()',
    '        val unset = Document()',
    '        for (field in fields) compare("", field, before?.get(field), now[field], set, unset)',
    '        val result = Document()',
    '        if (set.isNotEmpty()) result["\\$set"] = set',
    '        if (unset.isNotEmpty()) result["\\$unset"] = unset',
    '        return result',
    '    }',
    '',
    '    /** A copy of a value of a document, which stays as it is when the value changes. */',
    '    fun copy(value: Any?): Any? =',
    '        when (value) {',
    '            is Map<*, *> -> Document().also { document -> value.forEach { (name, item) -> document[name.toString()] = copy(item) } }',
    '            is List<*> -> value.map { copy(it) }',
    '            is Binary -> Binary(value.type, value.data.copyOf())',
    '            else -> value',
    '        }',
    '',
    '    private fun compare(path: String, field: String, before: Any?, now: Any?, set: Document, unset: Document) {',
    '        val name = path + field',
    '        if (Objects.deepEquals(before, now)) return',
    '        if (now == null) unset[name] = ""',
    '        else if (before is Document && now is Document)',
    '            (before.keys + now.keys).forEach { compare("$name.", it, before[it], now[it], set, unset) }',
    '        else set[name] = now',
    '    }',
    '}',
  ])
}

/** The parameters of a class: every property is null until it is set or read. */
const parameters = (fields: { prop: string; kt: string; comment?: string }[]): string[] =>
  fields.flatMap((field) => [
    ...(field.comment ? [`    /** ${field.comment.replace(/\*\//g, '* /').replace(/\s+/g, ' ')} */`] : []),
    `    var ${field.prop}: ${field.kt}? = null,`,
  ])

const indented = (items: string[]): string[] => items.map((line) => (line === '' ? '' : `    ${line}`))

function nestedBlock(item: NestedClass): string[] {
  const head = [
    '/** A nested document: it is stored with the one that holds it. */',
    `data class ${item.name}(`,
    ...parameters(item.fields.map((field) => ({ prop: field.prop, kt: field.kt, comment: field.column.comment }))),
  ]
  if (item.fields.length === 0) return [head[0], `class ${item.name}`]
  if (item.classes.length === 0) return [...head, ')']
  return [...head, ') {', ...indented(item.classes.flatMap((inner, index) => [...(index > 0 ? [''] : []), ...nestedBlock(inner)])), '}']
}

function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const pkg = packageOf(context, info, 'entity')
  const imports = new KtImports(pkg).add(...nestedImports(info.nested.values()))
  for (const column of info.columns) if (column.ktImport) imports.add(column.ktImport)
  const lists = identifiedLists(info)
  if (lists.length > 0) imports.add('org.bson.types.ObjectId')
  const members = [
    ...(lists.length > 0
      ? [
          '/** Gives an identifier to the documents of its lists that have none: MongoDB numbers only whole documents. */',
          'fun identifyItems() {',
          ...lists.map((column) => `    ${column.prop}?.forEach { it.id = it.id ?: ObjectId().toHexString() }`),
          '}',
          '',
        ]
      : []),
    ...[...info.nested.values()].flatMap((item) => [...nestedBlock(item), '']),
  ].slice(0, -1)
  return ktFile(pathOf(pkg, info.entity), pkg, imports.write(), [
    `/** A document of the "${info.name}" collection; a property stays null until it is set or read. */`,
    `class ${info.entity}(`,
    ...parameters(info.columns.map((column) => ({ prop: column.prop, kt: column.kt, comment: column.column.comment }))),
    ...(members.length > 0 ? [') {', ...indented(members), '}'] : [')']),
  ])
}

const TRANSACTION = [
  '    override fun <T> transaction(work: (UnitOfWork) -> T): T {',
  '        // Joins the transaction already open',
  '        if (db.inTransaction) return work(this)',
  '        db.begin()',
  '        try {',
  '            val result = work(this)',
  '            db.commit()',
  '            return result',
  '        } catch (error: Throwable) {',
  '            db.rollback()',
  '            throw error',
  '        }',
  '    }',
]

/** An index of a collection, for the tests. */
function indexLines(context: Context): string[] {
  return context.tables.flatMap((info) => {
    const nullable = new Set(info.table.columns.filter((column) => column.nullable).map((column) => column.name))
    const index = (item: { name?: string; columns: string[] }, unique: boolean) => {
      const options = [
        ...(item.name ? [`.name(${ktString(item.name)})`] : []),
        ...(unique ? ['.unique(true)'] : []),
        ...(unique && item.columns.every((column) => nullable.has(column)) ? ['.sparse(true)'] : []),
      ]
      const [first, ...others] = item.columns
      const keys = `Document(${ktString(first)}, 1)${others.map((column) => `.append(${ktString(column)}, 1)`).join('')}`
      return `        db.collection(${ktString(info.name)}).createIndex(${keys}${options.length > 0 ? `, IndexOptions()${options.join('')}` : ''})`
    }
    return [...info.table.uniques.map((item) => index(item, true)), ...info.table.indexes.map((item) => index(item, false))]
  })
}

function testDatabaseFiles(context: Context): GeneratedFile[] {
  const indexes = indexLines(context)
  const imports = new KtImports(context.base)
  if (indexes.length > 0) imports.add('org.bson.Document')
  if (indexes.some((line) => line.includes('IndexOptions()'))) imports.add('com.mongodb.client.model.IndexOptions')
  return [
    ktFile(testPath(context, 'TestDatabase'), context.base, imports.write(), [
      '/** The test database: the MongoDB database TEST_DATABASE_URL names, with every collection created empty before every test. */',
      'object TestDatabase {',
      '    val url: String by lazy {',
      '        checkNotNull(System.getenv("TEST_DATABASE_URL")) {',
      '            "The database tests need a disposable MongoDB database (a replica set, for its transactions): set TEST_DATABASE_URL (it is emptied)"',
      '        }',
      '    }',
      '',
      '    val client by lazy { AppDatabase.client(url) }',
      '',
      '    /** The repositories over the test database, with its collections and their indexes created again. */',
      '    fun open(): SqlUnitOfWork {',
      '        val db = Db(client, AppDatabase.name(url))',
      '        db.database.drop()',
      ...context.tables.map((info) => `        db.database.createCollection(${ktString(info.name)})`),
      ...indexes,
      '        return SqlUnitOfWork(db)',
      '    }',
      '}',
    ]),
    ktFile(
      testPath(context, 'DatabaseTest'),
      context.base,
      new KtImports(context.base).add('kotlin.test.Test', 'kotlin.test.assertEquals').write(),
      [
        '/** The tests run on the database they were asked to. */',
        'class DatabaseTest {',
        '    @Test',
        '    fun isTheOneTestDatabaseUrlNames() {',
        '        assertEquals(AppDatabase.name(TestDatabase.url), TestDatabase.open().db.database.name)',
        '    }',
        '}',
      ],
    ),
  ]
}

export const mongodbOrm: KotlinOrm = {
  id: 'mongokotlin',
  documents: true,
  prefix: 'Mongo',
  url: URL,
  holder: { name: 'db', type: 'Db', ktImport: 'app.Db', text: 'Db' },
  emptyList: () => 'emptyList()',
  databaseFiles: (context) => [databaseFile(context), dbFile(context), documentsFile(context)],
  entityFiles: (context, info) => [entityFile(context, info)],
  repository: {
    imports: () => [],
    doc: (context) =>
      context.settings.transactions === 'repository'
        ? 'through the MongoDB driver. Every write is stored at once.'
        : 'through the MongoDB driver. It runs in the transaction already open, when there is one.',
    head,
    kept: (context) => (context.settings.repositoryInterfaces ? 'db' : 'held'),
    body,
    helpers,
  },
  transaction: () => TRANSACTION,
  testDatabaseFiles,
  openTest: (context) =>
    context.settings.transactions === 'caller'
      ? ['// The caller owns the transaction: the test opens it, and it ends with the test', 'uow.db.begin()']
      : [],
  closeTest: ['uow.db.close()'],
  dependencies: () => [`    implementation("org.mongodb:mongodb-driver-kotlin-sync:${VERSION}")`],
  readme: {
    intro: 'plain entities, repositories and services with the MongoDB driver',
    layout: [
      'src/main/kotlin/app/AppDatabase.kt      opens the database DATABASE_URL names',
      'src/main/kotlin/app/Db.kt               a database and the session of its transaction',
      'src/main/kotlin/app/Documents.kt        values of documents, and what changed in one',
    ],
    entities: 'one entity per collection',
    table: 'entity, repositories and service of each collection',
  },
}
