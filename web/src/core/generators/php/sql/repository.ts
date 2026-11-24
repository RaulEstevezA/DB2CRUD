/**
 * The repositories without an ORM: each one writes its SQL and runs it through Sql over a PDO connection. Rows are read into
 * the plain entities column by column; reads leave out rows marked as deleted; pages go by offset or after a key; new rows
 * are read back (with RETURNING on PostgreSQL and SQLite, by their key on MySQL and MariaDB); and a database refusal becomes
 * a ConflictException. Mirrors csharp/sql/repository.ts.
 */
import { quoteName, tableName } from '../../../schema/ddl.ts'
import type { Line } from '../../types.ts'
import { columnOf, errorClass, type ColumnInfo, type Context, type TableInfo } from '../common/context.ts'
import { access, phpString, type PhpUses } from '../common/php.ts'
import { uuidFills, type RepositoryMethod } from '../common/repositories.ts'
import { readColumn, selected, sqlUses, writeValue } from './database.ts'

const q = (context: Context, name: string) => quoteName(context.settings.database, name)
const table = (context: Context, info: TableInfo) => tableName(context.settings.database, info.table)

/** A computed column is never written; the key of a stored row, and what the database fills on change, neither. */
const writable = (column: ColumnInfo) => typeof column.column.generated !== 'object'
const changeable = (info: TableInfo, column: ColumnInfo) =>
  writable(column) && !info.key.includes(column) && !column.generated && column.column.generated !== 'onUpdateNow'

const returns = (context: Context) => context.settings.database === 'postgresql' || context.settings.database === 'sqlite'

/** The condition that leaves out rows marked as deleted. */
function softCondition(context: Context, info: TableInfo): string | null {
  if (!info.soft) return null
  const column = q(context, info.soft.column.name)
  return info.soft.column.type.kind === 'boolean' ? `${column} = FALSE` : `${column} IS NULL`
}

function whereSql(conditions: (string | null)[]): string {
  const present = conditions.filter((item): item is string => item !== null)
  return present.length > 0 ? ` WHERE ${present.join(' AND ')}` : ''
}

const equals = (context: Context, columns: ColumnInfo[]) => columns.map((column) => `${q(context, column.column.name)} = ?`)
const orderBy = (context: Context, info: TableInfo) => ` ORDER BY ${info.key.map((column) => q(context, column.column.name)).join(', ')}`

/** The last argument of a call: the values of the statement. */
const args = (values: string[]) => (values.length > 0 ? `, [${values.join(', ')}]` : '')

/** The property of the entity, as the statement takes it. */
const given = (context: Context, column: ColumnInfo) => writeValue(context, column, access('$entity', column.prop), true)
const keyValues = (context: Context, info: TableInfo) => info.key.map((column) => given(context, column))

/** A write that a refusal of the database turns into a ConflictException. */
const write = (call: string) => `$this->write(fn () => ${call})`

/** The constructor, after the columns a read selects. */
export function sqlInit(context: Context, info: TableInfo, uses: PhpUses): Line[] {
  sqlUses(context, uses)
  const columns = info.columns.map((column) => selected(context, column, q(context, column.column.name))).join(', ')
  return [
    '    /** The columns every read selects */',
    `    private const COLUMNS = ${phpString(columns)};`,
    '',
    '    public function __construct(private readonly PDO $db)',
    '    {',
    '    }',
  ]
}

/** How a row read with COLUMNS becomes an entity, and how writes report a refusal. */
export function sqlHelpers(context: Context, info: TableInfo, uses: PhpUses): Line[] {
  const kinds = new Set(info.queries.map((item) => item.kind))
  const writes = kinds.has('insert') || kinds.has('update') || kinds.has('delete')
  if (writes) uses.add('PDOException', errorClass(context, 'ConflictException'))
  return [
    '    /**',
    `     * Reads a row selected with COLUMNS into $entity.`,
    '     *',
    '     * @param list<mixed> $row',
    '     */',
    `    private static function fill(${info.entity} $entity, array $row): ${info.entity}`,
    '    {',
    ...info.columns.map((column, index) => `        ${access('$entity', column.prop)} = ${readColumn(context, column, `$row[${index}]`)};`),
    '        return $entity;',
    '    }',
    '',
    '    /**',
    `     * The rows of a query that selects COLUMNS.`,
    '     *',
    '     * @param list<mixed> $values',
    `     * @return list<${info.entity}>`,
    '     */',
    '    private function rows(string $rest, array $values = []): array',
    '    {',
    "        $sql = 'SELECT ' . self::COLUMNS . $rest;",
    `        return array_map(fn (array $row) => self::fill(new ${info.entity}(), $row), Sql::all($this->db, $sql, $values));`,
    '    }',
    ...(writes
      ? [
          '',
          '    /** Runs a write; a database refusal (a unique value, a row still pointed to) becomes a ConflictException. */',
          '    private function write(callable $change): mixed',
          '    {',
          '        try {',
          '            return $change();',
          '        } catch (PDOException $error) {',
          '            if (!Sql::isRefusal($error)) {',
          '                throw $error;',
          '            }',
          `            throw new ConflictException(${phpString(info.entity)}, 'the database refused the change: ' . $error->getMessage());`,
          '        }',
          '    }',
        ]
      : []),
  ]
}

