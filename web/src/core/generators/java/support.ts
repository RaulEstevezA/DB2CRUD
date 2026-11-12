/**
 * What every Java project shares: the domain errors services throw (no HTTP codes), the pages lists are read
 * in, Patch (a field of an update: absent, null or a value), the unit of work over the repositories, and the
 * EntityManagerFactory of the database DATABASE_URL names.
 */
import type { GeneratedFile } from '../../export/files.ts'
import { lines } from '../types.ts'
import { javaPath, JavaImports } from './java.ts'
import {
  commonPackage,
  errorsPackage,
  memoryRepositoryClass,
  packageOf,
  qualified,
  repositoryType,
  sqlRepositoryClass,
  type Context,
} from './context.ts'

function file(pkg: string, name: string, body: string[], imports?: JavaImports): GeneratedFile {
  const written = imports?.write() ?? ''
  return { path: javaPath(pkg, name), content: lines(`package ${pkg};`, '', written !== '' && [written, ''], ...body, '') }
}

export function errorFiles(context: Context): GeneratedFile[] {
  const pkg = errorsPackage(context)
  return [
    file(pkg, 'DomainException', [
      '/** Base of every error a service throws on purpose. They carry no HTTP codes: whoever calls the services translates them. */',
      'public abstract class DomainException extends RuntimeException {',
      '    protected DomainException(String message) {',
      '        super(message);',
      '    }',
      '}',
    ]),
    file(pkg, 'NotFoundException', [
      '/** No row has this key. */',
      'public class NotFoundException extends DomainException {',
      '    private final String entity;',
      '    private final Object key;',
      '',
      '    public NotFoundException(String entity, Object key) {',
      '        super("No " + entity + " has the key " + key);',
      '        this.entity = entity;',
      '        this.key = key;',
      '    }',
      '',
      '    public String getEntity() {',
      '        return entity;',
      '    }',
      '',
      '    public Object getKey() {',
      '        return key;',
      '    }',
      '}',
    ]),
    file(
      pkg,
      'ConflictException',
      [
        '/** The change clashes with what is stored: a unique value, a newer version, rows that depend on it. */',
        'public class ConflictException extends DomainException {',
        '    private final String entity;',
        '    private final String reason;',
        '    private final List<String> fields;',
        '',
        '    public ConflictException(String entity, String reason, List<String> fields) {',
        '        super(entity + ": " + reason);',
        '        this.entity = entity;',
        '        this.reason = reason;',
        '        this.fields = List.copyOf(fields);',
        '    }',
        '',
        '    public ConflictException(String entity, String reason) {',
        '        this(entity, reason, List.of());',
        '    }',
        '',
        '    public String getEntity() {',
        '        return entity;',
        '    }',
        '',
        '    public String getReason() {',
        '        return reason;',
        '    }',
        '',
        '    public List<String> getFields() {',
        '        return fields;',
        '    }',
        '}',
      ],
      new JavaImports(pkg).add('java.util.List'),
    ),
    file(pkg, 'FieldError', ['/** What is wrong with one field. */', 'public record FieldError(String field, String message) {}']),
    file(
      pkg,
      'ValidationFailedException',
      [
        '/** The values break the rules of the table: missing, too long, out of range, pointing nowhere. */',
        'public class ValidationFailedException extends DomainException {',
        '    private final String entity;',
        '    private final List<FieldError> errors;',
        '',
        '    public ValidationFailedException(String entity, List<FieldError> errors) {',
        '        super(entity + ": " + errors.stream().map((error) -> error.field() + ": " + error.message()).collect(Collectors.joining("; ")));',
        '        this.entity = entity;',
        '        this.errors = List.copyOf(errors);',
        '    }',
        '',
        '    public String getEntity() {',
        '        return entity;',
        '    }',
        '',
        '    public List<FieldError> getErrors() {',
        '        return errors;',
        '    }',
        '}',
      ],
      new JavaImports(pkg).add('java.util.List', 'java.util.stream.Collectors'),
    ),
  ]
}

