/**
 * Storage of each resource in the Express project: the repository interface the service depends on, and
 * the implementation of the chosen persistence:
 * - `memory`: a Map, to run the API without a database
 * - `none`: every method throws "not implemented" (501), with a TODO where the storage goes
 */
import type { SpecResource } from '../../../api/spec.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { TsImports, tsDoc, tsString } from '../../languages/typescript/typescript.ts'
import { importPath, keyField, keyType, names, type ExpressContext } from './context.ts'

export function repositoryFile(context: ExpressContext, resource: SpecResource): GeneratedFile {
  const path = context.layout.resource(resource, 'repository')
  const name = names(resource)
  const key = keyType(resource)
  const keyWire = keyField(resource).wire
  const generated = resource.key.generated
  const imports = new TsImports()
  imports.addType(importPath(path, 'src/listing.ts'), 'ListQuery', 'ListResult')
  imports.addType(importPath(path, context.layout.resource(resource, 'schemas')), name.record)
  // What `add` receives: the record without the key when the server generates it
  const newType = generated ? `Omit<${name.record}, ${tsString(keyWire)}>` : name.record
  const contract = lines(
    `/** Where ${resource.plural} are kept. The service depends only on this interface. */`,
    `export interface ${name.repository} {`,
    `  /** Items equal to every filter, in order, within the window; and how many match. */`,
    `  list(query: ListQuery): Promise<ListResult<${name.record}>>`,
    `  /** The item with this key, or undefined. */`,
    `  get(key: ${key}): Promise<${name.record} | undefined>`,
    `  /** Stores a new item${generated ? ' and assigns its key' : ''}; returns it as stored. */`,
    `  add(values: ${newType}): Promise<${name.record}>`,
    '  /** Changes the given fields of an existing item and returns it. */',
    `  update(key: ${key}, values: Partial<${name.record}>): Promise<${name.record}>`,
    '  /** Removes an existing item. */',
    `  delete(key: ${key}): Promise<void>`,
    '}',
  )
  let implementation: string
  if (context.pending) {
    imports.add(importPath(path, 'src/errors.ts'), 'NotImplementedError')
    const pending = (signature: string) => [
      `  async ${signature} {`,
      `    // TODO: store ${resource.plural} in your database`,
      `    throw new NotImplementedError(${tsString(`The storage of ${resource.plural} is not written yet`)})`,
      '  }',
    ]
    implementation = lines(
      `/** Storage of ${resource.plural} to write: every method answers 501 until it is implemented. */`,
      `export class ${name.pendingRepository} implements ${name.repository} {`,
      pending(`list(_query: ListQuery): Promise<ListResult<${name.record}>>`),
      '',
      pending(`get(_key: ${key}): Promise<${name.record} | undefined>`),
      '',
      pending(`add(_values: ${newType}): Promise<${name.record}>`),
      '',
      pending(`update(_key: ${key}, _values: Partial<${name.record}>): Promise<${name.record}>`),
      '',
      pending(`delete(_key: ${key}): Promise<void>`),
      '}',
    )
  } else {
    if (generated === 'uuid') imports.add('node:crypto', 'randomUUID')
    const assign =
      generated === 'increment'
        ? [`    const record = { ...structuredClone(values), ${keyProperty(keyWire)}: this.nextKey++ } as ${name.record}`]
        : generated === 'uuid'
          ? [`    const record = { ...structuredClone(values), ${keyProperty(keyWire)}: randomUUID() } as ${name.record}`]
          : ['    const record = structuredClone(values)']
    implementation = lines(
      `/** Keeps ${resource.plural} in memory: they are lost when the application stops. Use it to try the API. */`,
      `export class ${name.memory} implements ${name.repository} {`,
      `  private readonly items = new Map<${key}, ${name.record}>()`,
      generated === 'increment' && '  private nextKey = 1',
      '',
      `  async list(query: ListQuery): Promise<ListResult<${name.record}>> {`,
      '    const value = (item: unknown, field: string) => (item as Record<string, unknown>)[field]',
      '    let items = [...this.items.values()].filter((item) => Object.entries(query.filters).every(([field, expected]) => value(item, field) === expected))',
      '    if (query.sort) {',
      '      const { field, descending } = query.sort',
      '      // Items without a value go last, whatever the order',
      '      const present = items.filter((item) => value(item, field) != null)',
      '      present.sort((a, b) => {',
      '        const left = value(a, field) as string | number',
      '        const right = value(b, field) as string | number',
      '        const order = left < right ? -1 : left > right ? 1 : 0',
      '        return descending ? -order : order',
      '      })',
      '      items = [...present, ...items.filter((item) => value(item, field) == null)]',
      '    }',
      '    const end = query.limit === undefined ? undefined : query.offset + query.limit',
      '    return { items: items.slice(query.offset, end).map((item) => structuredClone(item)), total: items.length }',
      '  }',
      '',
      `  async get(key: ${key}): Promise<${name.record} | undefined> {`,
      '    const item = this.items.get(key)',
      '    return item === undefined ? undefined : structuredClone(item)',
      '  }',
      '',
      `  async add(values: ${newType}): Promise<${name.record}> {`,
      assign,
      `    this.items.set(${keyAccess(keyWire)}, record)`,
      '    return structuredClone(record)',
      '  }',
      '',
      `  async update(key: ${key}, values: Partial<${name.record}>): Promise<${name.record}> {`,
      '    const record = { ...this.items.get(key)!, ...structuredClone(values) }',
      '    this.items.set(key, record)',
      '    return structuredClone(record)',
      '  }',
      '',
      `  async delete(key: ${key}): Promise<void> {`,
      '    this.items.delete(key)',
      '  }',
      '}',
    )
  }
  const content = lines(tsDoc(`Storage of ${resource.plural}.`), '', imports.render(), '', contract, '', implementation)
  return { path, content: fileText(content) }
}

function keyProperty(wire: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(wire) ? wire : tsString(wire)
}

function keyAccess(wire: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(wire) ? `record.${wire}` : `record[${tsString(wire)}]`
}
