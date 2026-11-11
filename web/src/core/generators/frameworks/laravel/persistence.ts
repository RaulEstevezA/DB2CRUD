/**
 * Storage of each resource in the Laravel project: the repository interface the service depends on, and the
 * implementation of the chosen persistence:
 * - `memory`: an array, to run the API without a database
 * - `none`: every method throws "not implemented" (501), with a TODO where the storage goes
 * - `eloquent`: an Eloquent model, its migration and a repository that maps items to rows
 *
 * Items travel as arrays keyed by their JSON names, the same shape the service and the responses use.
 */
import type { SpecField, SpecResource } from '../../../api/spec.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { PhpImports, phpDoc, phpHeader, phpString } from '../../languages/php/php.ts'
import { memoryRepositoryFile, pendingRepositoryFile, repositoryContractFile } from '../../languages/php/storage.ts'
import { classPath, column, keyField, keyType, names, qualified, type LaravelContext } from './context.ts'

type Line = string | false | null | undefined | Line[]

function phpFile(namespace: string, name: string, imports: PhpImports, body: Line[]): GeneratedFile {
  return { path: classPath(namespace, name), content: fileText(lines(...phpHeader(namespace, imports), ...body)) }
}

export function repositoryFiles(context: LaravelContext, resource: SpecResource): GeneratedFile[] {
  const files = [repositoryContractFile(context, resource)]
  if (context.pending) return [...files, pendingRepositoryFile(context, resource)]
  if (!context.eloquent) return [...files, memoryRepositoryFile(context, resource)]
  const namespace = context.layout.resource(resource, 'repository')
  const name = names(resource)
  const key = keyType(resource)
  const generated = resource.key.generated
  const plural = resource.plural
  const listing = ['App\\Support\\ListQuery', 'App\\Support\\ListResult']

  // Eloquent: the model is the row; the repository maps rows to the arrays the service works with
  const model = qualified(context, resource, 'model', name.model)
  const imports = new PhpImports(namespace).add(...listing, model)
  const dates = resource.fields.filter((field) => isScalar(field, 'datetime'))
  if (dates.length > 0) imports.add('Carbon\\CarbonImmutable')
  const columns = resource.fields.map((field) => `        ${phpString(field.wire)} => ${phpString(column(field))},`)
  const toRow = resource.fields.map((field) => {
    const value = `$item[${phpString(field.wire)}] ?? null`
    if (isScalar(field, 'datetime'))
      return `            ${phpString(column(field))} => isset($item[${phpString(field.wire)}]) ? CarbonImmutable::parse($item[${phpString(field.wire)}])->utc() : null,`
    return `            ${phpString(column(field))} => ${value},`
  })
  const toItem = resource.fields.map((field) => {
    const read = `$model->getAttribute(${phpString(column(field))})`
    if (isScalar(field, 'datetime')) return `            ${phpString(field.wire)} => ${read}?->utc()->format('Y-m-d\\TH:i:s.u\\Z'),`
    return `            ${phpString(field.wire)} => ${read},`
  })
  const keyColumn = column(keyField(resource))
  files.push(
    phpFile(namespace, name.eloquentRepository, imports, [
      phpDoc(`Keeps ${plural} in the database with Eloquent.`),
      `final class ${name.eloquentRepository} implements ${name.repository}`,
      '{',
      '    /** The column of each JSON field */',
      '    private const COLUMNS = [',
      columns,
      '    ];',
      '',
      '    public function list(ListQuery $query): ListResult',
      '    {',
      `        $builder = ${name.model}::query();`,
      '        foreach ($query->filters as $field => $value) {',
      '            $row = $this->toRow([$field => $value]);',
      '            $builder->where(self::COLUMNS[$field], $row[self::COLUMNS[$field]]);',
      '        }',
      '        $total = (clone $builder)->count();',
      '        if ($query->sortField !== null) {',
      '            $column = self::COLUMNS[$query->sortField];',
      '            // Items without a value go last, whatever the order',
      "            $builder->orderByRaw($builder->getQuery()->getGrammar()->wrap($column).' is null')",
      "                ->orderBy($column, $query->descending ? 'desc' : 'asc');",
      '        }',
      `        $builder->orderBy(${phpString(keyColumn)});`,
      '        if ($query->limit !== null) {',
      '            $builder->offset($query->offset)->limit($query->limit);',
      '        }',
      '',
      `        return new ListResult($builder->get()->map(fn (${name.model} $model) => $this->toItem($model))->all(), $total);`,
      '    }',
      '',
      `    public function get(${key} $key): ?array`,
      '    {',
      `        $model = ${name.model}::query()->find($key);`,
      '',
      '        return $model === null ? null : $this->toItem($model);',
      '    }',
      '',
      '    public function add(array $item): array',
      '    {',
      `        $model = new ${name.model}();`,
      generated
        ? `        $model->fill(array_diff_key($this->toRow($item), [${phpString(keyColumn)} => true]));`
        : '        $model->fill($this->toRow($item));',
      '        $model->save();',
      '',
      '        return $this->toItem($model->fresh() ?? $model);',
      '    }',
      '',
      `    public function save(${key} $key, array $item): array`,
      '    {',
      `        $model = ${name.model}::query()->findOrFail($key);`,
      `        $model->fill(array_diff_key($this->toRow($item), [${phpString(keyColumn)} => true]));`,
      '        $model->save();',
      '',
      '        return $this->toItem($model->fresh() ?? $model);',
      '    }',
      '',
      `    public function delete(${key} $key): void`,
      '    {',
      `        ${name.model}::query()->whereKey($key)->delete();`,
      '    }',
      '',
      '    /**',
      '     * @param  array<string, mixed>  $item',
      '     * @return array<string, mixed> Every column: a field left out of the item is null, dates are in UTC.',
      '     */',
      '    private function toRow(array $item): array',
      '    {',
      '        return [',
      toRow,
      '        ];',
      '    }',
      '',
      '    /** @return array<string, mixed> */',
      `    private function toItem(${name.model} $model): array`,
      '    {',
      '        return [',
      toItem,
      '        ];',
      '    }',
      '}',
    ]),
  )
  return files
}

