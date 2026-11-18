/**
 * The service of each table: its operations and what each one checks before it writes, in the order of the
 * design (docs/design.md, section 3): the values against the database's rules, the rows they point to, unique
 * values, the version; then children and soft deletes. The values of a create or an update are gathered in an
 * array of the fields given, so every way an update can come is checked and applied the same way. Every write runs
 * in $uow->transaction(...); errors are domain exceptions without HTTP codes. Mirrors csharp/services.ts.
 */
import type { OperationDesign } from '../../../crud/types.ts'
import type { GeneratedFile } from '../../../export/files.ts'
import type { DbCheck } from '../../../schema/types.ts'
import { lines, type Line } from '../../types.ts'
import {
  className,
  columnOf,
  commonClass,
  errorClass,
  findInfo,
  namespaceOf,
  operationName,
  pathOf,
  query,
  queryName,
  rootClass,
  serviceClass,
  type ColumnInfo,
  type Context,
  type TableInfo,
} from './context.ts'
import {
  createColumns,
  createDto,
  partialShape,
  partialUpdates,
  readColumns,
  readDto,
  updateClass,
  updateColumns,
  updateType,
} from './dtos.ts'
import { docBlock } from './repositories.ts'
import { access, phpString, PhpUses } from './php.ts'

interface Writer {
  context: Context
  info: TableInfo
  uses: PhpUses
  dtos: boolean
}

type Block = Line[]

const repo = (info: TableInfo, uow = '$uow') => `${uow}->${info.attr}`
const keyParams = (info: TableInfo) => info.key.map((column) => `${column.php} $${column.field}`).join(', ')
const keyArgs = (info: TableInfo) => info.key.map((column) => `$${column.field}`).join(', ')
const keyValue = (info: TableInfo) => (info.key.length === 1 ? `$${info.key[0].field}` : `[${keyArgs(info)}]`)
const ind = (items: Line[], spaces = 4): Line[] =>
  items.map((line) => (typeof line === 'string' ? (line === '' ? '' : ' '.repeat(spaces) + line) : line))

/** The variables the checks already use: a column with one of these names gets `Value` after it. */
const TAKEN = new Set([
  'values',
  'errors',
  'creating',
  'current',
  'uow',
  'value',
  'other',
  'entity',
  'changes',
  'row',
  'link',
  'version',
  'data',
])
const local = (column: ColumnInfo) => `$${TAKEN.has(column.field) ? `${column.field}Value` : column.field}`

const numericKinds = new Set(['integer', 'decimal', 'float'])

/** The value of a field as the change gives it, or as the row has it. */
const givenOrCurrent = (column: ColumnInfo) =>
  `${local(column)} = array_key_exists(${phpString(column.field)}, $values) ? $values[${phpString(column.field)}] : ${access('$current?', column.prop)};`

const valuesDoc = (summary: string) => docBlock(summary, ['@param array<string, mixed> $values'], '')

function valueRules(column: ColumnInfo, checks: DbCheck[]): Line[][] {
  const rules: Line[][] = []
  const name = column.column.name
  const type = column.column.type
  const rule = (condition: string, message: string) => [
    `if (${condition}) {`,
    `    $errors[] = new FieldError(${phpString(name)}, ${phpString(message)});`,
    '}',
  ]
  if (type.kind === 'text' && type.length !== undefined)
    rules.push(rule(`is_string($value) && mb_strlen($value) > ${type.length}`, `is longer than ${type.length} characters`))
  for (const check of checks) {
    const parsed = check.parsed
    if (!parsed || parsed.column !== name) continue
    if (parsed.kind === 'in') {
      const message = `must be one of: ${parsed.values.join(', ')}`
      if (numericKinds.has(type.kind))
        rules.push(rule(`!in_array((float) $value, [${parsed.values.map((item) => String(item)).join(', ')}])`, message))
      else
        rules.push(rule(`!in_array((string) $value, [${parsed.values.map((item) => phpString(String(item))).join(', ')}], true)`, message))
    }
    if (parsed.kind === 'compare')
      rules.push(rule(`!((float) $value ${parsed.op} ${String(parsed.value)})`, `must be ${parsed.op} ${parsed.value}`))
    if (parsed.kind === 'length')
      rules.push(rule(`!(mb_strlen((string) $value) ${parsed.op} ${parsed.value})`, `must have ${parsed.op} ${parsed.value} characters`))
  }
  return rules
}

