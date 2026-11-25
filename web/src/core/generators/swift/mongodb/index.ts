/**
 * Swift + MongoKitten, the MongoDB driver that is maintained (Strategy of orm.ts): plain entities with a struct per nested
 * document, which are read from documents and written as them, repositories over Db (the database, or the transaction of a
 * session), and tests on a database made empty for each one.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import { fileOf, ind, sharedFile, swFile, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import { identifiedLists, type NestedStruct } from '../documents.ts'
import type { SwiftOrm } from '../orm.ts'
import { imports, swString } from '../swift.ts'
import { body } from './repository.ts'
import { reads, writes } from './values.ts'

const VERSION = '7.17.0'
const URL = 'mongodb://localhost:27017/app'

function databaseFile(context: Context): GeneratedFile {
  return swFile(sharedFile(context, 'AppDatabase'), imports('Foundation', 'MongoClient', 'MongoCore', 'MongoKitten'), [
    '/// The database DATABASE_URL names, through MongoKitten. It creates no collection and no index: the database already exists.',
    'public final class AppDatabase: Sendable {',
    `    public static let defaultURL = ${swString(URL)}`,
    '',
    '    /// What the repositories work on.',
    '    public let database: Db',
    '',
    '    /// The database at url (DATABASE_URL, or defaultURL, by default).',
    '    public init(url: String = ProcessInfo.processInfo.environment["DATABASE_URL"] ?? AppDatabase.defaultURL) async throws {',
    '        self.database = Db(mongo: try await MongoDatabase.connect(to: url))',
    '    }',
    '',
    '    /// Closes the connections.',
    '    public func shutdown() async {',
    '        await (database.mongo.pool as? MongoCluster)?.disconnect()',
    '    }',
    '}',
    '',
    '/// What the database answers when it does not do something.',
    'public struct MongoRefusal: Error, CustomStringConvertible {',
    '    public let code: Int',
    '    public let description: String',
    '}',
    '',
    '/// Whether the database refused a write: a unique value taken, or one the validator of the collection does not take.',
    'func isRefusal(_ error: any Error) -> Bool {',
    '    (error as? MongoRefusal).map { [11000, 121].contains($0.code) } ?? false',
    '}',
    '',
    '/// What the repositories work on: the database, or the transaction of a session (MongoDB has them on replica sets only).',
    'public struct Db: Sendable {',
    '    public let mongo: MongoDatabase',
    '',
    '    /// Runs a command, and gives what the database answers.',
    '    @discardableResult',
    '    public func run(_ command: BsonDocument, on connection: MongoConnection? = nil) async throws -> BsonDocument {',
    '        let connection = if let connection { connection } else { try await mongo.pool.next(for: .writable) }',
    '        let reply = try await connection.executeCodable(',
    '            command, decodeAs: BsonDocument.self, namespace: mongo.commandNamespace, in: mongo.activeTransaction,',
    '            sessionId: mongo.sessionId ?? connection.implicitSessionId)',
    '        guard let ok = reply["ok"], try Bson.asDouble(ok) == 1 else { throw refusal(reply) }',
    '        if let errors = reply["writeErrors"] as? BsonDocument, let first = errors["0"] as? BsonDocument { throw refusal(first) }',
    '        return reply',
    '    }',
    '',
    '    private func refusal(_ reply: BsonDocument) -> MongoRefusal {',
    '        let code = try? reply["code"].map(Bson.asInt32)',
    '        return MongoRefusal(code: code ?? 0, description: reply["errmsg"] as? String ?? "the database answered an error")',
    '    }',
    '',
    '    /// The documents of a filter, in order; at most limit of them when it is not 0.',
    '    public func find(',
    '        _ collection: String, _ filter: BsonDocument, sort: BsonDocument? = nil, skip: Int = 0, limit: Int = 0',
    '    ) async throws -> [BsonDocument] {',
    '        var command: BsonDocument = ["find": collection, "filter": filter]',
    '        if let sort { command["sort"] = sort }',
    '        if skip > 0 { command["skip"] = skip }',
    '        if limit > 0 { command["limit"] = limit }',
    '        // The rest of a cursor is read on the connection that opened it',
    '        let connection = try await mongo.pool.next(for: .writable)',
    '        var cursor = try await run(command, on: connection)["cursor"] as? BsonDocument ?? [:]',
    '        var found = documents(cursor["firstBatch"])',
    '        while let id = cursor["id"] as? Int, id != 0 {',
    '            cursor = try await run(["getMore": id, "collection": collection], on: connection)["cursor"] as? BsonDocument ?? [:]',
    '            found += documents(cursor["nextBatch"])',
    '        }',
    '        return found',
    '    }',
    '',
    '    private func documents(_ batch: (any BsonPrimitive)?) -> [BsonDocument] {',
    '        (batch as? BsonDocument ?? [:]).compactMap { $0.1 as? BsonDocument }',
    '    }',
    '',
    '    /// How many documents a filter has; an aggregation, as a count cannot be in a transaction.',
    '    public func count(_ collection: String, _ filter: BsonDocument) async throws -> Int {',
    '        let stages: BsonDocument = [["$match": filter] as BsonDocument, ["$count": "n"] as BsonDocument]',
    '        let reply = try await run(["aggregate": collection, "pipeline": stages, "cursor": [:] as BsonDocument])',
    '        guard let cursor = reply["cursor"] as? BsonDocument, let first = documents(cursor["firstBatch"]).first else { return 0 }',
    '        return try first["n"].map(Bson.asInt64) ?? 0',
    '    }',
    '',
    '    public func insert(_ collection: String, _ document: BsonDocument) async throws {',
    '        try await run(["insert": collection, "documents": [document] as BsonDocument])',
    '    }',
    '',
    '    public func update(_ collection: String, _ filter: BsonDocument, _ change: BsonDocument) async throws {',
    '        let update: BsonDocument = ["q": filter, "u": change]',
    '        try await run(["update": collection, "updates": [update] as BsonDocument])',
    '    }',
    '',
    '    public func delete(_ collection: String, _ filter: BsonDocument) async throws {',
    '        let delete: BsonDocument = ["q": filter, "limit": 1]',
    '        try await run(["delete": collection, "deletes": [delete] as BsonDocument])',
    '    }',
    '',
    '    /// Changes one document where it is, and gives it as it is then; nil when there is none.',
    '    public func change(_ collection: String, _ filter: BsonDocument, _ change: BsonDocument) async throws -> BsonDocument? {',
    '        try await run(["findAndModify": collection, "query": filter, "update": change, "new": true])["value"] as? BsonDocument',
    '    }',
    '',
    '    /// Runs work in a transaction, committed when it ends and undone when it throws; it joins the one already open.',
    '    public func transaction<T: Sendable>(_ work: @escaping @Sendable (Db) async throws -> T) async throws -> T {',
    '        if mongo.isInTransaction { return try await work(self) }',
    '        let session = try await mongo.startTransaction(autoCommitChanges: false)',
    '        do {',
    '            let result = try await work(Db(mongo: session))',
    '            try await session.commit()',
    '            return result',
    '        } catch {',
    '            try? await session.abort()',
    '            throw error',
    '        }',
    '    }',
    '}',
  ])
}

/** The plain values: their name, their Swift type, how they are read (nil when they are of another type) and written. */
const VALUES: [string, string, string, string][] = [
  ['ObjectId', 'String', '(value as? BSON.ObjectId)?.hexString', 'try BSON.ObjectId.make(from: value)'],
  ['Text', 'String', 'value as? String', 'value'],
  ['Bool', 'Bool', 'value as? Bool', 'value'],
  ['Int32', 'Int', 'whole(value)', 'Int32(value)'],
  ['Int64', 'Int', 'whole(value)', 'value'],
  ['Float', 'Float', 'number(value).map(Float.init)', 'Double(value)'],
  ['Double', 'Double', 'number(value)', 'value'],
  ['Decimal', 'Decimal', 'decimal(value)', 'try decimal128(value)'],
  ['Date', 'Date', 'value as? Date', ''],
  ['UUID', 'UUID', 'uuid(value)', 'BSON.Binary(subType: .uuid, buffer: ByteBuffer(bytes: withUnsafeBytes(of: value.uuid) { Array($0) }))'],
  ['Data', 'Data', '(value as? BSON.Binary)?.data', 'BSON.Binary(buffer: ByteBuffer(bytes: value))'],
  ['Any', 'BsonValue', 'BsonValue(value)', 'value.value'],
]

