/**
 * The repositories of each table: the interface services depend on (when the settings want one), its database
 * implementation (whose bodies the ORM writes: reads that leave out rows marked as deleted, writes stored at once so
 * a database refusal becomes a ConflictException, values the database fills read back), and its in-memory one, with
 * the same methods. Repositories decide nothing.
 */
import type { QueryDesign } from '../../../crud/types.ts'
import type { GeneratedFile } from '../../../export/files.ts'
import type { Line } from '../../types.ts'
import {
  className,
  columnOf,
  commonClass,
  memoryRepositoryClass,
  namespaceOf,
  pathOf,
  phpFile,
  queryName,
  repositoryInterface,
  sqlRepositoryClass,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import { access, phpLiteral, phpString, PhpUses } from './php.ts'

export interface RepositoryMethod {
  query: QueryDesign
  name: string
  params: { name: string; type: string }[]
  returns: string
  /** The PHPDoc tags of the method: `@return list<Customer>` */
  tags: string[]
  doc: string
}

/** The methods of a table's repository, with their PHP signatures. */
export function repositoryMethods(context: Context, info: TableInfo, uses: PhpUses): RepositoryMethod[] {
  const entity = info.entity
  const methods: RepositoryMethod[] = []
  for (const query of info.queries) {
    const name = queryName(context, query)
    const byColumns = query.columns.map((column) => ({ name: columnOf(info, column).field, type: columnOf(info, column).php }))
    const add = (params: RepositoryMethod['params'], returns: string, doc: string, tags: string[] = []) =>
      methods.push({ query, name, params, returns, doc, tags })
    switch (query.kind) {
      case 'getByKey':
        add(byColumns, `?${entity}`, 'The row with this primary key, or null.')
        break
      case 'findByUnique':
        add(byColumns, `?${entity}`, `The row with this ${query.columns.join(' and ')}, or null.`)
        break
      case 'listByParent':
      case 'findAllBy':
        add(byColumns, 'array', `Rows with this ${query.columns.join(' and ')}, by primary key.`, [`@return list<${entity}>`])
        break
      case 'list':
        if (context.settings.paging === 'offset') {
          uses.add(commonClass(context, 'Page'))
          add(
            [
              { name: 'offset', type: 'int' },
              { name: 'limit', type: 'int' },
            ],
            'Page',
            'At most $limit rows from $offset, by primary key, and how many there are.',
            [`@return Page<${entity}>`],
          )
        } else if (context.settings.paging === 'cursor') {
          uses.add(commonClass(context, 'CursorPage'))
          add(
            [
              { name: 'after', type: '?array' },
              { name: 'limit', type: 'int' },
            ],
            'CursorPage',
            'At most $limit rows after the key $after (null for the first page), by primary key, and the key to read the next page from.',
            ['@param list<mixed>|null $after', `@return CursorPage<${entity}>`],
          )
        } else add([], 'array', 'Every row, by primary key.', [`@return list<${entity}>`])
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

/** The uuids an insert makes first: not every database can fill a uuid column. */
export function uuidFills(context: Context, info: TableInfo, uses: PhpUses): string[] {
  return info.columns
    .filter((column) => column.column.generated === 'uuid')
    .map((column) => {
      uses.add(commonClass(context, 'Uuid'))
      return `${access('$entity', column.prop)} ??= Uuid::v4();`
    })
}

/** The columns the database fills when a row leaves them out, besides an identity key and uuids. */
export const filledByDatabase = (info: TableInfo) =>
  info.columns.filter(
    (column) =>
      (column.column.generated !== undefined &&
        column.column.generated !== 'uuid' &&
        !(column.column.generated === 'identity' && info.key.includes(column))) ||
      column.column.default?.kind === 'expression',
  )

const signature = (method: RepositoryMethod) =>
  `public function ${method.name}(${method.params.map((param) => `${param.type} $${param.name}`).join(', ')}): ${method.returns}`

/** The doc comment of a method: one line, or a block when it has tags. */
export function docBlock(summary: string, tags: string[], pad = '    '): string[] {
  if (tags.length === 0) return [`${pad}/** ${summary} */`]
  return [`${pad}/**`, `${pad} * ${summary}`, `${pad} *`, ...tags.map((tag) => `${pad} * ${tag}`), `${pad} */`]
}

const ind = (items: Line[], spaces: number): Line[] =>
  items.map((line) => (typeof line === 'string' ? (line === '' ? '' : ' '.repeat(spaces) + line) : line))

function block(method: RepositoryMethod, body: Line[], doc: boolean): Line[] {
  return ['', ...(doc ? docBlock(method.doc, method.tags) : []), `    ${signature(method)}`, '    {', ...ind(body, 8), '    }']
}

// In memory

/** A literal of the column's PHP type, for a default the database would set. */
export function defaultLiteral(column: ColumnInfo, value: string | number | boolean | null): string {
  if (value === null || typeof value === 'boolean') return phpLiteral(value)
  if (column.php === 'string') return phpString(String(value))
  if (column.php === 'float') return /[.eE]/.test(String(value)) ? String(value) : `${value}.0`
  if (column.php === '\\DateTimeImmutable') return `new \\DateTimeImmutable(${phpString(String(value))})`
  return phpLiteral(value)
}

function memoryFill(context: Context, info: TableInfo, column: ColumnInfo, uses: PhpUses): string[] {
  const db = column.column
  const target = access('$entity', column.prop)
  const primary = info.key.includes(column)
  if (db.generated === 'identity')
    return primary ? [`if (${target} === null) {`, `    ${target} = $this->nextId++;`, '}'] : [`${target} ??= $this->nextId++;`]
  if (db.generated === 'uuid') {
    uses.add(commonClass(context, 'Uuid'))
    return [`${target} ??= Uuid::v4();`]
  }
  if (db.generated === 'now' || db.generated === 'onUpdateNow')
    return [`${target} ??= ${column.php === '\\DateTimeImmutable' ? 'new \\DateTimeImmutable()' : "date('H:i:s')"};`]
  if (db.default?.kind === 'literal' && db.default.value !== null) return [`${target} ??= ${defaultLiteral(column, db.default.value)};`]
  return []
}

function memoryVisible(info: TableInfo): string {
  if (!info.soft) return 'true'
  const target = access('$row', info.soft.prop)
  return info.soft.column.type.kind === 'boolean' ? `${target} !== true` : `${target} === null`
}

function memoryBody(context: Context, info: TableInfo, method: RepositoryMethod): Line[] {
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const conditions = columns.map((column) => `${access('$row', column.prop)} == $${column.field}`).join(' && ')
  const entity = info.entity
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return ['foreach ($this->visible() as $row) {', `    if (${conditions}) {`, '        return $row;', '    }', '}', 'return null;']
    case 'listByParent':
    case 'findAllBy':
      return [`return array_values(array_filter($this->visible(), fn (${entity} $row) => ${conditions}));`]
    case 'list':
      if (context.settings.paging === 'offset')
        return ['$rows = $this->visible();', 'return new Page(array_slice($rows, $offset, $limit), count($rows), $offset, $limit);']
      if (context.settings.paging === 'cursor')
        return [
          `$rows = array_values(array_filter($this->visible(), fn (${entity} $row) => $after === null || (self::keyOf($row) <=> $after) > 0));`,
          '$items = array_slice($rows, 0, $limit);',
          'return new CursorPage($items, count($rows) > $limit ? self::keyOf($items[count($items) - 1]) : null);',
        ]
      return ['return $this->visible();']
    case 'insert':
    case 'update':
      return ['$this->rows[self::keyText($entity)] = $entity;', 'return $entity;']
    case 'delete':
      return ['unset($this->rows[self::keyText($entity)]);']
    default:
      return ["throw new \\LogicException('not supported');"]
  }
}

export function repositoryFiles(context: Context, info: TableInfo): GeneratedFile[] {
  const ns = namespaceOf(context, info, 'repository')
  const entityClass = className(namespaceOf(context, info, 'entity'), info.entity)
  const interfaces = context.settings.repositoryInterfaces
  const files: GeneratedFile[] = []
  const unit = (name: string, uses: PhpUses, body: Line[]) =>
    phpFile(
      pathOf(ns, name),
      ns,
      uses.write(),
      body.filter((line): line is string => typeof line === 'string'),
    )
  if (interfaces) {
    const uses = new PhpUses(ns).add(entityClass)
    const methods = repositoryMethods(context, info, uses)
    files.push(
      unit(repositoryInterface(info), uses, [
        `/** Where ${info.name} rows are kept. Services depend only on this interface. */`,
        `interface ${repositoryInterface(info)}`,
        '{',
        ...methods.flatMap((method, index) => [index > 0 ? '' : null, ...docBlock(method.doc, method.tags), `    ${signature(method)};`]),
        '}',
      ]),
    )
  }
  {
    const uses = new PhpUses(ns).add(entityClass)
    const methods = repositoryMethods(context, info, uses)
    const init = context.orm.repository.init(context, info, uses)
    const bodies = methods.map((method) => block(method, context.orm.repository.body(context, info, method, uses), !interfaces))
    const helpers = context.orm.repository.helpers(context, info, uses)
    const members = [...(init.length > 0 ? ['', ...init] : []), ...bodies.flat(), ...(helpers.length > 0 ? ['', ...helpers] : [])]
    files.push(
      unit(sqlRepositoryClass(info), uses, [
        `/** Keeps ${info.name} rows in the database, ${context.orm.repository.doc(context)} ${
          context.settings.transactions === 'caller'
            ? 'Writes run in the transaction of whoever holds the connection, when there is one.'
            : 'A write joins the transaction already open, or is committed at once.'
        } */`,
        `${interfaces ? 'final ' : ''}class ${sqlRepositoryClass(info)}${interfaces ? ` implements ${repositoryInterface(info)}` : ''}`,
        '{',
        ...members.slice(1),
        '}',
      ]),
    )
  }
  if (context.settings.memoryRepositories) {
    const uses = new PhpUses(ns).add(entityClass)
    const methods = repositoryMethods(context, info, uses)
    const fills = info.columns.flatMap((column) => memoryFill(context, info, column, uses))
    const bodies = methods.map((method) => {
      const body = memoryBody(context, info, method)
      return block(method, method.query.kind === 'insert' ? [...fills, ...body] : body, false)
    })
    const identity = info.columns.some((column) => column.column.generated === 'identity')
    const keyValues = info.key.map((column) => access('$row', column.prop)).join(', ')
    const entity = info.entity
    files.push(
      unit(
        memoryRepositoryClass(info),
        uses,
        [
          `/** Keeps ${info.name} rows in memory, for tests and for trying the services without a database. */`,
          interfaces
            ? `final class ${memoryRepositoryClass(info)} implements ${repositoryInterface(info)}`
            : `final class ${memoryRepositoryClass(info)} extends ${sqlRepositoryClass(info)}`,
          '{',
          `    /** @var array<string, ${entity}> */`,
          '    private array $rows = [];',
          identity && '',
          identity && '    private int $nextId = 1;',
          // The database class needs a connection; memory does not
          !interfaces &&
            context.orm.repository.init(context, info, new PhpUses(ns)).length > 0 && [
              '',
              '    public function __construct()',
              '    {',
              '    }',
            ],
          '',
          '    /**',
          '     * The key of a row, as a list of its key values.',
          '     *',
          '     * @return list<mixed>',
          '     */',
          `    private static function keyOf(${entity} $row): array`,
          '    {',
          `        return [${keyValues}];`,
          '    }',
          '',
          `    private static function keyText(${entity} $row): string`,
          '    {',
          "        return serialize(array_map(fn (mixed $value) => $value instanceof \\DateTimeInterface ? $value->format('Y-m-d H:i:s.u P') : $value, self::keyOf($row)));",
          '    }',
          '',
          '    /**',
          '     * The rows reads can see, by primary key.',
          '     *',
          `     * @return list<${entity}>`,
          '     */',
          '    private function visible(): array',
          '    {',
          `        $rows = array_values(array_filter($this->rows, fn (${entity} $row) => ${memoryVisible(info)}));`,
          `        usort($rows, fn (${entity} $a, ${entity} $b) => self::keyOf($a) <=> self::keyOf($b));`,
          '        return $rows;',
          '    }',
          ...bodies.flat(),
          '}',
        ].flat(),
      ),
    )
  }
  return files
}