function isScalar(field: SpecField, scalar: string): boolean {
  return !field.reference && field.type.kind === 'scalar' && field.type.scalar === scalar
}

/** Whether a field is stored as JSON: lists, maps, embedded objects and values of any shape. */
function storedAsJson(field: SpecField): boolean {
  return field.type.kind === 'array' || field.type.kind === 'map' || field.type.kind === 'object' || isScalar(field, 'any')
}

/** The Eloquent cast of a field, when its column does not read back as its JSON type. */
function castOf(context: LaravelContext, field: SpecField): string | null {
  if (storedAsJson(field)) return 'array'
  if (field.reference) {
    const target = context.spec.resources.find((item) => item.name === field.reference)!
    return target.key.type.scalar === 'integer' ? 'integer' : null
  }
  if (field.type.kind === 'enum') {
    const item = context.spec.enums.find((entry) => entry.name === (field.type as { name: string }).name)
    return item?.valueType === 'integer' ? 'integer' : null
  }
  if (field.type.kind !== 'scalar') return null
  switch (field.type.scalar) {
    case 'integer':
      return 'integer'
    case 'float':
    case 'decimal':
      return 'float'
    case 'boolean':
      return 'boolean'
    case 'datetime':
      return 'immutable_datetime'
    default:
      return null
  }
}

/** The Eloquent model of a resource. */
export function modelFile(context: LaravelContext, resource: SpecResource): GeneratedFile | null {
  if (!context.eloquent) return null
  const namespace = context.layout.resource(resource, 'model')
  const name = names(resource)
  const imports = new PhpImports(namespace)
  const generated = resource.key.generated
  if (generated === 'uuid') imports.add('Illuminate\\Database\\Eloquent\\Concerns\\HasUuids')
  const casts = resource.fields
    .map((field) => [column(field), castOf(context, field)] as const)
    .filter(([, cast]) => cast !== null)
    .map(([name, cast]) => `            ${phpString(name)} => ${phpString(cast!)},`)
  const content = lines(
    ...phpHeader(namespace, imports),
    resource.todo && `// TODO: ${resource.todo}`,
    phpDoc(`A row of the ${name.table} table.`),
    `final class ${name.model} extends \\Illuminate\\Database\\Eloquent\\Model`,
    '{',
    generated === 'uuid' && ['    use HasUuids;', ''],
    `    protected $table = ${phpString(name.table)};`,
    '',
    `    protected $primaryKey = ${phpString(column(keyField(resource)))};`,
    '',
    `    protected $keyType = ${phpString(keyType(resource))};`,
    '',
    `    public $incrementing = ${generated === 'increment' ? 'true' : 'false'};`,
    '',
    '    public $timestamps = false;',
    '',
    '    protected $guarded = [];',
    '',
    '    /** Date-times are stored in UTC with microseconds, so they read back as they were written */',
    "    protected $dateFormat = 'Y-m-d H:i:s.u';",
    '',
    '    /** @return array<string, string> */',
    '    protected function casts(): array',
    '    {',
    casts.length > 0 ? ['        return [', casts, '        ];'] : '        return [];',
    '    }',
    '}',
  )
  return { path: classPath(namespace, name.model), content: fileText(content) }
}

