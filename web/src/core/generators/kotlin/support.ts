/**
 * What every Kotlin project shares: the domain errors services throw (no HTTP codes), the pages lists are read in,
 * Patch (a field of an update: absent, or a value that may be null), and the unit of work over the repositories, with its
 * database and in-memory versions.
 */
import type { GeneratedFile } from '../../export/files.ts'
import {
  commonPackage,
  errorsPackage,
  ktFile,
  memoryRepositoryClass,
  packageOf,
  pathOf,
  qualified,
  repositoryType,
  sqlRepositoryClass,
  type Context,
  type TableInfo,
} from './context.ts'
import { KtImports } from './kotlin.ts'

export function errorsFile(context: Context): GeneratedFile {
  const pkg = errorsPackage(context)
  return ktFile(pathOf(pkg, 'Errors'), pkg, '', [
    '/** Base of every error a service throws on purpose. They carry no HTTP codes: whoever calls the services translates them. */',
    'abstract class DomainException(message: String) : RuntimeException(message)',
    '',
    '/** No row has this key. */',
    'class NotFoundException(val entity: String, val key: Any) :',
    '    DomainException("No $entity has the key ${if (key is List<*>) key.joinToString(", ") else key}")',
    '',
    '/** The change clashes with what is stored: a unique value, a newer version, rows that depend on it. */',
    'class ConflictException(val entity: String, val reason: String, val fields: List<String> = emptyList()) :',
    '    DomainException("$entity: $reason")',
    '',
    '/** What is wrong with one field. */',
    'data class FieldError(val field: String, val message: String)',
    '',
    '/** The values break the rules of the table: missing, too long, out of range, pointing nowhere. */',
    'class ValidationFailedException(val entity: String, val errors: List<FieldError>) :',
    '    DomainException("$entity: " + errors.joinToString("; ") { "${it.field}: ${it.message}" })',
  ])
}

export function commonFiles(context: Context): GeneratedFile[] {
  const pkg = commonPackage(context)
  const files: GeneratedFile[] = []
  if (context.settings.paging === 'offset')
    files.push(
      ktFile(pathOf(pkg, 'Page'), pkg, '', [
        '/** A page of a list: the rows from an offset, and how many there are in all. */',
        'data class Page<T>(val items: List<T>, val total: Long, val offset: Int, val limit: Int) {',
        '    /** The same page with every row turned into something else. */',
        '    fun <R> map(mapper: (T) -> R): Page<R> = Page(items.map(mapper), total, offset, limit)',
        '}',
      ]),
    )
  if (context.settings.paging === 'cursor')
    files.push(
      ktFile(pathOf(pkg, 'CursorPage'), pkg, '', [
        '/** A page of a list read with a cursor: the rows after a key, and the key to read the next page from (null on the last page). */',
        'data class CursorPage<T>(val items: List<T>, val next: List<Any>?) {',
        '    /** The same page with every row turned into something else. */',
        '    fun <R> map(mapper: (T) -> R): CursorPage<R> = CursorPage(items.map(mapper), next)',
        '}',
      ]),
    )
  if (context.settings.services && context.settings.updates === 'patch')
    files.push(
      ktFile(pathOf(pkg, 'Patch'), pkg, '', [
        '/** A field of an update: absent (it keeps its value), or present with a value, which may be null. */',
        'class Patch<out T> private constructor(val isPresent: Boolean, val value: T?) {',
        '    override fun toString(): String = if (isPresent) "Patch[$value]" else "Patch.absent"',
        '',
        '    companion object {',
        '        private val ABSENT = Patch<Nothing>(false, null)',
        '',
        '        /** The field keeps its value. */',
        '        fun <T> absent(): Patch<T> = ABSENT',
        '',
        '        /** The field takes this value, which may be null. */',
        '        fun <T> of(value: T?): Patch<T> = Patch(true, value)',
        '    }',
        '}',
      ]),
    )
  return files
}

