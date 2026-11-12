/**
 * The repositories of each table: the interface services depend on (when the settings want one), its JPA
 * implementation over an EntityManager (JPQL reads that leave out rows marked as deleted, writes flushed at once so a
 * database refusal becomes a ConflictException, values the database fills read back after an insert), and its
 * in-memory one, with the same methods. Repositories decide nothing.
 */
import type { GeneratedFile } from '../../export/files.ts'
import { lines, type Line } from '../types.ts'
import { javaPath, javaString, JavaImports } from './java.ts'
import {
  columnOf,
  commonPackage,
  jpqlName,
  errorsPackage,
  memoryRepositoryClass,
  packageOf,
  qualified,
  queryName,
  repositoryInterface,
  sqlRepositoryClass,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import type { QueryDesign } from '../../crud/types.ts'

export interface Method {
  query: QueryDesign
  name: string
  params: { name: string; type: string }[]
  returns: string
  doc: string
}

/** The methods of a table's repository, with their Java signatures. */
export function repositoryMethods(context: Context, info: TableInfo, imports: JavaImports): Method[] {
  const entity = info.entity
  const methods: Method[] = []
  for (const query of info.queries) {
    const name = queryName(context, query)
    const byColumns = query.columns.map((column) => ({ name: columnOf(info, column).prop, type: columnOf(info, column).java }))
    for (const column of query.columns) {
      const javaImport = columnOf(info, column).javaImport
      if (javaImport) imports.add(javaImport)
    }
    const add = (params: Method['params'], returns: string, doc: string) => methods.push({ query, name, params, returns, doc })
    switch (query.kind) {
      case 'getByKey':
        imports.add('java.util.Optional')
        add(byColumns, `Optional<${entity}>`, 'The row with this primary key, if there is one.')
        break
      case 'findByUnique':
        imports.add('java.util.Optional')
        add(byColumns, `Optional<${entity}>`, `The row with this ${query.columns.join(' and ')}, if there is one.`)
        break
      case 'listByParent':
      case 'findAllBy':
        imports.add('java.util.List')
        add(byColumns, `List<${entity}>`, `Rows with this ${query.columns.join(' and ')}, by primary key.`)
        break
      case 'list':
        if (context.settings.paging === 'offset') {
          imports.add(`${commonPackage(context)}.Page`)
          add(
            [
              { name: 'offset', type: 'int' },
              { name: 'limit', type: 'int' },
            ],
            `Page<${entity}>`,
            'At most limit rows from offset, by primary key, and how many there are.',
          )
        } else if (context.settings.paging === 'cursor') {
          imports.add(`${commonPackage(context)}.CursorPage`, 'java.util.List')
          add(
            [
              { name: 'after', type: 'List<Object>' },
              { name: 'limit', type: 'int' },
            ],
            `CursorPage<${entity}>`,
            'At most limit rows after the key after (null for the first page), by primary key, and the key to read the next page from.',
          )
        } else {
          imports.add('java.util.List')
          add([], `List<${entity}>`, 'Every row, by primary key.')
        }
        break
      case 'insert':
        add([{ name: 'entity', type: entity }], entity, 'Stores a new row; the values the database fills are read back.')
        break
      case 'update':
        add([{ name: 'entity', type: entity }], entity, 'Stores the changes made to a row read from this repository.')
        break
      case 'delete':
        add([{ name: 'entity', type: entity }], 'void', 'Removes a row read from this repository.')
        break
    }
  }
  return methods
}

const signature = (method: Method) =>
  `${method.returns} ${method.name}(${method.params.map((param) => `${param.type} ${param.name}`).join(', ')})`

// JPA

/** JPQL that leaves out rows marked as deleted. */
function softCondition(info: TableInfo): string | null {
  if (!info.soft) return null
  return info.soft.column.type.kind === 'boolean' ? `e.${info.soft.prop} = false` : `e.${info.soft.prop} is null`
}

const order = (info: TableInfo) => ` order by ${info.key.map((column) => `e.${column.prop}`).join(', ')}`

function where(conditions: (string | null)[]): string {
  const present = conditions.filter((item): item is string => item !== null)
  return present.length > 0 ? ` where ${present.join(' and ')}` : ''
}

const byParams = (columns: ColumnInfo[]) => columns.map((column) => `e.${column.prop} = :${column.prop}`)
const parameters = (columns: ColumnInfo[]) => columns.map((column) => `.setParameter("${column.prop}", ${column.prop})`).join('')

/** A write, flushed at once, with a database refusal turned into a ConflictException. */
function write(context: Context, info: TableInfo, action: string[], imports: JavaImports): Line[] {
  imports.add('jakarta.persistence.PersistenceException', `${errorsPackage(context)}.ConflictException`)
  return [
    'try {',
    ...(context.settings.transactions === 'caller'
      ? action.map((line) => `    ${line}`)
      : ['    inTransaction(() -> {', ...action.map((line) => `        ${line}`), '    });']),
    '} catch (PersistenceException error) {',
    `    throw new ConflictException("${info.entity}", "the database refused the change: " + error.getMessage());`,
    '}',
  ]
}

function jpaBody(context: Context, info: TableInfo, method: Method, imports: JavaImports): Line[] {
  const entity = info.entity
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const soft = softCondition(info)
  const select = (conditions: (string | null)[]) => `"select e from ${jpqlName(info)} e${where(conditions)}`
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [
        `return entityManager.createQuery(${select([...byParams(columns), soft])}", ${entity}.class)${parameters(columns)}`,
        '        .getResultStream()',
        '        .findFirst();',
      ]
    case 'listByParent':
    case 'findAllBy':
      return [
        `return entityManager.createQuery(${select([...byParams(columns), soft])}${order(info)}", ${entity}.class)${parameters(columns)}.getResultList();`,
      ]
    case 'list': {
      if (context.settings.paging === 'offset') {
        imports.add('java.util.List')
        return [
          `List<${entity}> items = entityManager.createQuery(${select([soft])}${order(info)}", ${entity}.class)`,
          '        .setFirstResult(offset)',
          '        .setMaxResults(limit)',
          '        .getResultList();',
          `long total = entityManager.createQuery("select count(e) from ${jpqlName(info)} e${where([soft])}", Long.class).getSingleResult();`,
          'return new Page<>(items, total, offset, limit);',
        ]
      }
      if (context.settings.paging === 'cursor') {
        imports.add('java.util.ArrayList', 'java.util.List')
        // After the key (a, b): a greater, or a the same and b greater
        const key = info.key
        const after = key
          .map((column, index) =>
            [...key.slice(0, index).map((before) => `e.${before.prop} = :k${key.indexOf(before)}`), `e.${column.prop} > :k${index}`].join(
              ' and ',
            ),
          )
          .map((item) => (key.length > 1 ? `(${item})` : item))
          .join(' or ')
        const conditions = [soft, `(${after})`].filter((item): item is string => item !== null)
        return [
          `String jpql = after == null ? ${select([soft])}${order(info)}" : ${select(conditions)}${order(info)}";`,
          `var query = entityManager.createQuery(jpql, ${entity}.class).setMaxResults(limit + 1);`,
          ...key.map((_, index) => `if (after != null) query.setParameter("k${index}", after.get(${index}));`),
          `List<${entity}> rows = query.getResultList();`,
          `List<${entity}> items = new ArrayList<>(rows.subList(0, Math.min(limit, rows.size())));`,
          `${entity} last = items.isEmpty() ? null : items.get(items.size() - 1);`,
          `return new CursorPage<>(items, rows.size() > limit ? List.of(${key.map((column) => `last.${column.getter}()`).join(', ')}) : null);`,
        ]
      }
      return [`return entityManager.createQuery(${select([soft])}${order(info)}", ${entity}.class).getResultList();`]
    }
    case 'insert':
      return [
        ...write(
          context,
          info,
          [
            'entityManager.persist(entity);',
            'entityManager.flush();',
            '// Reads back what the database filled: the key, defaults',
            'entityManager.refresh(entity);',
          ],
          imports,
        ),
        'return entity;',
      ]
    case 'update':
      return [
        `${entity}[] stored = new ${entity}[1];`,
        ...write(context, info, ['stored[0] = entityManager.merge(entity);', 'entityManager.flush();'], imports),
        'return stored[0];',
      ]
    case 'delete':
      return write(
        context,
        info,
        ['entityManager.remove(entityManager.contains(entity) ? entity : entityManager.merge(entity));', 'entityManager.flush();'],
        imports,
      )
    default:
      return ['throw new UnsupportedOperationException();']
  }
}