function bsonFile(context: Context): GeneratedFile {
  return swFile(sharedFile(context, 'Bson'), imports('Foundation', 'MongoKitten'), [
    'public typealias BsonDocument = BSON.Document',
    'public typealias BsonPrimitive = BSON.Primitive',
    '',
    '/// A value nothing says the shape of, as the document has it.',
    'public struct BsonValue: Sendable, Equatable {',
    '    public let value: any BsonPrimitive',
    '',
    '    public init(_ value: any BsonPrimitive) {',
    '        self.value = value',
    '    }',
    '',
    '    public static func == (lhs: BsonValue, rhs: BsonValue) -> Bool {',
    '        lhs.value.equals(rhs.value)',
    '    }',
    '}',
    '',
    '/// The document an entity was read from, or stored as: a change writes only the fields that differ. It is no part of the',
    '/// value of the entity.',
    'struct Loaded: Sendable, Equatable {',
    '    var document: BsonDocument?',
    '',
    '    static func == (lhs: Loaded, rhs: Loaded) -> Bool { true }',
    '}',
    '',
    '/// What is read from a document and written as one.',
    'protocol DocumentValue {',
    '    static func from(_ document: BsonDocument) throws -> Self',
    '    func toDocument() throws -> BsonDocument',
    '}',
    '',
    '/// A document has a value of another type, or a value cannot be stored.',
    'struct BsonError: Error, CustomStringConvertible {',
    '    let description: String',
    '}',
    '',
    '/// Values between Swift and the documents of MongoDB, and what changed in a document.',
    'enum Bson {',
    '    static var null: any BsonPrimitive { BSON.Null() }',
    '',
    '    static func newId() -> String { BSON.ObjectId().hexString }',
    '',
    '    /// Whether a text is an identifier of MongoDB.',
    '    static func isObjectId(_ text: String) -> Bool { BSON.ObjectId(text) != nil }',
    '',
    '    /// The update that takes a document from what it was to what it is: only the fields that differ, and inside a nested',
    '    /// document only its own.',
    '    static func changes(_ before: BsonDocument?, _ now: BsonDocument, _ fields: [String]) -> BsonDocument {',
    '        var set: BsonDocument = [:]',
    '        var unset: BsonDocument = [:]',
    '        for field in fields { compare(field, before?[field], now[field], &set, &unset) }',
    '        var result: BsonDocument = [:]',
    '        if !set.isEmpty { result["$set"] = set }',
    '        if !unset.isEmpty { result["$unset"] = unset }',
    '        return result',
    '    }',
    '',
    '    private static func compare(',
    '        _ path: String, _ before: (any BsonPrimitive)?, _ now: (any BsonPrimitive)?, _ set: inout BsonDocument, _ unset: inout BsonDocument',
    '    ) {',
    '        guard let now else {',
    '            if before != nil { unset[path] = "" }',
    '            return',
    '        }',
    '        guard let before else {',
    '            set[path] = now',
    '            return',
    '        }',
    '        if before.equals(now) { return }',
    '        if let old = before as? BsonDocument, let new = now as? BsonDocument, !old.isArray, !new.isArray {',
    '            for name in Set(old.keys).union(new.keys).sorted() { compare("\\(path).\\(name)", old[name], new[name], &set, &unset) }',
    '        } else {',
    '            set[path] = now',
    '        }',
    '    }',
    '',
    '    /// An update that also sets some fields of the document.',
    '    static func alsoSet(_ changes: BsonDocument, _ now: BsonDocument, _ fields: [String]) -> BsonDocument {',
    '        var result = changes',
    '        var set = changes["$set"] as? BsonDocument ?? [:]',
    '        for field in fields { set[field] = now[field] }',
    '        result["$set"] = set',
    '        return result',
    '    }',
    '',
    '    /// A field of a document, if it has it.',
    '    static func read<T>(_ document: BsonDocument, _ field: String, _ from: (any BsonPrimitive) throws -> T) throws -> T? {',
    '        guard let value = document[field], !(value is BSON.Null) else { return nil }',
    '        return try from(value)',
    '    }',
    '',
    '    /// Writes a field of a document, if there is a value: what is nil is left out.',
    '    static func write<T>(_ document: inout BsonDocument, _ field: String, _ value: T?, _ to: (T) throws -> any BsonPrimitive) throws {',
    '        if let value { document[field] = try to(value) }',
    '    }',
    '',
    '    /// Reads a list with the function of its items.',
    '    static func asList<T>(_ from: @escaping (any BsonPrimitive) throws -> T) -> (any BsonPrimitive) throws -> [T] {',
    '        { value in',
    '            guard let items = value as? BsonDocument, items.isArray else { throw unexpected(value) }',
    '            return try items.compactMap { $0.1 is BSON.Null ? nil : try from($0.1) }',
    '        }',
    '    }',
    '',
    '    /// Writes a list with the function of its items.',
    '    static func ofList<T>(_ to: @escaping (T) throws -> any BsonPrimitive) -> ([T]) throws -> any BsonPrimitive {',
    '        { items in',
    '            var document = BsonDocument(isArray: true)',
    '            for item in items { document.append(try to(item)) }',
    '            return document',
    '        }',
    '    }',
    '',
    '    /// Reads a nested document as its struct.',
    '    static func asNested<T: DocumentValue>(_ type: T.Type) -> (any BsonPrimitive) throws -> T {',
    '        { value in',
    '            guard let document = value as? BsonDocument, !document.isArray else { throw unexpected(value) }',
    '            return try T.from(document)',
    '        }',
    '    }',
    '',
    '    /// Writes a struct as a nested document.',
    '    static func ofNested<T: DocumentValue>(_ value: T) throws -> any BsonPrimitive { try value.toDocument() }',
    ...VALUES.flatMap(([name, type, read, write]) => [
      '',
      ...(name === 'Any'
        ? [`    static func asAny(_ value: any BsonPrimitive) throws -> ${type} { ${read} }`]
        : [
            `    static func as${name}(_ value: any BsonPrimitive) throws -> ${type} {`,
            `        guard let read = ${read} else { throw unexpected(value) }`,
            '        return read',
            '    }',
          ]),
      '',
      ...(name === 'Date' ? ['    /// The driver cuts a moment to its millisecond: half of one more keeps it.'] : []),
      ...(name === 'Date'
        ? [
            '    static func ofDate(_ value: Date) throws -> any BsonPrimitive {',
            '        let millis = (value.timeIntervalSince1970 * 1000).rounded()',
            '        return Date(timeIntervalSince1970: (millis + (millis < 0 ? -0.5 : 0.5)) / 1000)',
            '    }',
          ]
        : [`    static func of${name}(_ value: ${type}) throws -> any BsonPrimitive { ${write} }`]),
    ]),
    '',
    '    private static func unexpected(_ value: any BsonPrimitive) -> BsonError {',
    '        BsonError(description: "a document has a value of another type: \\(value)")',
    '    }',
    '',
    '    /// A whole number, whatever the type it was stored with.',
    '    private static func whole(_ value: any BsonPrimitive) -> Int? {',
    '        switch value {',
    '        case let number as Int32: Int(number)',
    '        case let number as Int: number',
    '        case let number as Double: Int(exactly: number)',
    '        default: nil',
    '        }',
    '    }',
    '',
    '    /// A number, whatever the type it was stored with.',
    '    private static func number(_ value: any BsonPrimitive) -> Double? {',
    '        switch value {',
    '        case let number as Double: number',
    '        case let number as Int32: Double(number)',
    '        case let number as Int: Double(number)',
    '        default: nil',
    '        }',
    '    }',
    '',
    '    private static func uuid(_ value: any BsonPrimitive) -> UUID? {',
    '        guard let bytes = (value as? BSON.Binary)?.data, bytes.count == 16 else { return nil }',
    '        return bytes.withUnsafeBytes { UUID(uuid: $0.loadUnaligned(as: uuid_t.self)) }',
    '    }',
    '',
    '    private static let tenTo19: UInt64 = 10_000_000_000_000_000_000',
    '',
    '    /// An exact number, whatever the type it was stored with. The driver keeps a Decimal128 as it is: its 16 bytes are read here.',
    '    private static func decimal(_ value: any BsonPrimitive) -> Decimal? {',
    '        if let whole = whole(value) { return Decimal(whole) }',
    '        if let number = value as? Double { return Decimal(string: "\\(number)") }',
    '        guard value is BSON.Decimal128 else { return nil }',
    '        let bytes = [UInt8]((["v": value] as BsonDocument).makeData())[7..<23]',
    '        let low = bytes.prefix(8).reversed().reduce(UInt64(0)) { $0 << 8 | UInt64($1) }',
    '        let high = bytes.suffix(8).reversed().reduce(UInt64(0)) { $0 << 8 | UInt64($1) }',
    '        // An infinity, or not a number',
    '        if high >> 59 & 0b1111 == 0b1111 { return nil }',
    '        let exponent = Int(high >> 49 & 0x3fff) - 6176',
    '        let (quotient, rest) = tenTo19.dividingFullWidth((high & 0x1_ffff_ffff_ffff, low))',
    '        guard let digits = Decimal(string: "\\(quotient)" + String(repeating: "0", count: 19 - "\\(rest)".count) + "\\(rest)") else { return nil }',
    '        return Decimal(sign: high >> 63 == 1 ? .minus : .plus, exponent: exponent, significand: digits)',
    '    }',
    '',
    '    /// A number as a Decimal128, which has 34 digits.',
    '    private static func decimal128(_ value: Decimal) throws -> any BsonPrimitive {',
    '        let text = "\\(value.magnitude)"',
    '        let parts = text.split(separator: ".", omittingEmptySubsequences: false)',
    '        let digits = parts.joined().drop { $0 == "0" }',
    '        let decimals = parts.count > 1 ? parts[1].count : 0',
    '        guard digits.count <= 34, let upper = UInt64("0" + digits.dropLast(19)), let lower = UInt64("0" + digits.suffix(19)) else {',
    '            throw BsonError(description: "a Decimal128 has 34 digits: \\(value)")',
    '        }',
    '        let product = upper.multipliedFullWidth(by: tenTo19)',
    '        let (low, carry) = product.low.addingReportingOverflow(lower)',
    '        let sign: UInt64 = value < 0 ? 1 : 0',
    '        let high = sign << 63 | UInt64(6176 - decimals) << 49 | product.high + (carry ? 1 : 0)',
    '        let bytes = [low, high].flatMap { word in (0..<8).map { UInt8(truncatingIfNeeded: word >> UInt64(8 * $0)) } }',
    '        guard let stored = BsonDocument(bytes: [24, 0, 0, 0, 0x13, 0x76, 0] + bytes + [0])["v"] else {',
    '            throw BsonError(description: "a Decimal128 that is not valid: \\(value)")',
    '        }',
    '        return stored',
    '    }',
    '}',
  ])
}

