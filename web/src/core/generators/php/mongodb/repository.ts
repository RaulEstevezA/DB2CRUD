/**
 * The database repositories over Db: reads leave out documents marked as deleted, a change writes only the fields that
 * are not as they were read (so two people changing different fields do not undo each other, and the ones the entity
 * does not know are kept), and one item of a list is added or removed in the database.
 */
import { isObjectId } from '../../../schema/documents.ts'
import type { Line } from '../../types.ts'
import { columnOf, query, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'
import { identifiedLists, listOf } from '../common/documents.ts'
import { access, phpString, type PhpUses } from '../common/php.ts'
import { memoryFill, type RepositoryMethod } from '../common/repositories.ts'
import { shapeLines, stored } from './shapes.ts'

const changeable = (info: TableInfo, column: ColumnInfo) =>
  !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

const updates = (info: TableInfo) => query(info, 'update') !== undefined && info.columns.some((column) => changeable(info, column))
const touchedBy = (info: TableInfo) => info.columns.filter(({ column }) => column.generated === 'onUpdateNow')

const equal = (column: ColumnInfo, value: string) => `${phpString(column.column.name)} => ${stored(column.column.type, value)}`

const softCondition = (info: TableInfo): string[] => {
  if (!info.soft) return []
  return [`${phpString(info.soft.column.name)} => ${info.soft.column.type.kind === 'boolean' ? "['$ne' => true]" : 'null'}`]
}

const filter = (conditions: string[]) => `[${conditions.join(', ')}]`

/** What a text that is not an identifier finds. */
const guards = (columns: ColumnInfo[], nothing: string) =>
  columns
    .filter((column) => isObjectId(column.column.type))
    .flatMap((column) => [`if (!Documents::isId($${column.field})) {`, `    return ${nothing};`, '}'])

const byKey = (info: TableInfo) => `['sort' => [${phpString(info.key[0].column.name)} => 1]]`

export function init(context: Context, info: TableInfo, uses: PhpUses): Line[] {
  uses.add(`${context.base}\\Db`, `${context.base}\\Documents`)
  return [
    '    /** What each field is in MongoDB, when it is not what PHP has */',
    ...shapeLines(info),
    ...(updates(info)
      ? [
          '',
          '    /** The fields a change may write */',
          `    private const FIELDS = [${info.columns
            .filter((column) => changeable(info, column))
            .map((column) => phpString(column.column.name))
            .join(', ')}];`,
          '',
          '    /**',
          '     * The document each entity was read from: a change writes only the fields that differ.',
          '     *',
          `     * @var \\WeakMap<${info.entity}, array<string, mixed>>|null`,
          '     */',
          '    private static ?\\WeakMap $read = null;',
        ]
      : []),
    '',
    '    public function __construct(private readonly Db $db)',
    '    {',
    '    }',
  ]
}

export function helpers(_context: Context, info: TableInfo): Line[] {
  const entity = info.entity
  return [
    '    /**',
    `     * The ${entity} of a document.`,
    '     *',
    '     * @param array<string, mixed> $document',
    '     */',
    `    private static function entity(array $document): ${entity}`,
    '    {',
    `        $entity = new ${entity}();`,
    ...info.columns.map(
      ({ column, prop }) =>
        `        ${access('$entity', prop)} = Documents::fromBson($document[${phpString(column.name)}] ?? null, self::SHAPE[${phpString(column.name)}]);`,
    ),
    updates(info) ? '        return self::loaded($entity);' : '        return $entity;',
    '    }',
    '',
    '    /**',
    `     * The document of a ${entity}: what is null is left out.`,
    '     *',
    '     * @return array<string, mixed>',
    '     */',
    `    private static function document(${entity} $entity): array`,
    '    {',
    '        return array_filter([',
    ...info.columns.map(
      ({ column, prop }) =>
        `            ${phpString(column.name)} => Documents::toBson(${access('$entity', prop)}, self::SHAPE[${phpString(column.name)}]),`,
    ),
    '        ], fn (mixed $value) => $value !== null);',
    '    }',
    ...(updates(info)
      ? [
          '',
          '    /** The same entity, with what it is stored as kept to tell its changes. */',
          `    private static function loaded(${entity} $entity): ${entity}`,
          '    {',
          '        self::$read ??= new \\WeakMap();',
          '        self::$read[$entity] = self::document($entity);',
          '        return $entity;',
          '    }',
        ]
      : []),
  ]
}

const find = (info: TableInfo, conditions: string[], options: string) =>
  `array_map(self::entity(...), $this->db->find(${phpString(info.name)}, ${filter(conditions)}${options ? `, ${options}` : ''}))`

const identify = (info: TableInfo) =>
  identifiedLists(info).map((column) => `${access('$entity', column.prop)} = Documents::identify(${access('$entity', column.prop)});`)

export function body(context: Context, info: TableInfo, method: RepositoryMethod, uses: PhpUses): Line[] {
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const soft = softCondition(info)
  const name = phpString(info.name)
  const entity = phpString(info.entity)
  const [key] = info.key
  const given = [...columns.map((column) => equal(column, `$${column.field}`)), ...soft]
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [...guards(columns, 'null'), `return ${find(info, given, "['limit' => 1]")}[0] ?? null;`]
    case 'listByParent':
    case 'findAllBy':
      return [...guards(columns, '[]'), `return ${find(info, given, byKey(info))};`]
    case 'list': {
      const sort = `'sort' => [${phpString(key.column.name)} => 1]`
      if (context.settings.paging === 'offset')
        return [
          `$items = $limit > 0 ? ${find(info, soft, `[${sort}, 'skip' => $offset, 'limit' => $limit]`)} : [];`,
          `return new Page($items, $this->db->count(${name}, ${filter(soft)}), $offset, $limit);`,
        ]
      if (context.settings.paging === 'cursor')
        return [
          `$filter = ${filter(soft)};`,
          'if ($after !== null) {',
          `    $filter[${phpString(key.column.name)}] = ['$gt' => ${stored(key.column.type, '$after[0]')}];`,
          '}',
          `$rows = array_map(self::entity(...), $this->db->find(${name}, $filter, [${sort}, 'limit' => $limit + 1]));`,
          '$items = array_slice($rows, 0, $limit);',
          `return new CursorPage($items, count($rows) > $limit ? [${access('$items[$limit - 1]', key.prop)}] : null);`,
        ]
      return [`return ${find(info, soft, `[${sort}]`)};`]
    }
    case 'insert':
      return [
        // MongoDB fills nothing but the identifier
        ...info.columns.flatMap((column) => memoryFill(context, info, column, uses)),
        ...identify(info),
        `$this->db->insert(${entity}, ${name}, fn () => self::document($entity));`,
        `return ${updates(info) ? 'self::loaded($entity)' : '$entity'};`,
      ]
    case 'update': {
      if (!updates(info)) return ['// Nothing of it can change but its key', 'return $entity;']
      const touched = touchedBy(info)
      return [
        ...touched.map((column) => `${access('$entity', column.prop)} = new \\DateTimeImmutable();`),
        ...identify(info),
        `$this->db->write(${entity}, function () use ($entity): void {`,
        '    $now = self::document($entity);',
        '    $changes = Documents::changes(self::$read[$entity] ?? [], $now, self::FIELDS);',
        '    if ($changes === []) {',
        '        return;',
        '    }',
        ...touched.map(({ column }) => `    $changes['$set'][${phpString(column.name)}] = $now[${phpString(column.name)}];`),
        `    $this->db->update(${name}, ['_id' => $now['_id']], $changes);`,
        '});',
        'return self::loaded($entity);',
      ]
    }
    case 'delete':
      return [`$this->db->delete(${entity}, ${name}, ${filter([equal(key, access('$entity', key.prop))])});`]
    case 'addItem':
    case 'removeItem':
      return itemBody(context, info, method, uses)
    default:
      return ["throw new \\LogicException('not supported');"]
  }
}