// In memory

/** A default value of the database as a Java literal of the column's type. */
function literalOf(java: string, value: string): string {
  if (java === 'Long') return `${value}L`
  if (java === 'Short') return `(short) ${value}`
  if (java === 'BigDecimal') return `new BigDecimal(${javaString(value)})`
  if (java === 'String') return javaString(value)
  if (java === 'Double') return value.includes('.') ? value : `${value}.0`
  if (java === 'Float') return `${value}f`
  return value
}

function memoryFill(column: ColumnInfo, imports: JavaImports): string | null {
  const db = column.column
  const unset = `entity.${column.getter}() == null`
  const set = (value: string) => `if (${unset}) entity.${column.setter}(${value});`
  if (db.generated === 'identity')
    return set(column.java === 'Long' ? 'nextId++' : column.java === 'Short' ? '(short) nextId++' : '(int) nextId++')
  if (db.generated === 'uuid') return set('UUID.randomUUID()')
  if (db.generated === 'now' || db.generated === 'onUpdateNow') {
    const now = column.java === 'OffsetDateTime' ? 'OffsetDateTime.now(ZoneOffset.UTC)' : `${column.java}.now()`
    if (column.java === 'OffsetDateTime') imports.add('java.time.ZoneOffset')
    return set(now)
  }
  if (db.default?.kind === 'literal' && db.default.value !== null) return set(literalOf(column.java, String(db.default.value)))
  return null
}