interface Field {
  name: string
  prop: string
  key: string
  sw: string
  column: ColumnInfo['column']
  nested: NestedStruct | null
}

const propertyLines = (fields: Field[]) =>
  fields.flatMap((field) => [
    ...(field.column.comment ? [`    /// ${field.column.comment.replace(/\s+/g, ' ')}`] : []),
    `    public var ${field.prop}: ${field.sw}?`,
  ])

const initializerLines = (fields: Field[]) => [
  `    public init(${fields.map((field) => `${field.key}: ${field.sw}? = nil`).join(', ')}) {`,
  ...fields.map((field) => `        self.${field.prop} = ${field.prop}`),
  '    }',
]

/** How a struct is read from a document and written as one. */
function documentExtension(path: string, fields: Field[], entity: boolean): string[] {
  return [
    '',
    `extension ${path}: DocumentValue {`,
    '    /// What a document holds.',
    `    static func from(_ document: BsonDocument) throws -> ${path} {`,
    `        ${entity ? 'var entity =' : 'return'} ${path}(`,
    ...fields.map(
      (field, index) =>
        `            ${field.key}: try Bson.read(document, ${swString(field.name)}, ${reads(field.column.type, field.nested)})${index === fields.length - 1 ? ')' : ','}`,
    ),
    ...(fields.length === 0 ? ['        )'] : []),
    ...(entity ? ['        entity.loadedDocument = Loaded(document: try entity.toDocument())', '        return entity'] : []),
    '    }',
    '',
    '    /// Its document: what is nil is left out.',
    '    func toDocument() throws -> BsonDocument {',
    `        ${fields.length > 0 ? 'var' : 'let'} document: BsonDocument = [:]`,
    ...fields.map(
      (field) =>
        `        try Bson.write(&document, ${swString(field.name)}, self.${field.prop}, ${writes(field.column.type, field.nested)})`,
    ),
    '        return document',
    '    }',
    '}',
  ]
}

