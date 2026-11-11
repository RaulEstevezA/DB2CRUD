/**
 * The bodies of the SQLAlchemy repositories: select() queries with the soft-delete filter, pages by offset or
 * cursor, and writes that flush (and commit, when every write is its own transaction) and turn a database
 * refusal into a ConflictError.
 */
import type { Line } from '../../types.ts'
import type { Imports } from '../python.ts'
import { aw, type Context, type TableInfo } from '../common/context.ts'
import type { RepositoryMethod } from '../common/orm.ts'

/** The filter that leaves out rows marked as deleted. */
function softFilter(info: TableInfo): string | null {
  if (!info.soft) return null
  const attr = `${info.entity}.${info.soft.attr}`
  return info.soft.column.type.kind === 'boolean' ? `${attr}.is_(False)` : `${attr}.is_(None)`
}

function where(info: TableInfo, conditions: string[]): string {
  const all = [...conditions, softFilter(info)].filter((item): item is string => item !== null)
  return all.length > 0 ? `.where(${all.join(', ')})` : ''
}

const keyColumns = (info: TableInfo) => info.key.map((column) => `${info.entity}.${column.attr}`).join(', ')

export function sqlBody(context: Context, info: TableInfo, method: RepositoryMethod, imports: Imports): Line[] {
  const a = aw(context)
  const entity = info.entity
  const equals = method.params.map((param) => `${entity}.${param.name} == ${param.name}`)
  const commit = context.settings.transactions === 'repository'
  const write = (action: string): Line[] => {
    imports.from('sqlalchemy.exc', 'IntegrityError').from('app.errors', 'ConflictError')
    return [
      action,
      'try:',
      `    ${a}self._session.flush()`,
      'except IntegrityError as error:',
      `    ${a}self._session.rollback()`,
      `    raise ConflictError("${entity}", "the database refused the change: " + str(error.orig)) from error`,
      commit && `${a}self._session.commit()`,
    ]
  }
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      imports.from('sqlalchemy', 'select')
      return [`return (${a}self._session.scalars(select(${entity})${where(info, equals)})).first()`]
    case 'listByParent':
    case 'findAllBy':
      imports.from('sqlalchemy', 'select')
      return [`return list((${a}self._session.scalars(select(${entity})${where(info, equals)}.order_by(${keyColumns(info)}))).all())`]
    case 'list': {
      imports.from('sqlalchemy', 'select')
      const base = `query = select(${entity})${where(info, [])}`
      if (context.settings.paging === 'offset') {
        imports.from('sqlalchemy', 'func')
        return [
          base,
          `total = ${a}self._session.scalar(select(func.count()).select_from(query.subquery())) or 0`,
          `rows = (${a}self._session.scalars(query.order_by(${keyColumns(info)}).offset(offset).limit(limit))).all()`,
          'return Page(items=list(rows), total=total, offset=offset, limit=limit)',
        ]
      }
      if (context.settings.paging === 'cursor') {
        const single = info.key.length === 1
        if (!single) imports.from('sqlalchemy', 'tuple_')
        const after = single ? `${entity}.${info.key[0].attr} > after[0]` : `tuple_(${keyColumns(info)}) > tuple_(*after)`
        return [
          base,
          'if after is not None:',
          `    query = query.where(${after})`,
          `rows = list((${a}self._session.scalars(query.order_by(${keyColumns(info)}).limit(limit + 1))).all())`,
          'more = len(rows) > limit',
          'rows = rows[:limit]',
          `last = (${info.key.map((column) => `rows[-1].${column.attr}`).join(', ')},) if more else None`,
          'return CursorPage(items=rows, next=last)',
        ]
      }
      return [base, `return list((${a}self._session.scalars(query.order_by(${keyColumns(info)}))).all())`]
    }
    case 'insert':
      return [...write('self._session.add(entity)'), `${a}self._session.refresh(entity)`, 'return entity']
    case 'update':
      return [...write('self._session.add(entity)'), `${a}self._session.refresh(entity)`, 'return entity']
    case 'delete':
      return write(`${a}self._session.delete(entity)`)
    default:
      return ['raise NotImplementedError']
  }
}