function validateMethod(writer: Writer): Block {
  const { context, info, uses } = writer
  uses.add(errorClass(context, 'FieldError'), errorClass(context, 'ValidationFailedException'), rootClass(context, 'UnitOfWork'))
  const blocks: Line[][] = []
  for (const column of createColumns(info)) {
    const name = column.column.name
    const field = phpString(column.field)
    const missing = column.required
      ? { condition: `$creating || array_key_exists(${field}, $values)`, message: 'is required' }
      : !column.column.nullable
        ? { condition: `!$creating && array_key_exists(${field}, $values)`, message: 'cannot be empty' }
        : null
    const rules = valueRules(column, info.table.checks).flat()
    if (!missing && rules.length === 0) continue
    const report = missing && [
      `    if (${missing.condition}) {`,
      `        $errors[] = new FieldError(${phpString(name)}, ${phpString(missing.message)});`,
      '    }',
    ]
    blocks.push([
      `$value = $values[${field}] ?? null;`,
      ...(missing
        ? ['if ($value === null) {', ...report!, ...(rules.length > 0 ? ['} else {', ...ind(rules)] : []), '}']
        : ['if ($value !== null) {', ...ind(rules), '}']),
    ])
  }
  // Parents
  for (const key of info.table.foreignKeys) {
    const parent = findInfo(context, key.references.table)
    const read = parent ? query(parent, 'getByKey') : undefined
    const sameKey = parent && parent.key.map((column) => column.column.name).join(',') === key.references.columns.join(',')
    if (!parent || !read || !sameKey) {
      blocks.push([
        `// TODO: ${key.columns.join(', ')} must point to a row of ${key.references.table}; that table has no read by key to check it`,
      ])
      continue
    }
    const columns = key.columns.map((name) => columnOf(info, name))
    blocks.push([
      ...columns.map(givenOrCurrent),
      `if (${columns.map((column) => `${local(column)} !== null`).join(' && ')} && ${repo(parent)}->${queryName(context, read)}(${columns.map(local).join(', ')}) === null) {`,
      `    $errors[] = new FieldError(${phpString(key.columns.join(', '))}, ${phpString(`no ${parent.entity} has this key`)});`,
      '}',
    ])
  }
  return [
    ...valuesDoc(
      `Checks the values against the rules of the "${info.name}" table, and the rows they point to; throws ValidationFailedException with every problem.`,
    ),
    `private static function validate(UnitOfWork $uow, array $values, ?${info.entity} $current): void`,
    '{',
    '    $creating = $current === null;',
    '    $errors = [];',
    ...blocks.flatMap((block) => ind(block)),
    '    if ($errors !== []) {',
    `        throw new ValidationFailedException(${phpString(info.entity)}, $errors);`,
    '    }',
    '}',
  ]
}

