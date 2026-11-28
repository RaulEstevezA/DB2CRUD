/**
 * The files around the C# code: the solution (App.slnx), global.json (the Microsoft Testing Platform), the project
 * of the code (net10.0 and the packages of the strategy) and the one of the tests (xUnit v3), the
 * README, an example environment, .gitignore and crud-contract.json for CRUD2Controller.
 */
import { byFields, serviceTarget } from '../contract.ts'
import type { GeneratedFile } from '../../export/files.ts'
import { nestedFields } from '../../schema/documents.ts'
import type { DbType } from '../../schema/types.ts'
import { lines } from '../types.ts'
import {
  commonNamespace,
  errorsNamespace,
  namespaceOf,
  operationName,
  serviceClass,
  writesEntities,
  type ColumnInfo,
  type Context,
} from './context.ts'
import { createColumns, createDto, readColumns, readDto, updateColumns, updateNamespace, updateType } from './dtos.ts'
import { defaultConnection } from './support.ts'

const XUNIT = '4.0.3'

const tests = (context: Context) => context.settings.tests !== 'none' && writesEntities(context)

/** The project files; `modelsFolder` when the copy of the imported application models is in application-models/. */
export function projectFiles(context: Context, modelsFolder = false): GeneratedFile[] {
  const files: GeneratedFile[] = [
    {
      path: 'App.slnx',
      content: lines(
        '<Solution>',
        '  <Project Path="src/App/App.csproj" />',
        tests(context) && '  <Project Path="tests/App.Tests/App.Tests.csproj" />',
        '</Solution>',
        '',
      ),
    },
    {
      path: 'global.json',
      content: `${JSON.stringify({ test: { runner: 'Microsoft.Testing.Platform' } }, null, 2)}\n`,
    },
    {
      path: 'src/App/App.csproj',
      content: lines(
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <PropertyGroup>',
        '    <TargetFramework>net10.0</TargetFramework>',
        '    <Nullable>enable</Nullable>',
        '    <ImplicitUsings>enable</ImplicitUsings>',
        '    <RootNamespace>App</RootNamespace>',
        '  </PropertyGroup>',
        '  <ItemGroup>',
        ...context.orm.packages(context).map(([name, version]) => `    <PackageReference Include="${name}" Version="${version}" />`),
        '  </ItemGroup>',
        // The copy of the application models, while the project runs on its own: delete the folder inside the application
        modelsFolder && [
          `  <ItemGroup Condition="Exists('../../application-models')">`,
          '    <Compile Include="../../application-models/**/*.cs" />',
          '  </ItemGroup>',
        ],
        '</Project>',
        '',
      ),
    },
  ]
  if (tests(context))
    files.push({
      path: 'tests/App.Tests/App.Tests.csproj',
      content: lines(
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <PropertyGroup>',
        '    <TargetFramework>net10.0</TargetFramework>',
        '    <Nullable>enable</Nullable>',
        '    <ImplicitUsings>enable</ImplicitUsings>',
        '    <OutputType>Exe</OutputType>',
        '    <IsPackable>false</IsPackable>',
        '    <RootNamespace>App.Tests</RootNamespace>',
        '    <!-- The tests share one database and run one after another: no cancellation to pass on -->',
        '    <NoWarn>$(NoWarn);xUnit1051</NoWarn>',
        '  </PropertyGroup>',
        '  <ItemGroup>',
        `    <PackageReference Include="xunit.v3" Version="${XUNIT}" />`,
        '  </ItemGroup>',
        '  <ItemGroup>',
        '    <ProjectReference Include="../../src/App/App.csproj" />',
        '  </ItemGroup>',
        '</Project>',
        '',
      ),
    })
  return files
}

export function envExampleFile(context: Context): GeneratedFile {
  const sqlite = context.settings.database === 'sqlite'
  return {
    path: '.env.example',
    content: lines(
      '# Where the database is (a connection string)',
      `DATABASE_CONNECTION=${defaultConnection(context)}`,
      sqlite
        ? '# The tests use SQLite in memory unless this names another database (it is emptied by the tests)'
        : '# The database the tests use (it is emptied by the tests): one of the same kind as DATABASE_CONNECTION',
      '# TEST_DATABASE_CONNECTION=',
      '',
    ),
  }
}

