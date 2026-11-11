/**
 * TypeORM storage of the NestJS project: one entity per resource, with column types that work the same on
 * PostgreSQL, MySQL and MariaDB (dates as ISO text, embedded objects and lists as JSON text, exact numbers
 * read back as numbers), and a repository that implements the resource's storage interface with it.
 */
import type { SpecField, SpecResource } from '../../../api/spec.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { TsImports, tsAccess, tsDoc, tsProperty, tsString } from '../../languages/typescript/typescript.ts'
import { importPath, keyField, keyType, names, resourcePath, type NestContext } from './context.ts'
import { tsTypeOf } from './dto.ts'

/** The column options of a field. */
function column(context: NestContext, resource: SpecResource, field: SpecField, imports: TsImports): string {
  const isKey = field.name === resource.key.field
  if (isKey && resource.key.generated === 'increment') {
    imports.add('typeorm', 'PrimaryGeneratedColumn')
    return '@PrimaryGeneratedColumn()'
  }
  if (isKey && resource.key.generated === 'uuid') {
    imports.add('typeorm', 'PrimaryGeneratedColumn')
    return "@PrimaryGeneratedColumn('uuid')"
  }
  const options: string[] = []
  const type = field.type
  const scalar =
    field.reference && type.kind !== 'array'
      ? context.spec.resources.find((item) => item.name === field.reference)!.key.type.scalar
      : type.kind === 'scalar'
        ? type.scalar
        : null
  if (type.kind === 'object' || type.kind === 'array' || type.kind === 'map' || scalar === 'any') options.push("type: 'simple-json'")
  else if (type.kind === 'enum') options.push("type: 'varchar'", 'length: 64')
  else {
    switch (scalar) {
      case 'integer':
        if (field.type.kind === 'scalar' && field.type.bits === 64) {
          imports.add(importPath(resourcePath(resource, 'entity'), 'src/common/columns.ts'), 'numeric')
          options.push("type: 'bigint'", 'transformer: numeric')
        } else options.push("type: 'int'")
        break
      case 'float':
        options.push("type: 'double precision'")
        break
      case 'decimal':
        imports.add(importPath(resourcePath(resource, 'entity'), 'src/common/columns.ts'), 'numeric')
        // Read back as a number, as the API sends it
        options.push("type: 'decimal'", 'precision: 18', 'scale: 4', 'transformer: numeric')
        break
      case 'boolean':
        options.push("type: 'boolean'")
        break
      case 'uuid':
        options.push("type: 'varchar'", 'length: 36')
        break
      case 'date':
      case 'datetime':
      case 'time':
      case 'duration':
        // ISO text: the same on every database
        options.push("type: 'varchar'", 'length: 40')
        break
      default:
        if (field.constraints.maxLength !== undefined || isKey || field.reference)
          options.push("type: 'varchar'", `length: ${field.constraints.maxLength ?? 255}`)
        else options.push("type: 'text'")
    }
  }
  if (!isKey && (field.nullable || !field.required || field.server === 'pending')) options.push('nullable: true')
  if (isKey) {
    imports.add('typeorm', 'PrimaryColumn')
    return `@PrimaryColumn({ ${options.join(', ')} })`
  }
  imports.add('typeorm', 'Column')
  return `@Column({ ${options.join(', ')} })`
}

