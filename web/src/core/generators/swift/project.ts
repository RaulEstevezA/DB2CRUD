/**
 * The files around the Swift code: Package.swift (FluentKit with the driver of the database, swift-nio and swift-log
 * for the connection, swift-testing for the tests), the README, an example environment, .gitignore and
 * crud-contract.json for CRUD2Controller.
 */
import type { GeneratedFile } from '../../export/files.ts'
import { lines } from '../types.ts'
import { fileOf, operationName, serviceType, storedType, usesTimes, writesEntities, type ColumnInfo, type Context } from './context.ts'
import { createColumns, createDto, readColumns, readDto, updateColumns, updateType } from './dtos.ts'
import { defaultUrl, driverOf } from './support.ts'

const VERSIONS = {
  fluentKit: '1.57.0',
  postgres: '2.14.1',
  mysql: '4.8.0',
  sqlite: '4.9.0',
  nio: '2.105.0',
  postgresNio: '1.33.3',
  log: '1.17.2',
}

const PACKAGES: Record<string, { name: string; version: string }> = {
  FluentPostgresDriver: { name: 'fluent-postgres-driver', version: VERSIONS.postgres },
  FluentMySQLDriver: { name: 'fluent-mysql-driver', version: VERSIONS.mysql },
  FluentSQLiteDriver: { name: 'fluent-sqlite-driver', version: VERSIONS.sqlite },
}

const tests = (context: Context) => context.settings.tests !== 'none' && writesEntities(context)

export function packageFile(context: Context): GeneratedFile {
  const driver = driverOf(context).module
  const driverPackage = PACKAGES[driver]
  const postgresTimes = context.settings.database === 'postgresql' && usesTimes(context)
  const product = (name: string, pkg: string) => `.product(name: "${name}", package: "${pkg}")`
  return {
    path: 'Package.swift',
    content: lines(
      '// swift-tools-version:6.0',
      'import PackageDescription',
      '',
      'let package = Package(',
      `    name: "${context.settings.name}",`,
      '    platforms: [.macOS(.v13)],',
      `    products: [.library(name: "${context.module}", targets: ["${context.module}"])],`,
      '    dependencies: [',
      `        .package(url: "https://github.com/vapor/fluent-kit.git", from: "${VERSIONS.fluentKit}"),`,
      `        .package(url: "https://github.com/vapor/${driverPackage.name}.git", from: "${driverPackage.version}"),`,
      `        .package(url: "https://github.com/apple/swift-nio.git", from: "${VERSIONS.nio}"),`,
      `        .package(url: "https://github.com/apple/swift-log.git", from: "${VERSIONS.log}"),`,
      // TimeOfDay says how PostgreSQL keeps it
      postgresTimes && `        .package(url: "https://github.com/vapor/postgres-nio.git", from: "${VERSIONS.postgresNio}"),`,
      '    ],',
      '    targets: [',
      '        .target(',
      `            name: "${context.module}",`,
      '            dependencies: [',
      `                ${product('FluentKit', 'fluent-kit')},`,
      `                ${product('FluentSQL', 'fluent-kit')},`,
      `                ${product(driver, driverPackage.name)},`,
      `                ${product('NIOCore', 'swift-nio')},`,
      `                ${product('NIOPosix', 'swift-nio')},`,
      `                ${product('Logging', 'swift-log')},`,
      postgresTimes && `                ${product('PostgresNIO', 'postgres-nio')},`,
      '            ]',
      '        ),',
      tests(context) && [
        '        .testTarget(',
        `            name: "${context.module}Tests",`,
        `            dependencies: ["${context.module}", ${product('FluentKit', 'fluent-kit')}, ${product('FluentSQL', 'fluent-kit')}, ${product(driver, driverPackage.name)}]`,
        '        ),',
      ],
      '    ]',
      ')',
      '',
    ),
  }
}

export function envExampleFile(context: Context): GeneratedFile {
  const sqlite = context.settings.database === 'sqlite'
  return {
    path: '.env.example',
    content: lines(
      '# Where the database is, and who connects',
      `DATABASE_URL=${defaultUrl(context)}`,
      sqlite
        ? '# The tests use SQLite in memory unless this names another database (it is emptied by the tests)'
        : '# The database the tests use (it is emptied by the tests): one of the same kind as DATABASE_URL',
      '# TEST_DATABASE_URL=',
      '',
    ),
  }
}

export const gitignoreFile = (): GeneratedFile => ({ path: '.gitignore', content: lines('.build/', '.swiftpm/', '.env', '*.db', '') })

const LABELS = {
  transactions: {
    operation: 'one transaction per service operation, committed when it ends',
    caller: 'the caller owns the transaction: nothing commits',
    repository: 'every repository write is committed at once',
  },
  paging: {
    none: 'lists return every row',
    offset: 'lists return pages by offset and limit',
    cursor: 'lists return pages after a key (cursor)',
  },
  updates: {
    patch: 'updates take a Patch per field: .absent, or set to a value that may be nil',
    optional: 'updates take a double optional per field: nil when not sent, .some(nil) to empty it',
    full: 'updates take every field that can change',
    partial: '',
  },
}