function uniqueMethod(writer: Writer): Block {
  const { context, info, uses } = writer
  const checks: Line[][] = []
  for (const unique of info.table.uniques) {
    const read = query(info, 'findByUnique', unique.columns)
    if (!read) {
      checks.push([`// ${unique.columns.join(', ')} must be unique: the database refuses repeated values (ConflictException)`])
      continue
    }
    uses.add(errorClass(context, 'ConflictException'))
    const columns = unique.columns.map((name) => columnOf(info, name))
    const other = info.key.map((column) => `${access('$other', column.prop)} != ${access('$current', column.prop)}`).join(' || ')
    checks.push([
      ...columns.map(givenOrCurrent),
      `if (${columns.map((column) => `${local(column)} !== null`).join(' && ')}) {`,
      `    $other = ${repo(info)}->${queryName(context, read)}(${columns.map(local).join(', ')});`,
      `    if ($other !== null && ($current === null || ${other})) {`,
      `        throw new ConflictException(${phpString(info.entity)}, ${phpString(`${unique.columns.join(', ')} is already taken`)}, [${columns.map((column) => phpString(column.field)).join(', ')}]);`,
      '    }',
      '}',
    ])
  }
  if (checks.length === 0) return []
  return [
    ...valuesDoc('Values that must be unique are not taken by another row.'),
    `private static function checkUnique(UnitOfWork $uow, array $values, ?${writer.info.entity} $current): void`,
    '{',
    ...checks.flatMap((block) => ind(block)),
    '}',
  ]
}

function checkMethod(writer: Writer): Block {
  const { info } = writer
  return [
    ...valuesDoc('Every check before a write: the values, the rows they point to, the unique values.'),
    `private static function check(UnitOfWork $uow, array $values, ?${info.entity} $current): void`,
    '{',
    '    self::validate($uow, $values, $current);',
    info.table.uniques.length > 0 && '    self::checkUnique($uow, $values, $current);',
    '}',
  ]
}

function applyMethod(writer: Writer): Block {
  const { info } = writer
  return [
    ...valuesDoc('Sets the given values on the entity.'),
    `private static function apply(${info.entity} $entity, array $values): void`,
    '{',
    ...createColumns(info).flatMap((column) => [
      `    if (array_key_exists(${phpString(column.field)}, $values)) {`,
      `        ${access('$entity', column.prop)} = $values[${phpString(column.field)}];`,
      '    }',
    ]),
    '}',
  ]
}

function findMethod(writer: Writer): Block {
  const { context, info, uses } = writer
  const read = query(info, 'getByKey')
  if (!read) return []
  uses.add(errorClass(context, 'NotFoundException'), rootClass(context, 'UnitOfWork'))
  return [
    `/** The ${info.entity} with this key; NotFoundException when there is none. */`,
    `private static function find(UnitOfWork $uow, ${keyParams(info)}): ${info.entity}`,
    '{',
    `    return ${repo(info)}->${queryName(context, read)}(${keyArgs(info)}) ?? throw new NotFoundException(${phpString(info.entity)}, ${keyValue(info)});`,
    '}',
  ]
}

function readMethod(writer: Writer): Block {
  if (!writer.dtos) return []
  const { info } = writer
  return [
    `/** The ${info.entity} as services return it. */`,
    `private static function read(${info.entity} $entity): ${readDto(info)}`,
    '{',
    `    return new ${readDto(info)}(`,
    ...readColumns(info).map((column) => `        ${column.field}: ${access('$entity', column.prop)},`),
    '    );',
    '}',
  ]
}

function givenMethod(writer: Writer): Block {
  const { context, info, uses } = writer
  if (partialUpdates(context))
    return [
      '/**',
      ' * The values an update gives, by field: only the fields of the table that can change.',
      ' *',
      ' * @param array<string, mixed> $changes',
      ' * @return array<string, mixed>',
      ' */',
      'private static function given(array $changes): array',
      '{',
      `    return array_intersect_key($changes, array_flip([${updateColumns(info)
        .map((column) => phpString(column.field))
        .join(', ')}]));`,
      '}',
    ]
  const type = updateType(context, info)
  uses.add(updateClass(context, info))
  const patch = context.settings.updates === 'patch'
  return [
    '/**',
    ' * The values an update gives, by field.',
    ' *',
    ' * @return array<string, mixed>',
    ' */',
    `private static function given(${type} $changes): array`,
    '{',
    '    $values = [];',
    ...updateColumns(info).flatMap((column) =>
      patch
        ? [
            `    if ($changes->${column.field}->isPresent) {`,
            `        $values[${phpString(column.field)}] = $changes->${column.field}->value;`,
            '    }',
          ]
        : [`    $values[${phpString(column.field)}] = $changes->${column.field};`],
    ),
    '    return $values;',
    '}',
  ]
}