const nestedFieldsOf = (item: NestedStruct): Field[] => item.fields.map((field) => ({ ...field, name: field.column.name }))

function nestedBlock(item: NestedStruct): string[] {
  const fields = nestedFieldsOf(item)
  return [
    '/// A nested document: it is stored with the one that holds it.',
    `public struct ${item.name}: Sendable, Equatable {`,
    ...propertyLines(fields),
    ...(fields.length > 0 ? [''] : []),
    ...initializerLines(fields),
    ...item.structs.flatMap((inner) => ['', ...ind(nestedBlock(inner))]),
    '}',
  ]
}

const nestedExtensions = (item: NestedStruct): string[] => [
  ...documentExtension(item.path, nestedFieldsOf(item), false),
  ...item.structs.flatMap(nestedExtensions),
]

function entityFile(context: Context, info: TableInfo): GeneratedFile {
  const comment = info.table.comment ? `: ${info.table.comment}` : ''
  const identified = identifiedLists(info)
  const fields = info.columns.map((column): Field => ({
    name: column.column.name,
    prop: column.prop,
    key: column.key,
    sw: column.sw,
    column: column.column,
    nested: info.nested.get(column.column.name) ?? null,
  }))
  return swFile(fileOf(context, info, 'entity', info.entity), imports('Foundation', 'MongoKitten'), [
    `/// A document of the "${info.name}" collection${comment}. A property stays nil until it is set or read.`,
    `public struct ${info.entity}: Sendable, Equatable {`,
    ...propertyLines(fields),
    '    /// As it was read: a change writes only what differs',
    '    var loadedDocument = Loaded()',
    '',
    ...initializerLines(fields),
    ...(identified.length > 0
      ? [
          '',
          '    /// Gives an identifier to the documents of its lists that have none: MongoDB numbers only whole documents.',
          '    mutating func identifyItems() {',
          ...identified.map(
            (column) =>
              `        ${column.prop} = ${column.prop}?.map { item in var item = item; item.id = item.id ?? Bson.newId(); return item }`,
          ),
          '    }',
        ]
      : []),
    ...[...info.nested.values()].flatMap((item) => ['', ...ind(nestedBlock(item))]),
    '}',
    ...documentExtension(info.entity, fields, true),
    ...[...info.nested.values()].flatMap(nestedExtensions),
  ])
}

