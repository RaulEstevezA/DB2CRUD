/**
 * Project files of the ASP.NET Core project: the solution and the two projects (the API and its tests), the
 * settings (appsettings.json, launchSettings.json), ignore rules and the README.
 */
import type { SpecResource } from '../../../api/spec.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import type { AspNetContext } from './context.ts'

const DOTNET = 'net10.0'
const ASPNET_VERSION = '10.0.14'
const EF_CORE_VERSION = '10.0.14'
const NPGSQL_VERSION = '10.0.3'
const MYSQL_VERSION = '10.0.12'
const XUNIT_VERSION = '4.0.2'

/** The EF Core provider of each database. */
const PROVIDERS: Record<string, { package: string; version: string }> = {
  postgresql: { package: 'Npgsql.EntityFrameworkCore.PostgreSQL', version: NPGSQL_VERSION },
  mysql: { package: 'MySql.EntityFrameworkCore', version: MYSQL_VERSION },
  mariadb: { package: 'MySql.EntityFrameworkCore', version: MYSQL_VERSION },
  sqlite: { package: 'Microsoft.EntityFrameworkCore.Sqlite', version: EF_CORE_VERSION },
}

/** Connection strings to start from, for a database on this computer. */
export const CONNECTIONS: Record<string, string> = {
  postgresql: 'Host=localhost;Port=5432;Database=api;Username=api;Password=change-me',
  mysql: 'Server=localhost;Port=3306;Database=api;User ID=api;Password=change-me',
  mariadb: 'Server=localhost;Port=3306;Database=api;User ID=api;Password=change-me',
  sqlite: 'Data Source=app.db',
}

function packageReference(name: string, version: string): string {
  return `    <PackageReference Include="${name}" Version="${version}" />`
}

export function projectFiles(context: AspNetContext): GeneratedFile[] {
  const { root } = context
  const { auth, database } = context.settings
  const provider = context.efCore ? PROVIDERS[database ?? 'postgresql'] : undefined
  const references = [
    auth === 'jwt' && packageReference('Microsoft.AspNetCore.Authentication.JwtBearer', ASPNET_VERSION),
    context.efCore && packageReference('Microsoft.EntityFrameworkCore', EF_CORE_VERSION),
    context.efCore && packageReference('Microsoft.EntityFrameworkCore.Relational', EF_CORE_VERSION),
    provider && packageReference(provider.package, provider.version),
  ].filter((item): item is string => typeof item === 'string')
  const api = lines(
    '<Project Sdk="Microsoft.NET.Sdk.Web">',
    '',
    '  <PropertyGroup>',
    `    <TargetFramework>${DOTNET}</TargetFramework>`,
    '    <Nullable>enable</Nullable>',
    '    <ImplicitUsings>enable</ImplicitUsings>',
    `    <RootNamespace>${root}</RootNamespace>`,
    '  </PropertyGroup>',
    references.length > 0 && ['', '  <ItemGroup>', references, '  </ItemGroup>'],
    '',
    '</Project>',
  )
  const tests = lines(
    '<Project Sdk="Microsoft.NET.Sdk">',
    '',
    '  <PropertyGroup>',
    `    <TargetFramework>${DOTNET}</TargetFramework>`,
    '    <Nullable>enable</Nullable>',
    '    <ImplicitUsings>enable</ImplicitUsings>',
    '    <OutputType>Exe</OutputType>',
    '    <IsPackable>false</IsPackable>',
    `    <RootNamespace>${root}.Tests</RootNamespace>`,
    '  </PropertyGroup>',
    '',
    '  <ItemGroup>',
    packageReference('Microsoft.AspNetCore.Mvc.Testing', ASPNET_VERSION),
    context.efCore && context.settings.database !== 'sqlite' && packageReference('Microsoft.EntityFrameworkCore.Sqlite', EF_CORE_VERSION),
    packageReference('xunit.v3', XUNIT_VERSION),
    '  </ItemGroup>',
    '',
    '  <ItemGroup>',
    `    <ProjectReference Include="../../src/${root}/${root}.csproj" />`,
    '  </ItemGroup>',
    '',
    '</Project>',
  )
  const solution = lines(
    '<Solution>',
    '  <Folder Name="/src/">',
    `    <Project Path="src/${root}/${root}.csproj" />`,
    '  </Folder>',
    '  <Folder Name="/tests/">',
    `    <Project Path="tests/${root}.Tests/${root}.Tests.csproj" />`,
    '  </Folder>',
    '</Solution>',
  )
  const settings: Record<string, unknown> = {
    Logging: { LogLevel: { Default: 'Information', 'Microsoft.AspNetCore': 'Warning' } },
    AllowedHosts: '*',
    ...(context.efCore ? { DATABASE_CONNECTION: CONNECTIONS[database ?? 'postgresql'] } : {}),
    ...(auth === 'apiKey' ? { API_KEYS: '' } : {}),
    ...(auth === 'jwt' ? { JWT_SECRET: '', JWT_AUDIENCE: '', JWT_ISSUER: '' } : {}),
  }
  const launch = {
    profiles: {
      http: {
        commandName: 'Project',
        launchBrowser: false,
        applicationUrl: 'http://localhost:5000',
        environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development' },
      },
    },
  }
  // dotnet test runs the tests with Microsoft.Testing.Platform, which xUnit v3 uses
  const global = { test: { runner: 'Microsoft.Testing.Platform' } }
  return [
    { path: 'global.json', content: fileText(JSON.stringify(global, null, 2)) },
    { path: `${root}.slnx`, content: fileText(solution) },
    { path: `src/${root}/${root}.csproj`, content: fileText(api) },
    { path: `src/${root}/appsettings.json`, content: fileText(JSON.stringify(settings, null, 2)) },
    { path: `src/${root}/Properties/launchSettings.json`, content: fileText(JSON.stringify(launch, null, 2)) },
    { path: `tests/${root}.Tests/${root}.Tests.csproj`, content: fileText(tests) },
  ]
}