const out = (writer: Writer, expression: string) => (writer.dtos ? `self::read(${expression})` : expression)
const resultType = (writer: Writer) => (writer.dtos ? readDto(writer.info) : writer.info.entity)

function versionCheck(writer: Writer): string[] {
  const version = writer.info.version
  if (!version) return []
  writer.uses.add(errorClass(writer.context, 'ConflictException'))
  return [
    `if (${access('$current', version.prop)} != $version) {`,
    `    throw new ConflictException(${phpString(writer.info.entity)}, 'was changed by someone else since it was read', [${phpString(version.field)}]);`,
    '}',
  ]
}

function childrenLines(writer: Writer): string[] {
  const { context, info, uses } = writer
  if (!info.children) return []
  const result: string[] = []
  for (const link of info.children.links) {
    const child = findInfo(context, link.table)
    const list = child ? query(child, 'listByParent', link.columns) : undefined
    if (!child || !list) {
      result.push(`// TODO: rows of ${link.table} may point here; that table has no list by ${link.columns.join(', ')} to look for them`)
      continue
    }
    const args = link.references.map((name) => access('$current', columnOf(info, name).prop)).join(', ')
    const rows = `${repo(child)}->${queryName(context, list)}(${args})`
    if (info.children.policy === 'block') {
      uses.add(errorClass(context, 'ConflictException'))
      result.push(
        `if (${rows} !== []) {`,
        `    throw new ConflictException(${phpString(info.entity)}, ${phpString(`rows of ${link.table} still point to it`)}, [${phpString(link.table)}]);`,
        '}',
      )
    } else {
      const remove = query(child, 'delete')
      if (!remove) result.push(`// TODO: rows of ${link.table} must be deleted first, and that table has no delete`)
      else result.push(`foreach (${rows} as $row) {`, `    ${repo(child)}->${queryName(context, remove)}($row);`, '}')
    }
  }
  return result
}

/** `$this->uow->transaction(function (UnitOfWork $uow) use (...): T { ... });` */
function inTransaction(items: string[], captured: string[], returns: string | null): string[] {
  const use = captured.length > 0 ? ` use (${captured.join(', ')})` : ''
  return [
    `${returns ? 'return ' : ''}$this->uow->transaction(function (UnitOfWork $uow)${use}: ${returns ?? 'void'} {`,
    ...items.map((line) => `    ${line}`),
    '});',
  ]
}

const keyLocals = (info: TableInfo) => info.key.map((column) => `$${column.field}`)