function memoryVisible(info: TableInfo): string {
  if (!info.soft) return 'true'
  return info.soft.column.type.kind === 'boolean' ? `!Boolean.TRUE.equals(row.${info.soft.getter}())` : `row.${info.soft.getter}() == null`
}

function memoryBody(context: Context, info: TableInfo, method: Method): Line[] {
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const conditions = columns.map((column) => `Objects.equals(row.${column.getter}(), ${column.prop})`).join(' && ')
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`return visible().filter((row) -> ${conditions}).findFirst();`]
    case 'listByParent':
    case 'findAllBy':
      return [`return visible().filter((row) -> ${conditions}).toList();`]
    case 'list':
      if (context.settings.paging === 'offset')
        return [
          `List<${info.entity}> rows = visible().toList();`,
          'return new Page<>(rows.stream().skip(offset).limit(limit).toList(), rows.size(), offset, limit);',
        ]
      if (context.settings.paging === 'cursor')
        return [
          `List<${info.entity}> rows = visible().filter((row) -> after == null || compareKeys(keyOf(row), after) > 0).toList();`,
          `List<${info.entity}> items = rows.stream().limit(limit).toList();`,
          'return new CursorPage<>(items, rows.size() > limit ? keyOf(items.get(items.size() - 1)) : null);',
        ]
      return ['return visible().toList();']
    case 'insert':
    case 'update':
      return ['rows.put(keyOf(entity), entity);', 'return entity;']
    case 'delete':
      return ['rows.remove(keyOf(entity));']
    default:
      return ['throw new UnsupportedOperationException();']
  }
}

function block(method: Method, body: Line[], override: boolean): Line[] {
  return [
    '',
    override ? '    @Override' : `    /** ${method.doc} */`,
    `    public ${signature(method)} {`,
    ...body.map((line) => (typeof line === 'string' ? `        ${line}` : line)),
    '    }',
  ]
}