export function readmeFile(context: Context): GeneratedFile {
  const { settings } = context
  const sqlite = settings.database === 'sqlite'
  return {
    path: 'README.md',
    content: lines(
      `# ${settings.name}`,
      '',
      `Data access layer generated by [DB2CRUD](https://github.com/RaulEstevezA/DB2CRUD) for a database that already exists: entities and Fluent ${VERSIONS.fluentKit} models, repositories and services, in Swift with async/await. It does not create or migrate the database, and it depends on no web framework.`,
      '',
      '## Settings',
      '',
      `- Database: ${settings.database}.`,
      `- Entities: ${settings.entities === 'missing' ? 'written for the tables the input had no type for' : settings.entities === 'all' ? 'written for every table' : `imported from \`${settings.entitiesModule}\``}.`,
      `- Services: ${settings.services ? `take and return ${settings.serviceTypes === 'dtos' ? 'DTOs' : 'the entities'}; ${LABELS.updates[settings.updates]}` : 'not written'}.`,
      `- Transactions: ${LABELS.transactions[settings.transactions]}.`,
      `- Lists: ${LABELS.paging[settings.paging]}.`,
      '',
      '## Layout',
      '',
      '```text',
      `Sources/${context.module}/AppDatabase.swift   the connection of DATABASE_URL`,
      `Sources/${context.module}/UnitOfWork.swift    the repositories of every table, and the transaction of each operation`,
      `Sources/${context.module}/Errors.swift        DomainError: notFound, conflict, validationFailed; no HTTP codes`,
      settings.architecture === 'layer'
        ? [
            `Sources/${context.module}/Entities/          one entity and one Fluent model per table`,
            `Sources/${context.module}/Repositories/      the repositories of each table`,
            settings.services && `Sources/${context.module}/Services/          one service per table`,
          ]
        : `Sources/${context.module}/<Table>/           entity, model, repositories and service of each table`,
      tests(context) && `Tests/${context.module}Tests/            repositories against a database, services on the in-memory repositories`,
      'crud-contract.json                     what was written, for CRUD2Controller',
      '```',
      '',
      '## Running the tests',
      '',
      '```bash',
      sqlite ? 'swift test                                  # SQLite in memory' : null,
      `TEST_DATABASE_URL="${defaultUrl(context)}" swift test   # a real, disposable database: it is emptied`,
      '```',
      '',
      'Look for `TODO` in the code: each one marks a decision the input did not settle.',
      '',
    ),
  }
}

function typeOf(column: ColumnInfo): Record<string, unknown> {
  const type = column.column.type
  return {
    kind: type.kind,
    swift: storedType(column),
    ...(type.kind === 'text' && type.length !== undefined ? { length: type.length } : {}),
  }
}

export function contractFile(context: Context): GeneratedFile {
  const dtos = context.settings.serviceTypes === 'dtos'
  const fields = (columns: ColumnInfo[], optional: boolean) =>
    columns.map((column) => ({ name: column.key, type: typeOf(column), nullable: optional || column.column.nullable }))
  // A Swift package is one module: a type is told by its name and its file
  const file = (info: Context['tables'][number], kind: 'entity' | 'dtos' | 'service', name: string) => fileOf(context, info, kind, name)
  const types = context.tables.flatMap((info) => {
    const result: Record<string, unknown>[] = [
      {
        name: info.entity,
        module: context.module,
        file: file(info, 'entity', info.entity),
        kind: 'entity',
        fields: fields(info.columns, true),
      },
    ]
    const writes = info.role === 'entity' && info.service
    if (dtos && writes)
      result.push({
        name: createDto(info),
        module: context.module,
        file: file(info, 'dtos', createDto(info)),
        kind: 'create',
        fields: fields(createColumns(info), true),
      })
    if (writes)
      result.push({
        name: updateType(context, info),
        module: context.module,
        file: file(info, dtos ? 'dtos' : 'service', updateType(context, info)),
        kind: 'update',
        updates: context.settings.updates,
        fields: fields(updateColumns(info), true),
      })
    if (dtos && info.service)
      result.push({
        name: readDto(info),
        module: context.module,
        file: file(info, 'dtos', readDto(info)),
        kind: 'read',
        fields: fields(readColumns(info), false),
      })
    return result
  })
  const errorsOf: Record<string, string> = { NotFound: 'notFound', Conflict: 'conflict', ValidationFailed: 'validation' }
  const services = context.tables
    .filter((info) => info.service)
    .map((info) => ({
      name: serviceType(info),
      module: context.module,
      operations: info.operations.map((operation) => ({
        name: operationName(context, operation),
        kind: operation.kind,
        ...(operation.columns.length > 0 ? { by: operation.columns } : {}),
        ...(operation.through ? { through: operation.through } : {}),
        errors: operation.errors.map((error) => errorsOf[error]),
      })),
    }))
  const contract = {
    format: 'crud-contract',
    version: 1,
    stack: { language: 'swift', orm: 'fluent', database: context.settings.database, execution: 'async' },
    transactions: context.settings.transactions,
    paging: context.settings.paging,
    types,
    errors: [
      { kind: 'notFound', name: 'DomainError.notFound', module: context.module },
      { kind: 'conflict', name: 'DomainError.conflict', module: context.module },
      { kind: 'validation', name: 'DomainError.validationFailed', module: context.module },
    ],
    common: context.module,
    services,
  }
  return { path: 'crud-contract.json', content: `${JSON.stringify(contract, null, 2)}\n` }
}