/** The column definition of a field in a migration. */
function columnDefinition(context: LaravelContext, field: SpecField): string {
  const name = phpString(column(field))
  if (storedAsJson(field)) return `$table->json(${name})`
  if (field.reference) {
    const target = context.spec.resources.find((item) => item.name === field.reference)!
    if (target.key.type.scalar === 'integer') return `$table->unsignedBigInteger(${name})`
    if (target.key.type.scalar === 'uuid') return `$table->uuid(${name})`
    return `$table->string(${name}, ${keyField(target).constraints.maxLength ?? 191})`
  }
  if (field.type.kind === 'enum') {
    const item = context.spec.enums.find((entry) => entry.name === (field.type as { name: string }).name)
    return item?.valueType === 'integer' ? `$table->integer(${name})` : `$table->string(${name}, 64)`
  }
  if (field.type.kind !== 'scalar') return `$table->text(${name})`
  switch (field.type.scalar) {
    case 'string':
      return field.constraints.maxLength !== undefined && field.constraints.maxLength <= 255
        ? `$table->string(${name}, ${field.constraints.maxLength})`
        : `$table->text(${name})`
    case 'integer':
      return field.type.bits === 64 ? `$table->bigInteger(${name})` : `$table->integer(${name})`
    case 'float':
      return `$table->double(${name})`
    case 'decimal':
      return `$table->decimal(${name}, 18, 4)`
    case 'boolean':
      return `$table->boolean(${name})`
    case 'date':
      return `$table->date(${name})`
    case 'datetime':
      return `$table->dateTime(${name}, 6)`
    case 'time':
      return `$table->string(${name}, 15)`
    case 'uuid':
      return `$table->uuid(${name})`
    default:
      return `$table->text(${name})`
  }
}

/** The key column of a resource's table. */
function keyDefinition(resource: SpecResource): string {
  const name = phpString(column(keyField(resource)))
  if (resource.key.generated === 'increment') return `$table->id(${name})`
  if (resource.key.type.scalar === 'integer') return `$table->bigInteger(${name})->primary()`
  if (resource.key.type.scalar === 'uuid' || resource.key.generated === 'uuid') return `$table->uuid(${name})->primary()`
  return `$table->string(${name}, ${keyField(resource).constraints.maxLength ?? 191})->primary()`
}

/** The migration that creates the tables, one per resource. */
export function migrationFile(context: LaravelContext): GeneratedFile | null {
  if (!context.eloquent) return null
  const creates = context.spec.resources.map((resource) => {
    const name = names(resource)
    const definitions = resource.fields
      .filter((field) => field.name !== resource.key.field)
      .map((field) => `            ${columnDefinition(context, field)}->nullable();`)
    return lines(
      `        Schema::create(${phpString(name.table)}, function (Blueprint $table): void {`,
      `            ${keyDefinition(resource)};`,
      definitions,
      '        });',
    )
  })
  const drops = [...context.spec.resources]
    .reverse()
    .map((resource) => `        Schema::dropIfExists(${phpString(names(resource).table)});`)
  const content = lines(
    '<?php',
    '',
    'use Illuminate\\Database\\Migrations\\Migration;',
    'use Illuminate\\Database\\Schema\\Blueprint;',
    'use Illuminate\\Support\\Facades\\Schema;',
    '',
    '// The tables of the API. Every column but the key accepts null: the requests check what is required.',
    'return new class extends Migration',
    '{',
    '    public function up(): void',
    '    {',
    creates.join('\n\n'),
    '    }',
    '',
    '    public function down(): void',
    '    {',
    drops,
    '    }',
    '};',
  )
  return { path: 'database/migrations/0001_01_01_000000_create_api_tables.php', content: fileText(content) }
}