export function repositoryFiles(context: Context, info: TableInfo): GeneratedFile[] {
  const pkg = packageOf(context, info, 'repository')
  const entityImport = qualified(context, info, 'entity', info.entity)
  const interfaces = context.settings.repositoryInterfaces
  const files: GeneratedFile[] = []
  const unit = (name: string, imports: JavaImports, body: (Line | Line[])[]) => ({
    path: javaPath(pkg, name),
    content: lines(`package ${pkg};`, '', imports.write(), '', ...body, ''),
  })
  if (interfaces) {
    const imports = new JavaImports(pkg).add(entityImport)
    const methods = repositoryMethods(context, info, imports)
    files.push(
      unit(repositoryInterface(info), imports, [
        `/** Where ${info.name} rows are kept. Services depend only on this interface. */`,
        `public interface ${repositoryInterface(info)} {`,
        ...methods.flatMap((method, index) => [index > 0 ? '' : null, `    /** ${method.doc} */`, `    ${signature(method)};`]),
        '}',
      ]),
    )
  }
  // JPA
  {
    const imports = new JavaImports(pkg).add(entityImport, 'jakarta.persistence.EntityManager')
    const methods = repositoryMethods(context, info, imports)
    const bodies = methods.map((method) => block(method, jpaBody(context, info, method, imports), interfaces))
    const owns = context.settings.transactions !== 'caller'
    if (owns) imports.add('jakarta.persistence.EntityTransaction')
    files.push(
      unit(sqlRepositoryClass(info), imports, [
        `/** Keeps ${info.name} rows in the database, through an EntityManager. ${
          context.settings.transactions === 'caller'
            ? 'It never commits: writes run in the transaction of whoever holds the EntityManager.'
            : 'A write joins the transaction already open, or commits at once.'
        } */`,
        `public class ${sqlRepositoryClass(info)}${interfaces ? ` implements ${repositoryInterface(info)}` : ''} {`,
        '    protected final EntityManager entityManager;',
        '',
        `    public ${sqlRepositoryClass(info)}(EntityManager entityManager) {`,
        '        this.entityManager = entityManager;',
        '    }',
        ...bodies.flat(),
        owns && [
          '',
          '    /** Runs a write in the transaction already open, or in one of its own. */',
          '    private void inTransaction(Runnable write) {',
          '        EntityTransaction transaction = entityManager.getTransaction();',
          '        if (transaction.isActive()) {',
          '            write.run();',
          '            return;',
          '        }',
          '        transaction.begin();',
          '        try {',
          '            write.run();',
          '            transaction.commit();',
          '        } catch (RuntimeException error) {',
          '            if (transaction.isActive()) transaction.rollback();',
          '            throw error;',
          '        }',
          '    }',
        ],
        '}',
      ]),
    )
  }
  if (context.settings.memoryRepositories) {
    const imports = new JavaImports(pkg).add(
      entityImport,
      'java.util.ArrayList',
      'java.util.Comparator',
      'java.util.LinkedHashMap',
      'java.util.List',
      'java.util.Map',
      'java.util.Objects',
      'java.util.stream.Stream',
    )
    const methods = repositoryMethods(context, info, imports)
    const fills = info.columns.map((column) => memoryFill(column, imports)).filter((line): line is string => line !== null)
    for (const column of info.columns) if (column.javaImport) imports.add(column.javaImport)
    const bodies = methods.map((method) => {
      const body = memoryBody(context, info, method)
      return block(method, method.query.kind === 'insert' ? [...fills, ...body] : body, true)
    })
    const identity = info.columns.some((column) => column.column.generated === 'identity')
    files.push(
      unit(memoryRepositoryClass(info), imports, [
        `/** Keeps ${info.name} rows in memory, for tests and for trying the services without a database. */`,
        interfaces
          ? `public class ${memoryRepositoryClass(info)} implements ${repositoryInterface(info)} {`
          : `public class ${memoryRepositoryClass(info)} extends ${sqlRepositoryClass(info)} {`,
        '    private final Map<List<Object>, ' + info.entity + '> rows = new LinkedHashMap<>();',
        identity && '    private long nextId = 1;',
        !interfaces && ['', `    public ${memoryRepositoryClass(info)}() {`, '        super(null);', '    }'],
        '',
        '    /** The key of a row, as a list of its key values. */',
        `    private static List<Object> keyOf(${info.entity} row) {`,
        `        List<Object> key = new ArrayList<>();`,
        ...info.key.map((column) => `        key.add(row.${column.getter}());`),
        '        return key;',
        '    }',
        '',
        '    /** Orders two keys value by value. */',
        '    @SuppressWarnings({"unchecked", "rawtypes"})',
        '    private static int compareKeys(List<Object> a, List<Object> b) {',
        '        for (int index = 0; index < a.size(); index++) {',
        '            int order = ((Comparable) a.get(index)).compareTo(b.get(index));',
        '            if (order != 0) return order;',
        '        }',
        '        return 0;',
        '    }',
        '',
        `    private Stream<${info.entity}> visible() {`,
        `        return rows.values().stream().filter((row) -> ${memoryVisible(info)}).sorted(Comparator.comparing(${memoryRepositoryClass(info)}::keyOf, ${memoryRepositoryClass(info)}::compareKeys));`,
        '    }',
        ...bodies.flat(),
        '}',
      ]),
    )
  }
  return files
}