export function gitignoreFile(): GeneratedFile {
  return {
    path: '.gitignore',
    content: fileText(lines('bin/', 'obj/', 'TestResults/', '*.db', '*.user', '.vs/', '.idea/', '.vscode/', '.DS_Store')),
  }
}

function endpointRows(resources: SpecResource[]): string[] {
  return resources.flatMap((resource) =>
    resource.endpoints.map((endpoint) => {
      const access = endpoint.access === 'roles' ? `roles: ${endpoint.roles.join(', ')}` : endpoint.access
      return `| \`${endpoint.method}\` | \`${endpoint.path}\` | ${endpoint.summary} | ${endpoint.status} | ${access} |`
    }),
  )
}

export function readmeFile(context: AspNetContext): GeneratedFile {
  const { settings, spec, root } = context
  const pending: string[] = []
  if (context.pending) pending.push('- Storage: every repository answers 501 until you write it (search for `TODO`).')
  for (const resource of spec.resources) {
    if (resource.todo) pending.push(`- ${resource.todo}`)
    for (const field of resource.fields) if (field.todo) pending.push(`- ${resource.name}: ${field.todo}`)
    for (const endpoint of resource.endpoints.filter((item) => item.operation === 'custom')) {
      pending.push(
        `- \`${endpoint.method} ${endpoint.path}\` (${endpoint.summary}): write its logic in the service; it answers 501 until then.`,
      )
    }
  }
  const storage =
    settings.persistence === 'memory'
      ? 'Data is kept in memory while the application runs and is lost when it stops. Write another implementation of each repository interface and register it in `Program.cs`.'
      : settings.persistence === 'none'
        ? 'Storage is left to you: each repository is an interface whose methods answer 501 until you implement them.'
        : `Entity Framework Core on ${settings.database}. The application creates the tables when the database has none (\`EnsureCreated\`); for a real database, use migrations (\`dotnet ef migrations add Initial\`, or Model2DB). Embedded objects and lists are stored as JSON columns, and references as key columns.`
  const auth =
    settings.auth === 'none'
      ? 'Every endpoint is public.'
      : settings.auth === 'apiKey'
        ? 'Protected endpoints need a key in the `X-API-Key` header, one of the comma-separated keys in `API_KEYS`. Without `API_KEYS`, every protected request is rejected.'
        : 'Protected endpoints need a bearer token issued by your identity provider, signed with HS256. The API verifies it with `JWT_SECRET` (at least 32 bytes; and `JWT_AUDIENCE` / `JWT_ISSUER` when set), requires an expiry, and reads the roles from the `roles` claim. It does not issue tokens.'
  const variables = [
    context.efCore && '`DATABASE_CONNECTION` (the connection string)',
    settings.auth === 'apiKey' && '`API_KEYS`',
    settings.auth === 'jwt' && '`JWT_SECRET`, `JWT_AUDIENCE`, `JWT_ISSUER`',
  ].filter(Boolean)
  const layout =
    settings.architecture === 'modular'
      ? [
          `src/${root}/`,
          '  Common/              errors, lists, request bodies and JSON helpers',
          '  Shared/              enums and embedded objects',
          '  Features/<Resource>/ model, request and response, repository, service and controller of one resource',
          context.efCore && '  Data/                the database context',
          context.security && '  Security/            authentication',
        ]
      : [
          `src/${root}/`,
          '  Common/              errors, lists, request bodies and JSON helpers',
          '  Models/              domain classes, enums and embedded objects',
          '  Dtos/                request bodies and responses',
          '  Repositories/        storage',
          '  Services/            rules of each resource',
          '  Controllers/         HTTP routes',
          context.efCore && '  Data/                the database context',
          context.security && '  Security/            authentication',
        ]
  const content = lines(
    `# ${spec.title}`,
    '',
    'REST API generated by [Model2API](https://raulesteveza.github.io/tools/Model2API/) with ASP.NET Core. It is a starting point: review it before using it in production.',
    '',
    '## Run it',
    '',
    'Requires the .NET 10 SDK.',
    '',
    '```bash',
    `dotnet run --project src/${root}`,
    '```',
    '',
    variables.length > 0
      ? `Settings are read from \`src/${root}/appsettings.json\` and, above it, from environment variables with the same names: ${variables.join(', ')}. Never commit real values.`
      : false,
    '',
    'The API listens on http://localhost:5000. Its contract is in `openapi.yaml`.',
    '',
    '## Test it',
    '',
    '```bash',
    'dotnet test',
    '```',
    '',
    'Each test starts the application anew, so it starts with empty storage.',
    context.efCore &&
      `The tests use a new SQLite file for each test, or the ${settings.database} database in \`TEST_DATABASE_CONNECTION\` (a connection string to a database only for tests: each test deletes and creates it again).`,
    '',
    '## Endpoints',
    '',
    '| Method | Path | What it does | Success | Access |',
    '|---|---|---|---|---|',
    endpointRows(spec.resources),
    '',
    'Errors always have the same body: `{"error": {"code": "...", "message": "...", "details": [...]}}`. Invalid requests answer 400.',
    '',
    '## Storage',
    '',
    storage,
    '',
    '## Authentication',
    '',
    auth,
    '',
    '## Structure',
    '',
    '```text',
    layout,
    `tests/${root}.Tests/    one test class per resource`,
    'openapi.yaml             the contract of the API',
    '```',
    '',
    '## Left to you',
    '',
    pending.length > 0 ? pending : '- Nothing marked: review the generated code before using it.',
  )
  return { path: 'README.md', content: fileText(content) }
}