/** The commands that create the collections and their indexes, for the tests. */
function createLines(context: Context): string[] {
  return context.tables.flatMap((info) => {
    const nullable = new Set(info.table.columns.filter((column) => column.nullable).map((column) => column.name))
    const index = (item: { name?: string; columns: string[] }, unique: boolean) => {
      const keys = `[${item.columns.map((column) => `${swString(column)}: 1`).join(', ')}] as BsonDocument`
      const parts = [
        `"key": ${keys}`,
        `"name": ${swString(item.name ?? item.columns.map((column) => `${column}_1`).join('_'))}`,
        ...(unique ? ['"unique": true'] : []),
        ...(unique && item.columns.every((column) => nullable.has(column)) ? ['"sparse": true'] : []),
      ]
      return `[${parts.join(', ')}] as BsonDocument`
    }
    const indexes = [...info.table.uniques.map((item) => index(item, true)), ...info.table.indexes.map((item) => index(item, false))]
    const name = swString(info.name)
    return [
      `        try await db.run(["create": ${name}])`,
      ...indexes.map((item) => `        try await db.run(["createIndexes": ${name}, "indexes": [${item}] as BsonDocument])`),
    ]
  })
}

function testDatabase(context: Context) {
  return {
    modules: ['MongoKitten'],
    open: [
      '        let url = try #require(',
      '            ProcessInfo.processInfo.environment["TEST_DATABASE_URL"],',
      '            "The database tests need a disposable MongoDB database (a replica set, for its transactions): set TEST_DATABASE_URL (it is emptied)")',
      '        let app = try await AppDatabase(url: url)',
    ],
    recreate: [
      '    /// Drops the database and creates its collections and their indexes again.',
      '    private static func recreate(_ db: Db) async throws {',
      '        try await db.run(["dropDatabase": 1])',
      ...createLines(context),
      '    }',
    ],
    check: '',
    name: 'uow.db.mongo.name',
  }
}