export const gitignoreFile = (): GeneratedFile => ({ path: '.gitignore', content: lines('bin/', 'obj/', '.env', '*.db', '') })

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
    patch: 'updates take a Patch<T> per field: absent, null or a value',
    full: 'updates take every field that can change',
    optional: '',
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
      `Data access layer generated by [DB2CRUD](https://github.com/RaulEstevezA/DB2CRUD) for a database that already exists: ${context.orm.readme.intro}, in C# for .NET 10. It does not create or migrate the database, and it depends on no web framework.`,
      '',
      '## Settings',
      '',
      `- Database: ${settings.database}.`,
      `- Entities: ${settings.entities === 'missing' ? 'written for the tables the input had no class for' : settings.entities === 'all' ? 'written for every table' : `imported from \`${settings.entitiesModule}\``}.`,
      `- Services: ${settings.services ? `take and return ${settings.serviceTypes === 'dtos' ? `DTOs (${settings.dtoKind === 'class' ? 'classes' : 'records'})` : 'the entities'}; ${LABELS.updates[settings.updates]}` : 'not written'}.`,
      `- Transactions: ${LABELS.transactions[settings.transactions]}.`,
      `- Lists: ${LABELS.paging[settings.paging]}.`,
      '',
      '## Layout',
      '',
      '```text',
      ...context.orm.readme.layout,
      'src/App/IUnitOfWork.cs           the repositories of every table, and the transaction of each operation',
      'src/App/Errors/                  NotFoundException, ConflictException, ValidationFailedException: no HTTP codes',
      settings.architecture === 'layer'
        ? [
            'src/App/Entities/                one entity per table',
            'src/App/Repositories/            the repositories of each table',
            settings.services && 'src/App/Services/                one service per table',
          ]
        : 'src/App/Tables/<table>/          entity, repositories and service of each table',
      'tests/App.Tests/                 repositories against a database, services on the in-memory repositories',
      'crud-contract.json               what was written, for CRUD2Controller',
      '```',
      '',
      '## Running the tests',
      '',
      '```bash',
      sqlite ? 'dotnet test                                       # SQLite in memory' : null,
      `TEST_DATABASE_CONNECTION="${defaultConnection(context)}" dotnet test   # a real, disposable database: ${context.orm.readme.reset}`,
      '```',
      '',
      'Look for `TODO` in the code: each one marks a decision the input did not settle.',
      '',
    ),
  }
}

function typeOf(column: ColumnInfo): Record<string, unknown> {
  const { kind, ...rest } = plainType(column.column.type)
  return { kind, cs: column.propType, ...rest }
}

function plainType(type: DbType): Record<string, unknown> {
  // What a nested document, or each of a list of them, holds
  const fields = nestedFields(type)
  return {
    kind: type.kind,
    ...(type.kind === 'text' && type.length !== undefined ? { length: type.length } : {}),
    ...(fields ? { fields: fields.map((field) => ({ name: field.name, type: plainType(field.type), nullable: field.nullable })) } : {}),
  }
}

export function contractFile(context: Context): GeneratedFile {
  const dtos = context.settings.serviceTypes === 'dtos'
  const fields = (columns: ColumnInfo[], optional: boolean) =>
    columns.map((column) => ({ name: column.prop, type: typeOf(column), nullable: optional || column.column.nullable }))
  const types = context.tables.flatMap((info) => {
    const result: Record<string, unknown>[] = [
      { name: info.entity, module: namespaceOf(context, info, 'entity'), kind: 'entity', fields: fields(info.columns, false) },
    ]
    const writes = info.role === 'entity' && info.service
    if (dtos && writes)
      result.push({
        name: createDto(info),
        module: namespaceOf(context, info, 'dtos'),
        kind: 'create',
        fields: fields(createColumns(info), false),
      })
    if (writes)
      result.push({
        name: updateType(context, info),
        module: updateNamespace(context, info),
        kind: 'update',
        updates: context.settings.updates,
        fields: fields(updateColumns(info), true),
      })
    if (dtos && info.service)
      result.push({
        name: readDto(info),
        module: namespaceOf(context, info, 'dtos'),
        kind: 'read',
        fields: fields(readColumns(info), false),
      })
    return result
  })
  const errorsOf: Record<string, string> = { NotFound: 'notFound', Conflict: 'conflict', ValidationFailed: 'validation' }
  const services = context.tables
    .filter((info) => info.service)
    .map((info) => ({
      name: serviceClass(info),
      module: namespaceOf(context, info, 'service'),
      ...serviceTarget(info, (column) => column.prop),
      operations: info.operations.map((operation) => ({
        name: operationName(context, operation),
        kind: operation.kind,
        ...(operation.columns.length > 0
          ? { by: operation.columns, byFields: byFields(info.columns, operation.columns, (column) => column.prop) }
          : {}),
        ...(operation.through ? { through: operation.through } : {}),
        errors: operation.errors.map((error) => errorsOf[error]),
      })),
    }))
  const contract = {
    format: 'crud-contract',
    version: 1,
    stack: { language: 'csharp', orm: context.orm.id, database: context.settings.database, execution: 'async' },
    transactions: context.settings.transactions,
    paging: context.settings.paging,
    types,
    errors: [
      { kind: 'notFound', name: 'NotFoundException', module: errorsNamespace(context) },
      { kind: 'conflict', name: 'ConflictException', module: errorsNamespace(context) },
      { kind: 'validation', name: 'ValidationFailedException', module: errorsNamespace(context) },
    ],
    common: commonNamespace(context),
    services,
  }
  return { path: 'crud-contract.json', content: `${JSON.stringify(contract, null, 2)}\n` }
}