export function commonFiles(context: Context): GeneratedFile[] {
  const pkg = commonPackage(context)
  const files: GeneratedFile[] = []
  if (context.settings.paging === 'offset')
    files.push(
      file(
        pkg,
        'Page',
        [
          '/** A page of a list: the rows from an offset, and how many there are in all. */',
          'public record Page<T>(List<T> items, long total, int offset, int limit) {',
          '    /** The same page with every row turned into something else. */',
          '    public <R> Page<R> map(Function<T, R> mapper) {',
          '        return new Page<>(items.stream().map(mapper).toList(), total, offset, limit);',
          '    }',
          '}',
        ],
        new JavaImports(pkg).add('java.util.List', 'java.util.function.Function'),
      ),
    )
  if (context.settings.paging === 'cursor')
    files.push(
      file(
        pkg,
        'CursorPage',
        [
          '/** A page of a list read with a cursor: the rows after a key, and the key to read the next page from (null on the last page). */',
          'public record CursorPage<T>(List<T> items, List<Object> next) {',
          '    /** The same page with every row turned into something else. */',
          '    public <R> CursorPage<R> map(Function<T, R> mapper) {',
          '        return new CursorPage<>(items.stream().map(mapper).toList(), next);',
          '    }',
          '}',
        ],
        new JavaImports(pkg).add('java.util.List', 'java.util.function.Function'),
      ),
    )
  if (context.settings.services && context.settings.updates === 'patch')
    files.push(
      file(pkg, 'Patch', [
        '/**',
        ' * A field of an update: absent (it keeps its value), or present with a value, which may be null.',
        ' *',
        ' * @param <T> the type of the value',
        ' */',
        'public final class Patch<T> {',
        '    private static final Patch<?> ABSENT = new Patch<>(false, null);',
        '',
        '    private final boolean present;',
        '    private final T value;',
        '',
        '    private Patch(boolean present, T value) {',
        '        this.present = present;',
        '        this.value = value;',
        '    }',
        '',
        '    /** The field keeps its value. */',
        '    @SuppressWarnings("unchecked")',
        '    public static <T> Patch<T> absent() {',
        '        return (Patch<T>) ABSENT;',
        '    }',
        '',
        '    /** The field takes this value, which may be null. */',
        '    public static <T> Patch<T> of(T value) {',
        '        return new Patch<>(true, value);',
        '    }',
        '',
        '    public boolean isPresent() {',
        '        return present;',
        '    }',
        '',
        '    /** The value to set; null when absent or set to null. */',
        '    public T value() {',
        '        return value;',
        '    }',
        '',
        '    @Override',
        '    public String toString() {',
        '        return present ? "Patch[" + value + "]" : "Patch.absent";',
        '    }',
        '}',
      ]),
    )
  return files
}

const HOW = {
  operation: 'Each service operation runs in transaction(): committed when it ends, rolled back when it fails.',
  caller: 'Services never commit: whoever holds the EntityManager opens and ends its transaction; transaction() only groups the code.',
  repository: 'Every repository write is committed at once; transaction() only groups the code.',
}

/** UnitOfWork, SqlUnitOfWork and MemoryUnitOfWork, in the base package. */
export function unitOfWorkFiles(context: Context): GeneratedFile[] {
  const pkg = context.base
  const settings = context.settings
  const typeImports = (imports: JavaImports, kind: 'interface' | 'sql' | 'memory') => {
    for (const info of context.tables) {
      if (kind === 'interface') imports.add(qualified(context, info, 'repository', repositoryType(context, info)))
      if (kind === 'sql') imports.add(qualified(context, info, 'repository', sqlRepositoryClass(info)))
      if (kind === 'memory') imports.add(qualified(context, info, 'repository', memoryRepositoryClass(info)))
      if (kind !== 'interface') imports.add(qualified(context, info, 'repository', repositoryType(context, info)))
    }
    return imports
  }
  const accessors = () =>
    context.tables.flatMap((info) => [
      '',
      '    @Override',
      `    public ${repositoryType(context, info)} ${info.attr}() {`,
      `        return ${info.attr};`,
      '    }',
    ])
  const fields = (create: (info: Context['tables'][number]) => string) =>
    context.tables.map((info) => `    private final ${repositoryType(context, info)} ${info.attr} = ${create(info)};`)
  const files: GeneratedFile[] = [
    file(
      pkg,
      'UnitOfWork',
      [
        `/** What services depend on: a repository per table and a transaction. ${HOW[settings.transactions]} */`,
        'public interface UnitOfWork {',
        ...context.tables.map((info) => `    ${repositoryType(context, info)} ${info.attr}();`),
        '',
        '    /** Runs work with the repositories of the transaction; commits when it ends, rolls back when it throws. */',
        '    <T> T transaction(Function<UnitOfWork, T> work);',
        '}',
      ],
      typeImports(new JavaImports(pkg).add('java.util.function.Function'), 'interface'),
    ),
  ]
  files.push(
    file(
      pkg,
      'SqlUnitOfWork',
      [
        '/** The repositories over one EntityManager, and its transaction. */',
        'public class SqlUnitOfWork implements UnitOfWork {',
        '    private final EntityManager entityManager;',
        ...context.tables.map((info) => `    private final ${repositoryType(context, info)} ${info.attr};`),
        '',
        '    public SqlUnitOfWork(EntityManager entityManager) {',
        '        this.entityManager = entityManager;',
        ...context.tables.map((info) => `        this.${info.attr} = new ${sqlRepositoryClass(info)}(entityManager);`),
        '    }',
        '',
        '    public EntityManager entityManager() {',
        '        return entityManager;',
        '    }',
        ...accessors(),
        '',
        '    @Override',
        '    public <T> T transaction(Function<UnitOfWork, T> work) {',
        ...(settings.transactions === 'operation'
          ? [
              '        EntityTransaction transaction = entityManager.getTransaction();',
              '        // Joins the transaction already open',
              '        if (transaction.isActive()) return work.apply(this);',
              '        transaction.begin();',
              '        try {',
              '            T result = work.apply(this);',
              '            transaction.commit();',
              '            return result;',
              '        } catch (RuntimeException error) {',
              '            if (transaction.isActive()) transaction.rollback();',
              '            throw error;',
              '        }',
            ]
          : ['        return work.apply(this);']),
        '    }',
        '}',
      ],
      typeImports(
        new JavaImports(pkg).add(
          'jakarta.persistence.EntityManager',
          'java.util.function.Function',
          ...(settings.transactions === 'operation' ? ['jakarta.persistence.EntityTransaction'] : []),
        ),
        'sql',
      ),
    ),
  )
  if (settings.memoryRepositories)
    files.push(
      file(
        pkg,
        'MemoryUnitOfWork',
        [
          '/** The in-memory repositories, for tests and for trying the services without a database. */',
          'public class MemoryUnitOfWork implements UnitOfWork {',
          ...fields((info) => `new ${memoryRepositoryClass(info)}()`),
          ...accessors(),
          '',
          '    /** Memory has no transactions: changes are kept as they are made. */',
          '    @Override',
          '    public <T> T transaction(Function<UnitOfWork, T> work) {',
          '        return work.apply(this);',
          '    }',
          '}',
        ],
        typeImports(new JavaImports(pkg).add('java.util.function.Function'), 'memory'),
      ),
    )
  return files
}