export function entityFile(context: NestContext, resource: SpecResource): GeneratedFile | null {
  if (!context.typeorm) return null
  const path = resourcePath(resource, 'entity')
  const name = names(resource)
  const imports = new TsImports().add('typeorm', 'Entity')
  const fields = resource.fields.map((field) => {
    const decorator = column(context, resource, field, imports)
    const type = field.reference
      ? field.type.kind === 'array'
        ? `${keyType(context.spec.resources.find((item) => item.name === field.reference)!)}[]`
        : keyType(context.spec.resources.find((item) => item.name === field.reference)!)
      : tsTypeOf(field.type)
    if (
      field.type.kind === 'enum' ||
      field.type.kind === 'object' ||
      (field.type.kind === 'array' && (field.type.items.kind === 'object' || field.type.items.kind === 'enum'))
    ) {
      const inner = field.type.kind === 'array' ? field.type.items : field.type
      if (inner.kind === 'object' || inner.kind === 'enum') imports.addType(importPath(path, 'src/shared/shared.dto.ts'), tsTypeOf(inner))
    }
    return `  ${decorator}\n  ${tsProperty(field.wire)}!: ${type}${field.nullable || !field.required ? ' | null' : ''}`
  })
  const content = lines(
    tsDoc(`Table of ${resource.plural}. Dates are ISO text and embedded objects and lists JSON text, the same on every database.`),
    '',
    imports.render(),
    '',
    `@Entity({ name: ${tsString(resource.plural.replace(/ /g, '_'))} })`,
    `export class ${name.entity} {`,
    fields.join('\n\n'),
    '}',
  )
  return { path, content: fileText(content) }
}

/** The repository class that keeps a resource with TypeORM. */
export function typeormRepositoryBlock(resource: SpecResource, imports: TsImports, path: string): string {
  const name = names(resource)
  const key = keyType(resource)
  const keyWire = keyField(resource).wire
  imports.add('@nestjs/typeorm', 'InjectRepository')
  imports.add('@nestjs/common', 'Injectable')
  imports.add('typeorm', 'Repository')
  imports.addType('typeorm', 'DeepPartial')
  imports.add(importPath(path, resourcePath(resource, 'entity')), name.entity)
  const newType = resource.key.generated ? `Omit<${name.record}, ${tsString(keyWire)}>` : name.record
  return lines(
    '/** A stored row as a record: empty columns become absent fields, as the API shows optional fields. */',
    `function toRecord(row: ${name.entity}): ${name.record} {`,
    `  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as unknown as ${name.record}`,
    '}',
    '',
    `/** Keeps ${resource.plural} in the database with TypeORM. */`,
    '@Injectable()',
    `export class ${name.typeormRepository} implements ${name.repository} {`,
    `  constructor(@InjectRepository(${name.entity}) private readonly data: Repository<${name.entity}>) {}`,
    '',
    `  async list(query: ListQuery): Promise<ListResult<${name.record}>> {`,
    `    const order = query.sort ? { [query.sort.field]: query.sort.descending ? 'DESC' : 'ASC', ${tsProperty(keyWire)}: 'ASC' } : { ${tsProperty(keyWire)}: 'ASC' }`,
    '    const [rows, total] = await this.data.findAndCount({',
    '      where: query.filters as never,',
    '      order: order as never,',
    '      skip: query.offset,',
    '      take: query.limit,',
    '    })',
    '    return { items: rows.map(toRecord), total }',
    '  }',
    '',
    `  async get(key: ${key}): Promise<${name.record} | undefined> {`,
    `    const row = await this.data.findOneBy({ ${tsProperty(keyWire)}: key } as never)`,
    '    return row ? toRecord(row) : undefined',
    '  }',
    '',
    `  async add(values: ${newType}): Promise<${name.record}> {`,
    `    const row = await this.data.save(this.data.create(values as DeepPartial<${name.entity}>))`,
    `    return (await this.get(${tsAccess('row', keyWire)} as ${key}))!`,
    '  }',
    '',
    `  async update(key: ${key}, values: Partial<${name.record}>): Promise<${name.record}> {`,
    `    const row = await this.data.findOneByOrFail({ ${tsProperty(keyWire)}: key } as never)`,
    `    await this.data.save(this.data.merge(row, values as DeepPartial<${name.entity}>))`,
    '    return (await this.get(key))!',
    '  }',
    '',
    `  async delete(key: ${key}): Promise<void> {`,
    `    await this.data.delete({ ${tsProperty(keyWire)}: key } as never)`,
    '  }',
    '}',
  )
}