function operationLines(writer: Writer, operation: OperationDesign): Block {
  const { context, info, uses } = writer
  const name = operationName(context, operation)
  const entity = info.entity
  switch (operation.kind) {
    case 'create': {
      const insert = query(info, 'insert')
      if (!insert) return []
      if (writer.dtos) uses.add(className(namespaceOf(context, info, 'dtos'), createDto(info)))
      uses.add(rootClass(context, 'UnitOfWork'))
      const variable = `$${entity.charAt(0).toLowerCase()}${entity.slice(1)}`
      const source = writer.dtos ? '$data' : variable
      return [
        `/** Stores a new ${entity} after checking it. */`,
        `public function ${name}(${writer.dtos ? `${createDto(info)} $data` : `${entity} ${variable}`}): ${resultType(writer)}`,
        '{',
        '    $values = array_filter([',
        ...createColumns(info).map(
          (column) => `        ${phpString(column.field)} => ${writer.dtos ? `$data->${column.field}` : access(source, column.prop)},`,
        ),
        '    ], fn (mixed $value) => $value !== null);',
        ...ind(
          inTransaction(
            [
              'self::check($uow, $values, null);',
              ...(writer.dtos ? [`$entity = new ${entity}();`, 'self::apply($entity, $values);'] : []),
              `return ${out(writer, `${repo(info)}->${queryName(context, insert)}(${writer.dtos ? '$entity' : variable})`)};`,
            ],
            writer.dtos ? ['$values'] : ['$values', variable],
            resultType(writer),
          ),
        ),
        '}',
      ]
    }
    case 'get':
      if (!query(info, 'getByKey')) return []
      return [
        `/** The ${entity} with this key; NotFoundException when there is none. */`,
        `public function ${name}(${keyParams(info)}): ${resultType(writer)}`,
        '{',
        `    return ${out(writer, `self::find($this->uow, ${keyArgs(info)})`)};`,
        '}',
      ]
    case 'list': {
      const list = query(info, 'list')
      if (!list) return []
      const method = `${repo(info, '$this->uow')}->${queryName(context, list)}`
      const result = resultType(writer)
      if (context.settings.paging === 'offset') {
        uses.add(commonClass(context, 'Page'))
        return [
          ...docBlock(`A page of ${info.name}, by primary key.`, [`@return Page<${result}>`], ''),
          `public function ${name}(int $offset, int $limit): Page`,
          '{',
          `    return ${method}($offset, $limit)${writer.dtos ? '->map(self::read(...))' : ''};`,
          '}',
        ]
      }
      if (context.settings.paging === 'cursor') {
        uses.add(commonClass(context, 'CursorPage'))
        return [
          ...docBlock(
            `A page of ${info.name} after the key $after (null for the first page), by primary key.`,
            ['@param list<mixed>|null $after', `@return CursorPage<${result}>`],
            '',
          ),
          `public function ${name}(?array $after, int $limit): CursorPage`,
          '{',
          `    return ${method}($after, $limit)${writer.dtos ? '->map(self::read(...))' : ''};`,
          '}',
        ]
      }
      return [
        ...docBlock(`Every ${entity}, by primary key.`, [`@return list<${result}>`], ''),
        `public function ${name}(): array`,
        '{',
        `    return ${writer.dtos ? `array_map(self::read(...), ${method}())` : `${method}()`};`,
        '}',
      ]
    }
    case 'update': {
      const update = query(info, 'update')
      if (!update || !query(info, 'getByKey')) return []
      uses.add(rootClass(context, 'UnitOfWork'))
      const version = info.version ? `, ${info.version.php} $version` : ''
      const partial = partialUpdates(context)
      const summary = `Changes the given values of a ${entity}${info.version ? ', read at $version' : ''}.`
      return [
        ...(partial ? docBlock(summary, [`@param ${partialShape(info)} $changes`], '') : [`/** ${summary} */`]),
        `public function ${name}(${keyParams(info)}, ${partial ? 'array' : updateType(context, info)} $changes${version}): ${resultType(writer)}`,
        '{',
        '    $values = self::given($changes);',
        ...ind(
          inTransaction(
            [
              `$current = self::find($uow, ${keyArgs(info)});`,
              ...versionCheck(writer),
              'self::check($uow, $values, $current);',
              'self::apply($current, $values);',
              ...(info.version ? [`${access('$current', info.version.prop)} = $version + 1;`] : []),
              `return ${out(writer, `${repo(info)}->${queryName(context, update)}($current)`)};`,
            ],
            [...keyLocals(info), '$values', ...(info.version ? ['$version'] : [])],
            resultType(writer),
          ),
        ),
        '}',
      ]
    }
    case 'delete': {
      const remove = query(info, 'delete')
      const update = query(info, 'update')
      if (!query(info, 'getByKey') || (!info.soft && !remove) || (info.soft && !update)) return []
      uses.add(rootClass(context, 'UnitOfWork'))
      const version = info.version ? `, ${info.version.php} $version` : ''
      const mark = !info.soft
        ? ''
        : info.soft.column.type.kind === 'boolean'
          ? 'true'
          : info.soft.php === '\\DateTimeImmutable'
            ? 'new \\DateTimeImmutable()'
            : "date('Y-m-d H:i:s')"
      const action = info.soft
        ? [`${access('$current', info.soft.prop)} = ${mark};`, `${repo(info)}->${queryName(context, update!)}($current);`]
        : [`${repo(info)}->${queryName(context, remove!)}($current);`]
      return [
        info.soft
          ? `/** Marks a ${entity} as deleted (${info.soft.column.name}); reads leave it out from then on. */`
          : `/** Deletes a ${entity}. */`,
        `public function ${name}(${keyParams(info)}${version}): void`,
        '{',
        ...ind(
          inTransaction(
            [`$current = self::find($uow, ${keyArgs(info)});`, ...versionCheck(writer), ...childrenLines(writer), ...action],
            [...keyLocals(info), ...(info.version ? ['$version'] : [])],
            null,
          ),
        ),
        '}',
      ]
    }
    case 'find':
    case 'listByParent': {
      const read = query(info, operation.kind === 'find' ? 'findByUnique' : 'listByParent', operation.columns)
      if (!read) return []
      const columns = operation.columns.map((column) => columnOf(info, column))
      const params = columns.map((column) => `${column.php} $${column.field}`).join(', ')
      const rows = `${repo(info, '$this->uow')}->${queryName(context, read)}(${columns.map((column) => `$${column.field}`).join(', ')})`
      if (operation.kind === 'find')
        return [
          `/** The ${entity} with this ${operation.columns.join(' and ')}, or null. */`,
          `public function ${name}(${params}): ?${resultType(writer)}`,
          '{',
          ...(writer.dtos
            ? [`    $entity = ${rows};`, '    return $entity === null ? null : self::read($entity);']
            : [`    return ${rows};`]),
          '}',
        ]
      return [
        ...docBlock(`The ${info.name} with this ${operation.columns.join(' and ')}.`, [`@return list<${resultType(writer)}>`], ''),
        `public function ${name}(${params}): array`,
        '{',
        `    return ${writer.dtos ? `array_map(self::read(...), ${rows})` : rows};`,
        '}',
      ]
    }
    case 'link':
    case 'unlink':
      return linkLines(writer, operation, name)
  }
}

