/**
 * Storage of each resource in the Ktor project: the repository interface the service depends on, and the
 * implementation of the chosen persistence:
 * - `memory`: a map, to run the API without a database; it keeps copies, never the caller's objects
 * - `none`: every method calls `TODO()`, which the API answers with 501
 * - `exposed`: a table and a repository with Exposed, with filters and sorting written for each field
 */
import type { SpecField, SpecResource } from '../../../api/spec.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { KtImports, ktClass, ktDoc, ktHeader, ktString } from '../../languages/kotlin/kotlin.ts'
import { column, commonPackage, keyField, keyType, names, property, sourcePath, type KtorContext } from './context.ts'
import { serializerOf, storedAsJson } from './model.ts'

/** Whether a field can be filtered and sorted in the database: plain values, enums and single references. */
function queryable(field: SpecField): boolean {
  return !storedAsJson(field) && (field.type.kind === 'scalar' || field.type.kind === 'enum')
}

/** The Exposed column of a field, and how a value goes in and comes out of it. */
function columnOf(context: KtorContext, resource: SpecResource, field: SpecField, imports: KtImports) {
  const name = ktString(column(field))
  const keyColumn = (target: SpecResource) => {
    if (target.key.type.scalar === 'integer') return `long(${name})`
    if (target.key.type.scalar === 'uuid') {
      imports.add('org.jetbrains.exposed.v1.core.java.javaUUID')
      return `javaUUID(${name})`
    }
    return `varchar(${name}, ${keyField(target).constraints.maxLength ?? 191})`
  }
  const plain = (definition: string) => ({
    definition,
    write: (value: string) => value,
    read: (value: string) => value,
    match: (value: string) => value,
  })
  if (field.name === resource.key.field) {
    const definition = keyColumn(resource)
    return plain(resource.key.generated === 'increment' ? `${definition}.autoIncrement()` : definition)
  }
  if (storedAsJson(field)) {
    const serializer = serializerOf(context, field, imports)
    imports.add(`${commonPackage(context)}.JsonFormat`)
    return {
      definition: `text(${name}).nullable()`,
      write: (value: string) => `${value}?.let { JsonFormat.encodeToString(${serializer}, it) }`,
      read: (value: string) => `${value}?.let { JsonFormat.decodeFromString(${serializer}, it) }`,
      match: (value: string) => value,
    }
  }
  if (field.reference) {
    const target = context.spec.resources.find((item) => item.name === field.reference)!
    return plain(`${keyColumn(target)}.nullable()`)
  }
  const type = field.type
  if (type.kind === 'enum') {
    const item = context.spec.enums.find((entry) => entry.name === type.name)!
    const enumClass = ktClass(type.name)
    imports.add(`${context.layout.shared()}.${enumClass}`)
    if (item.valueType === 'integer')
      return {
        definition: `long(${name}).nullable()`,
        write: (value: string) => `${value}?.value`,
        read: (value: string) => `${value}?.let { ${enumClass}.fromValue(it) }`,
        match: (value: string) => `${value}.value`,
      }
    return {
      definition: `varchar(${name}, 64).nullable()`,
      write: (value: string) => `${value}?.name`,
      read: (value: string) => `${value}?.let { ${enumClass}.valueOf(it) }`,
      match: (value: string) => `${value}.name`,
    }
  }
  if (type.kind !== 'scalar') return plain(`text(${name}).nullable()`)
  const max = field.constraints.maxLength
  const text = max !== undefined && max <= 255 ? `varchar(${name}, ${max})` : `text(${name})`
  const time = (fn: string) => {
    imports.add(`org.jetbrains.exposed.v1.javatime.${fn}`)
    return `${fn}(${name})`
  }
  switch (type.scalar) {
    case 'integer':
      return plain(`${type.bits === 64 ? 'long' : 'integer'}(${name}).nullable()`)
    case 'float':
      return plain(`double(${name}).nullable()`)
    case 'decimal':
      return plain(`decimal(${name}, 18, 4).nullable()`)
    case 'boolean':
      return plain(`bool(${name}).nullable()`)
    case 'date':
      return plain(`${time('date')}.nullable()`)
    case 'datetime':
      return plain(`${time('timestamp')}.nullable()`)
    case 'uuid':
      imports.add('org.jetbrains.exposed.v1.core.java.javaUUID')
      return plain(`javaUUID(${name}).nullable()`)
    case 'time':
      return plain(`varchar(${name}, 32).nullable()`)
    default:
      return plain(`${text}.nullable()`)
  }
}