export const mongodbOrm: SwiftOrm = {
  id: 'mongoswift',
  label: 'MongoKitten',
  documents: true,
  prefix: 'Mongo',
  url: URL,
  holder: { type: 'Db', optional: 'Db?', modules: [] },
  emptyList: () => '[]',
  databaseFiles: (context) => [databaseFile(context), bsonFile(context)],
  entityFiles: (context, info) => [entityFile(context, info)],
  repository: {
    modules: () => ['MongoKitten'],
    body,
    refusal: 'let error where isRefusal(error)',
    functions: () => [],
  },
  transaction: 'try await db.transaction { transaction in try await work(SqlUnitOfWork(db: transaction)) }',
  testDatabase,
  packages: () => ({
    packages: [`.package(url: "https://github.com/orlandos-nl/MongoKitten.git", from: "${VERSION}"),`],
    products: ['MongoKitten', 'MongoClient', 'MongoCore'].map((name) => `.product(name: "${name}", package: "MongoKitten")`),
    testProducts: ['.product(name: "MongoKitten", package: "MongoKitten")'],
  }),
  readme: {
    intro: 'plain entities, repositories and services with MongoKitten',
    layout: ['Bson.swift          values of documents, and what changed in one'],
    entities: 'one entity per collection',
    table: 'entity, repositories and service of each collection',
  },
}