function linkLines(writer: Writer, operation: OperationDesign, name: string): Block {
  const { context, info, uses } = writer
  const join = operation.through ? findInfo(context, operation.through) : undefined
  if (!join) return []
  const own = join.table.foreignKeys.find((key) => key.references.table === info.name)
  const far = join.table.foreignKeys.find((key) => key !== own)
  const farInfo = far ? findInfo(context, far.references.table) : undefined
  const read = query(join, 'getByKey')
  if (!own || !far || !farInfo || !read) return []
  const ownCols = own.columns.map((column) => columnOf(join, column))
  const farCols = far.columns.map((column) => columnOf(join, column))
  const all = [...ownCols, ...farCols]
  const params = all.map((column) => `${column.php} $${column.field}`).join(', ')
  const captured = all.map((column) => `$${column.field}`)
  const joinKey = join.key.map((column) => `$${column.field}`).join(', ')
  const found = `${repo(join)}->${queryName(context, read)}(${joinKey})`
  uses.add(errorClass(context, 'NotFoundException'), rootClass(context, 'UnitOfWork'))
  if (operation.kind === 'link') {
    const insert = query(join, 'insert')
    const farRead = query(farInfo, 'getByKey')
    if (!insert || !farRead || !query(info, 'getByKey')) return []
    uses.add(errorClass(context, 'ConflictException'), className(namespaceOf(context, join, 'entity'), join.entity))
    const farArgs = farCols.map((column) => `$${column.field}`).join(', ')
    return [
      `/** Links a ${info.entity} and a ${farInfo.entity} (${join.name}). */`,
      `public function ${name}(${params}): void`,
      '{',
      ...ind(
        inTransaction(
          [
            `self::find($uow, ${ownCols.map((column) => `$${column.field}`).join(', ')});`,
            `if (${repo(farInfo)}->${queryName(context, farRead)}(${farArgs}) === null) {`,
            `    throw new NotFoundException(${phpString(farInfo.entity)}, ${farCols.length === 1 ? farArgs : `[${farArgs}]`});`,
            '}',
            `if (${found} !== null) {`,
            `    throw new ConflictException(${phpString(info.entity)}, ${phpString(`is already linked to this ${farInfo.entity}`)}, [${farCols.map((column) => phpString(column.field)).join(', ')}]);`,
            '}',
            `$link = new ${join.entity}();`,
            ...all.map((column) => `${access('$link', column.prop)} = $${column.field};`),
            `${repo(join)}->${queryName(context, insert)}($link);`,
          ],
          captured,
          null,
        ),
      ),
      '}',
    ]
  }
  const remove = query(join, 'delete')
  if (!remove) return []
  return [
    `/** Removes the link between a ${info.entity} and a ${farInfo.entity} (${join.name}). */`,
    `public function ${name}(${params}): void`,
    '{',
    ...ind(
      inTransaction(
        [
          `$link = ${found} ?? throw new NotFoundException(${phpString(join.entity)}, [${joinKey}]);`,
          `${repo(join)}->${queryName(context, remove)}($link);`,
        ],
        captured,
        null,
      ),
    ),
    '}',
  ]
}