/** Reads a stored row again by its key, without the soft-delete filter, into the entity. */
function readBack(context: Context, info: TableInfo): Line[] {
  const rest = phpString(` FROM ${table(context, info)}${whereSql(equals(context, info.key))}`)
  return [
    `$row = Sql::one($this->db, 'SELECT ' . self::COLUMNS . ${rest}${args(keyValues(context, info))});`,
    `return self::fill($entity, $row ?? throw new \\LogicException(${phpString(`The ${info.entity} just written is not there`)}));`,
  ]
}

export function sqlBody(context: Context, info: TableInfo, method: RepositoryMethod, uses: PhpUses): Line[] {
  const from = ` FROM ${table(context, info)}`
  const columns = method.query.columns.map((name) => columnOf(info, name))
  const byValues = args(columns.map((column) => writeValue(context, column, `$${column.field}`, false)))
  const soft = softCondition(context, info)
  const order = orderBy(context, info)
  switch (method.query.kind) {
    case 'getByKey':
    case 'findByUnique':
      return [`return $this->rows(${phpString(`${from}${whereSql([...equals(context, columns), soft])}`)}${byValues})[0] ?? null;`]
    case 'listByParent':
    case 'findAllBy':
      return [`return $this->rows(${phpString(`${from}${whereSql([...equals(context, columns), soft])}${order}`)}${byValues});`]
    case 'list': {
      const where = whereSql([soft])
      if (context.settings.paging === 'offset')
        return [
          `$items = $this->rows(${phpString(`${from}${where}${order} LIMIT ? OFFSET ?`)}, [$limit, $offset]);`,
          `$total = (int) Sql::one($this->db, ${phpString(`SELECT COUNT(*)${from}${where}`)})[0];`,
          'return new Page($items, $total, $offset, $limit);',
        ]
      if (context.settings.paging === 'cursor') {
        const key = info.key.map((column) => q(context, column.column.name))
        const after = key.length === 1 ? `${key[0]} > ?` : `(${key.join(', ')}) > (${key.map(() => '?').join(', ')})`
        const afterValues = info.key.map((column, index) => writeValue(context, column, `$after[${index}]`, false))
        const next = info.key.map((column) => access('$items[$limit - 1]', column.prop))
        return [
          '$rows = $after === null',
          `    ? $this->rows(${phpString(`${from}${where}${order} LIMIT ?`)}, [$limit + 1])`,
          `    : $this->rows(${phpString(`${from}${whereSql([soft, after])}${order} LIMIT ?`)}, [${afterValues.join(', ')}, $limit + 1]);`,
          '$items = array_slice($rows, 0, $limit);',
          `return new CursorPage($items, count($rows) > $limit ? [${next.join(', ')}] : null);`,
        ]
      }
      return [`return $this->rows(${phpString(`${from}${where}${order}`)});`]
    }
    case 'insert': {
      const into = `INSERT INTO ${table(context, info)}`
      const empty = returns(context) ? ' DEFAULT VALUES' : ' () VALUES ()'
      // Values left null take the database's default
      const prepare = [
        ...uuidFills(context, info, uses),
        '$names = [];',
        '$values = [];',
        ...info.columns
          .filter((column) => writable(column))
          .flatMap((column) => [
            `if (${access('$entity', column.prop)} !== null) {`,
            `    $names[] = ${phpString(q(context, column.column.name))};`,
            `    $values[] = ${writeValue(context, column, access('$entity', column.prop), false)};`,
            '}',
          ]),
        '$sql = $names === []',
        `    ? ${phpString(`${into}${empty}`)}`,
        `    : ${phpString(`${into} (`)} . implode(', ', $names) . ') VALUES (' . implode(', ', array_fill(0, count($names), '?')) . ')';`,
      ]
      if (returns(context))
        return [
          ...prepare,
          `$row = ${write("Sql::one($this->db, $sql . ' RETURNING ' . self::COLUMNS, $values)")};`,
          `return self::fill($entity, $row ?? throw new \\LogicException(${phpString(`The ${info.entity} just written is not there`)}));`,
        ]
      const identity = info.key.length === 1 && info.key[0].column.generated === 'identity' ? info.key[0] : null
      return [
        ...prepare,
        `${write('Sql::run($this->db, $sql, $values)')};`,
        ...(identity ? [`${access('$entity', identity.prop)} ??= (int) $this->db->lastInsertId();`] : []),
        ...readBack(context, info),
      ]
    }
    case 'update': {
      const changes = info.columns.filter((column) => changeable(info, column))
      const stamps = info.columns.filter((column) => column.column.generated === 'onUpdateNow')
      const now = returns(context) ? 'CURRENT_TIMESTAMP' : 'CURRENT_TIMESTAMP(6)'
      const sets = [...equals(context, changes), ...stamps.map((column) => `${q(context, column.column.name)} = ${now}`)]
      if (sets.length === 0) return readBack(context, info)
      const sql = phpString(`UPDATE ${table(context, info)} SET ${sets.join(', ')}${whereSql(equals(context, info.key))}`)
      const values = [...changes.map((column) => given(context, column)), ...keyValues(context, info)]
      return [`${write(`Sql::run($this->db, ${sql}${args(values)})`)};`, ...readBack(context, info)]
    }
    case 'delete': {
      const sql = phpString(`DELETE${from}${whereSql(equals(context, info.key))}`)
      return [`${write(`Sql::run($this->db, ${sql}${args(keyValues(context, info))})`)};`]
    }
    default:
      return ["throw new \\LogicException('not supported');"]
  }
}
