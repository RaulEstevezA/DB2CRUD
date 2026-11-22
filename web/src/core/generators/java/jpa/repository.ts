/**
 * The JPA repositories, over an EntityManager: JPQL reads that leave out rows marked as deleted, writes flushed at once
 * so a database refusal becomes a ConflictException, and the values the database fills read back after an insert.
 */
import type { Line } from '../../types.ts'
import type { JavaImports } from '../java.ts'
import { columnOf, errorsPackage, jpqlName, sqlRepositoryClass, type ColumnInfo, type Context, type TableInfo } from '../context.ts'
import type { Method } from '../repositories.ts'

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

export function jpaBody(context: Context, info: TableInfo, method: Method, imports: JavaImports): Line[] {
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

/** The EntityManager of the repository, and its constructor. */
export function jpaHead(context: Context, info: TableInfo, imports: JavaImports): Line[] {
  imports.add('jakarta.persistence.EntityManager')
  if (context.settings.transactions !== 'caller') imports.add('jakarta.persistence.EntityTransaction')
  return [
    '    protected final EntityManager entityManager;',
    '',
    `    public ${sqlRepositoryClass(info)}(EntityManager entityManager) {`,
    '        this.entityManager = entityManager;',
    '    }',
  ]
}

/** Runs a write in the transaction already open, or in one of its own, unless the caller owns the transaction. */
export function jpaTail(context: Context): Line[] {
  if (context.settings.transactions === 'caller') return []
  return [
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
  ]
}