const TRANSACTIONS = {
  operation: 'Each write runs in its own transaction.',
  caller: 'It never commits: the caller owns the transaction.',
  repository: 'Repositories commit every write.',
}

export function serviceFile(context: Context, info: TableInfo): GeneratedFile | null {
  if (!info.service) return null
  const ns = namespaceOf(context, info, 'service')
  const uses = new PhpUses(ns).add(className(namespaceOf(context, info, 'entity'), info.entity), rootClass(context, 'UnitOfWork'))
  const dtos = context.settings.serviceTypes === 'dtos'
  const writer: Writer = { context, info, uses, dtos }
  if (dtos) uses.add(className(namespaceOf(context, info, 'dtos'), readDto(info)))
  const writes = info.role === 'entity'
  const operations = info.operations.map((operation) => operationLines(writer, operation)).filter((block) => block.length > 0)
  const updates = info.operations.some((operation) => operation.kind === 'update') && query(info, 'update') && query(info, 'getByKey')
  const helpers: Block[] = [findMethod(writer), readMethod(writer)]
  if (writes) helpers.unshift(validateMethod(writer), uniqueMethod(writer), checkMethod(writer), applyMethod(writer))
  if (writes && updates) helpers.push(givenMethod(writer))
  const hidden = info.hidden.length > 0 && !dtos
  const members = [...helpers, ...operations].filter((block) => block.length > 0)
  return {
    path: pathOf(ns, serviceClass(info)),
    content: lines(
      '<?php',
      '',
      'declare(strict_types=1);',
      '',
      `namespace ${ns};`,
      '',
      uses.write(),
      '',
      `/** Operations on ${info.name}. ${TRANSACTIONS[context.settings.transactions]} */`,
      `final class ${serviceClass(info)}`,
      '{',
      hidden &&
        `    // TODO: ${info.hidden.join(', ')} ${info.hidden.length === 1 ? 'is' : 'are'} returned with the entity; use DTOs to leave ${info.hidden.length === 1 ? 'it' : 'them'} out`,
      '    public function __construct(private readonly UnitOfWork $uow)',
      '    {',
      '    }',
      ...members.flatMap((block) => ['', ...ind(block)]),
      '}',
      '',
    ),
  }
}