/** `Database`: the EntityManagerFactory of the database DATABASE_URL names, with every entity. */
export function databaseFile(context: Context): GeneratedFile {
  const pkg = context.base
  const imports = new JavaImports(pkg).add(
    'jakarta.persistence.EntityManagerFactory',
    'org.hibernate.jpa.HibernatePersistenceConfiguration',
  )
  for (const info of context.tables) imports.add(`${packageOf(context, info, 'entity')}.${info.entity}`)
  const url = {
    postgresql: 'jdbc:postgresql://localhost:5432/app',
    mysql: 'jdbc:mysql://localhost:3306/app',
    mariadb: 'jdbc:mariadb://localhost:3306/app',
    sqlite: 'jdbc:sqlite:app.db?foreign_keys=true',
  }[context.settings.database as 'postgresql' | 'mysql' | 'mariadb' | 'sqlite']
  return file(
    pkg,
    'Database',
    [
      '/** The database DATABASE_URL names (a JDBC URL; DATABASE_USER and DATABASE_PASSWORD), through Hibernate. */',
      'public final class Database {',
      `    public static final String DEFAULT_URL = "${url}";`,
      '',
      '    private Database() {}',
      '',
      '    /** Every entity, so Hibernate knows every table */',
      `    public static final List<Class<?>> ENTITIES = List.of(${context.tables.map((info) => `${info.entity}.class`).join(', ')});`,
      '',
      '    /** The configuration of the database at url: give it a connection pool or a DataSource for production. */',
      '    public static HibernatePersistenceConfiguration configuration(String url, String user, String password) {',
      '        HibernatePersistenceConfiguration configuration = new HibernatePersistenceConfiguration("app")',
      '                .managedClasses(ENTITIES)',
      '                .jdbcUrl(url)',
      '                // The services check the values; the database fills its defaults',
      '                .property("hibernate.check_nullability", false)',
      '                // Every name is quoted, so names like rank or order work and are used exactly as the database has them',
      '                .property("hibernate.globally_quoted_identifiers", true)',
      '                .property("hibernate.globally_quoted_identifiers_skip_column_definitions", true);',
      '        if (user != null) configuration.jdbcCredentials(user, password == null ? "" : password);',
      '        return configuration;',
      '    }',
      '',
      '    /** The EntityManagerFactory of DATABASE_URL, DATABASE_USER and DATABASE_PASSWORD. */',
      '    public static EntityManagerFactory open() {',
      '        String url = System.getenv().getOrDefault("DATABASE_URL", DEFAULT_URL);',
      '        return configuration(url, System.getenv("DATABASE_USER"), System.getenv("DATABASE_PASSWORD")).createEntityManagerFactory();',
      '    }',
      '}',
    ],
    imports.add('java.util.List'),
  )
}