const URLS: Record<string, string> = {
  postgresql: 'jdbc:postgresql://localhost:5432/app',
  mysql: 'jdbc:mysql://localhost:3306/app',
  mariadb: 'jdbc:mariadb://localhost:3306/app',
  sqlite: 'jdbc:sqlite:app.db',
}

export const defaultUrl = (context: Context) => context.orm.url ?? URLS[context.settings.database] ?? URLS.postgresql

const how = (context: Context) => ({
  operation: 'Each service operation runs in transaction(): committed when it ends, rolled back when it throws.',
  caller: `Services never commit: whoever holds the ${context.orm.holder.text} opens and ends its transaction; transaction() only groups the code.`,
  repository: 'Every repository write is committed at once; transaction() only groups the code.',
})

function properties(context: Context, imports: KtImports, value: (info: TableInfo) => string): string[] {
  return context.tables.map((info) => {
    imports.add(qualified(packageOf(context, info, 'repository'), repositoryType(context, info)))
    return `    override val ${info.attr}: ${repositoryType(context, info)} = ${value(info)}`
  })
}

/** UnitOfWork, SqlUnitOfWork and MemoryUnitOfWork, in the base package. */
export function unitOfWorkFiles(context: Context): GeneratedFile[] {
  const pkg = context.base
  const settings = context.settings
  const interfaceImports = new KtImports(pkg)
  const members = context.tables.map((info) => {
    interfaceImports.add(qualified(packageOf(context, info, 'repository'), repositoryType(context, info)))
    return `    val ${info.attr}: ${repositoryType(context, info)}`
  })
  const files: GeneratedFile[] = [
    ktFile(pathOf(pkg, 'UnitOfWork'), pkg, interfaceImports.write(), [
      `/** What services depend on: a repository per table and a transaction. ${how(context)[settings.transactions]} */`,
      'interface UnitOfWork {',
      ...members,
      '',
      '    /** Runs work with the repositories of the transaction; commits when it ends, rolls back when it throws. */',
      '    fun <T> transaction(work: (UnitOfWork) -> T): T',
      '}',
    ]),
  ]
  const { holder } = context.orm
  const sqlImports = new KtImports(pkg).add(holder.ktImport)
  for (const info of context.tables) sqlImports.add(qualified(packageOf(context, info, 'repository'), sqlRepositoryClass(info)))
  const sqlProperties = properties(context, sqlImports, (info) => `${sqlRepositoryClass(info)}(${holder.name})`)
  const operation = settings.transactions === 'operation'
  const transaction = operation ? context.orm.transaction(sqlImports) : []
  files.push(
    ktFile(pathOf(pkg, 'SqlUnitOfWork'), pkg, sqlImports.write(), [
      `/** The repositories over one ${holder.text}, and its transaction. */`,
      `class SqlUnitOfWork(val ${holder.name}: ${holder.type}) : UnitOfWork {`,
      ...sqlProperties,
      '',
      operation
        ? '    /** Joins the transaction already open, or opens one. */'
        : `    /** ${settings.transactions === 'caller' ? `The transaction belongs to whoever holds the ${holder.text}` : 'Every write is committed at once'}: this only groups the code. */`,
      ...(operation ? transaction : ['    override fun <T> transaction(work: (UnitOfWork) -> T): T = work(this)']),
      '}',
    ]),
  )
  if (settings.memoryRepositories) {
    const imports = new KtImports(pkg)
    for (const info of context.tables) imports.add(qualified(packageOf(context, info, 'repository'), memoryRepositoryClass(info)))
    const memoryProperties = properties(context, imports, (info) => `${memoryRepositoryClass(info)}()`)
    files.push(
      ktFile(pathOf(pkg, 'MemoryUnitOfWork'), pkg, imports.write(), [
        '/** The in-memory repositories, for tests and for trying the services without a database. */',
        'class MemoryUnitOfWork : UnitOfWork {',
        ...memoryProperties,
        '',
        '    /** Memory has no transactions: changes are kept as they are made. */',
        '    override fun <T> transaction(work: (UnitOfWork) -> T): T = work(this)',
        '}',
      ]),
    )
  }
  return files
}