export function repositoryFiles(context: KtorContext, resource: SpecResource): GeneratedFile[] {
  const pkg = context.layout.resource(resource, 'repository')
  const name = names(resource)
  const common = commonPackage(context)
  const model = `${context.layout.resource(resource, 'model')}.${name.type}`
  const key = keyType(resource)
  const keyProperty = property(keyField(resource))
  const file = (className: string, imports: KtImports, body: (string | false | string[])[]) => ({
    path: sourcePath(pkg, className),
    content: fileText(lines(...ktHeader(pkg, imports), ...body)),
  })
  const keyImport = (imports: KtImports) => (key === 'JsonUuid' ? imports.add(`${common}.JsonUuid`) : imports)
  const files: GeneratedFile[] = []

  files.push(
    file(name.repository, keyImport(new KtImports(pkg).add(model, `${common}.ListQuery`, `${common}.ListResult`)), [
      ktDoc(`Where ${resource.plural} are kept. The service depends only on this interface.`),
      `interface ${name.repository} {`,
      '    /** Items equal to every filter, in order, within the window; and how many match. */',
      `    suspend fun list(query: ListQuery): ListResult<${name.type}>`,
      '',
      '    /** The item with this key, or null when there is none. */',
      `    suspend fun get(key: ${key}): ${name.type}?`,
      '',
      `    /** Stores a new item${resource.key.generated ? ' and assigns its key' : ''}; returns it as stored. */`,
      `    suspend fun add(item: ${name.type}): ${name.type}`,
      '',
      '    /** Stores the new state of an existing item and returns it. */',
      `    suspend fun update(item: ${name.type}): ${name.type}`,
      '',
      '    /** Removes an existing item. */',
      `    suspend fun delete(key: ${key})`,
      '}',
    ]),
  )

  if (context.pending) {
    const message = ktString(`The storage of ${resource.plural} is not written yet`)
    const method = (signature: string) => [
      `    override suspend fun ${signature} {`,
      `        // TODO: store ${resource.plural} in your database`,
      `        TODO(${message})`,
      '    }',
    ]
    files.push(
      file(name.pendingRepository, keyImport(new KtImports(pkg).add(model, `${common}.ListQuery`, `${common}.ListResult`)), [
        ktDoc(`Storage of ${resource.plural} to write: every method answers 501 until it is implemented.`),
        `class ${name.pendingRepository} : ${name.repository} {`,
        method(`list(query: ListQuery): ListResult<${name.type}>`),
        '',
        method(`get(key: ${key}): ${name.type}?`),
        '',
        method(`add(item: ${name.type}): ${name.type}`),
        '',
        method(`update(item: ${name.type}): ${name.type}`),
        '',
        method(`delete(key: ${key})`),
        '}',
      ]),
    )
    return files
  }

  const generated = resource.key.generated
  if (!context.exposed) {
    const imports = keyImport(
      new KtImports(pkg).add(
        model,
        `${common}.ListQuery`,
        `${common}.ListResult`,
        `${common}.compareFieldValues`,
        `${common}.sameValue`,
        'java.util.concurrent.ConcurrentHashMap',
      ),
    )
    if (generated === 'increment') imports.add('java.util.concurrent.atomic.AtomicLong')
    if (generated === 'uuid') imports.add('java.util.UUID')
    const assign =
      generated === 'increment'
        ? `        val stored = item.copy(${keyProperty} = lastKey.incrementAndGet())`
        : generated === 'uuid'
          ? `        val stored = item.copy(${keyProperty} = ${key === 'JsonUuid' ? 'UUID.randomUUID()' : 'UUID.randomUUID().toString()'})`
          : '        val stored = item.copy()'
    files.push(
      file(name.memory, imports, [
        ktDoc(`Keeps ${resource.plural} in memory: they are lost when the application stops. Use it to try the API.`),
        `class ${name.memory} : ${name.repository} {`,
        `    private val items = ConcurrentHashMap<${key}, ${name.type}>()`,
        generated === 'increment' && '    private val lastKey = AtomicLong()',
        '',
        '    /** The value of a field by its JSON name, for filters and sorting. */',
        `    private fun value(item: ${name.type}, field: String): Any? = when (field) {`,
        resource.fields.map((field) => `        ${ktString(field.wire)} -> item.${property(field)}`),
        '        else -> null',
        '    }',
        '',
        `    override suspend fun list(query: ListQuery): ListResult<${name.type}> {`,
        '        var found = items.values',
        '            .filter { item -> query.filters.all { (field, value) -> sameValue(value(item, field), value) } }',
        `            .sortedWith { a, b -> compareFieldValues(a.${keyProperty}, b.${keyProperty}) }`,
        '        val field = query.sortField',
        '        if (field != null) {',
        '            val present = found.filter { value(it, field) != null }',
        '                .sortedWith { a, b -> compareFieldValues(value(a, field), value(b, field)) }',
        '            // Items without a value go last, whatever the order',
        '            found = (if (query.descending) present.reversed() else present) + found.filter { value(it, field) == null }',
        '        }',
        '        val window = found.drop(query.offset).let { if (query.limit == null) it else it.take(query.limit) }',
        '        return ListResult(window.map { it.copy() }, found.size.toLong())',
        '    }',
        '',
        `    override suspend fun get(key: ${key}): ${name.type}? = items[key]?.copy()`,
        '',
        `    override suspend fun add(item: ${name.type}): ${name.type} {`,
        assign,
        `        items[stored.${keyProperty}] = stored`,
        '        return stored.copy()',
        '    }',
        '',
        `    override suspend fun update(item: ${name.type}): ${name.type} {`,
        `        items[item.${keyProperty}] = item.copy()`,
        '        return item.copy()',
        '    }',
        '',
        `    override suspend fun delete(key: ${key}) {`,
        '        items.remove(key)',
        '    }',
        '}',
      ]),
    )
    return files
  }

  const imports = keyImport(
    new KtImports(pkg).add(
      model,
      `${common}.ListQuery`,
      `${common}.ListResult`,
      'org.jetbrains.exposed.v1.core.ResultRow',
      'org.jetbrains.exposed.v1.core.SortOrder',
      'org.jetbrains.exposed.v1.core.Table',
      'org.jetbrains.exposed.v1.core.eq',
      'org.jetbrains.exposed.v1.core.statements.UpdateBuilder',
      'org.jetbrains.exposed.v1.jdbc.Database',
      'org.jetbrains.exposed.v1.jdbc.andWhere',
      'org.jetbrains.exposed.v1.jdbc.deleteWhere',
      'org.jetbrains.exposed.v1.jdbc.insert',
      'org.jetbrains.exposed.v1.jdbc.selectAll',
      'org.jetbrains.exposed.v1.jdbc.transactions.suspendTransaction',
      'org.jetbrains.exposed.v1.jdbc.update',
    ),
  )
  if (generated === 'uuid') imports.add('java.util.UUID')
  const columns = resource.fields.map((field) => ({ field, ...columnOf(context, resource, field, imports) }))
  const table = name.table
  const keyColumn = `${table}.${keyProperty}`
  const filters = columns
    .filter(({ field }) => queryable(field))
    .map(({ field, match }) => {
      const type = field.name === resource.key.field ? key : null
      const cast = type ?? castOf(context, field, imports)
      return `                ${ktString(field.wire)} -> select.andWhere { ${table}.${property(field)} eq ${match(`(value as ${cast})`)} }`
    })
  const sorts = columns
    .filter(({ field }) => queryable(field))
    .map(({ field }) => `            ${ktString(field.wire)} -> ${table}.${property(field)}`)
  const assigned = generated === 'uuid' ? `${key === 'JsonUuid' ? 'UUID.randomUUID()' : 'UUID.randomUUID().toString()'}` : null
  files.push(
    file(name.exposedRepository, imports, [
      ktDoc(`The ${name.sqlTable} table.`),
      `object ${table} : Table(${ktString(name.sqlTable)}) {`,
      columns.map(({ field, definition }) => `    val ${property(field)} = ${definition}`),
      '',
      `    override val primaryKey = PrimaryKey(${keyProperty})`,
      '}',
      '',
      ktDoc(`Keeps ${resource.plural} in the database with Exposed.`),
      `class ${name.exposedRepository}(private val database: Database) : ${name.repository} {`,
      `    override suspend fun list(query: ListQuery): ListResult<${name.type}> = suspendTransaction(database) {`,
      `        val select = ${table}.selectAll()`,
      '        for ((field, value) in query.filters) {',
      '            when (field) {',
      filters,
      '            }',
      '        }',
      '        val total = select.count()',
      '        val sorted = when (query.sortField) {',
      sorts,
      '            else -> null',
      '        }',
      '        // Items without a value go last, whatever the order; the key breaks ties',
      '        if (sorted != null) select.orderBy(sorted, if (query.descending) SortOrder.DESC_NULLS_LAST else SortOrder.ASC_NULLS_LAST)',
      `        select.orderBy(${keyColumn}, SortOrder.ASC)`,
      '        if (query.limit != null) select.limit(query.limit).offset(query.offset.toLong())',
      '        ListResult(select.map(::toItem), total)',
      '    }',
      '',
      `    override suspend fun get(key: ${key}): ${name.type}? = suspendTransaction(database) {`,
      `        ${table}.selectAll().where { ${keyColumn} eq key }.singleOrNull()?.let(::toItem)`,
      '    }',
      '',
      `    override suspend fun add(item: ${name.type}): ${name.type} {`,
      '        val key = suspendTransaction(database) {',
      generated === 'increment'
        ? [`            ${table}.insert { fill(it, item) } get ${keyColumn}`]
        : [
            `            val key = ${assigned ?? `item.${keyProperty}`}`,
            `            ${table}.insert {`,
            `                it[${keyColumn}] = key`,
            '                fill(it, item)',
            '            }',
            '            key',
          ],
      '        }',
      '        // Read back, so the answer has what the database keeps',
      '        return get(key)!!',
      '    }',
      '',
      `    override suspend fun update(item: ${name.type}): ${name.type} {`,
      `        suspendTransaction(database) { ${table}.update({ ${keyColumn} eq item.${keyProperty} }) { fill(it, item) } }`,
      `        return get(item.${keyProperty})!!`,
      '    }',
      '',
      `    override suspend fun delete(key: ${key}) {`,
      `        suspendTransaction(database) { ${table}.deleteWhere { ${keyColumn} eq key } }`,
      '    }',
      '',
      '    /** Every column but the key takes the value of the item. */',
      `    private fun fill(row: UpdateBuilder<*>, item: ${name.type}) {`,
      columns
        .filter(({ field }) => field.name !== resource.key.field)
        .map(({ field, write }) => `        row[${table}.${property(field)}] = ${write(`item.${property(field)}`)}`),
      '    }',
      '',
      `    private fun toItem(row: ResultRow) = ${name.type}(`,
      columns.map(({ field, read }) => `        ${property(field)} = ${read(`row[${table}.${property(field)}]`)},`),
      '    )',
      '}',
    ]),
  )
  return files
}

/** The Kotlin type a filter value has, for the cast before comparing it with its column. */
function castOf(context: KtorContext, field: SpecField, imports: KtImports): string {
  if (field.reference) {
    const target = context.spec.resources.find((item) => item.name === field.reference)!
    const key = keyType(target)
    if (key === 'JsonUuid') imports.add(`${commonPackage(context)}.JsonUuid`)
    return key
  }
  const type = field.type
  if (type.kind === 'enum') return ktClass(type.name)
  if (type.kind !== 'scalar') return 'String'
  switch (type.scalar) {
    case 'integer':
      return type.bits === 64 ? 'Long' : 'Int'
    case 'float':
      return 'Double'
    case 'boolean':
      return 'Boolean'
    case 'decimal':
      imports.add('java.math.BigDecimal')
      return 'BigDecimal'
    case 'date':
      imports.add('java.time.LocalDate')
      return 'LocalDate'
    case 'datetime':
      imports.add('java.time.Instant')
      return 'Instant'
    case 'uuid':
      imports.add('java.util.UUID')
      return 'UUID'
    default:
      return 'String'
  }
}