/** One item of a list added or removed in the database, whatever the rest of the list is by then. */
function itemBody(context: Context, info: TableInfo, method: RepositoryMethod, uses: PhpUses): string[] {
  const list = listOf(context, info, method.query)
  const [key] = info.key
  const [param] = list.params
  const path = phpString(list.column.column.name)

  const touched = touchedBy(info).map(({ column }) => `${phpString(column.name)} => new UTCDateTime()`)
  if (touched.length > 0) uses.add('MongoDB\\BSON\\UTCDateTime')
  const version = info.version?.column.name
  const conditions = [equal(key, `$${key.field}`), ...softCondition(info)]
  const result = guards([key], 'null')
  const adds = method.query.kind === 'addItem'
  let change: string
  if (!adds && list.by === 'position') {
    // MongoDB removes by position only by writing the list without it; the size says it is still the list that was seen
    conditions.push(`${path} => ['$size' => $size]`)
    const kept = phpString(`$${list.column.column.name}`)
    const sets = [
      `${path} => ['$concatArrays' => [['$slice' => [${kept}, $position]], ['$slice' => [${kept}, $position + 1, max($size, 1)]]]]`,
      ...touched,
      ...(version ? [`${phpString(version)} => ['$add' => [${phpString(`$${version}`)}, 1]]`] : []),
    ]
    change = `[['$set' => [${sets.join(', ')}]]]`
  } else {
    let main: string
    if (adds) {
      if (list.by === 'id') result.push(`[$${list.item}] = Documents::identify([$${list.item}]);`)
      main = `'$push' => [${path} => ${stored(list.type, `$${list.item}`)}]`
    } else if (list.by === 'id') {
      result.push(`if (!Documents::isId($${param.name})) {`, '    return null;', '}')
      main = `'$pull' => [${path} => ['_id' => Documents::toBson($${param.name}, 'objectId')]]`
    } else main = `'$pull' => [${path} => ${stored(list.type, `$${param.name}`)}]`
    change = `[${[
      main,
      ...(touched.length > 0 ? [`'$set' => [${touched.join(', ')}]`] : []),
      ...(version ? [`'$inc' => [${phpString(version)} => 1]`] : []),
    ].join(', ')}]`
  }
  return [
    ...result,
    `$document = $this->db->change(${phpString(info.entity)}, ${phpString(info.name)}, fn () => [${filter(conditions)}, ${change}]);`,
    'return $document === null ? null : self::entity($document);',
  ]
}
