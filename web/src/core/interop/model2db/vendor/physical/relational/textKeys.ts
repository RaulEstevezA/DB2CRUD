import type { Note, Table } from '../types.ts'
import type { RelationalBuild } from './build.ts'
import { DEFAULT_LENGTH } from './names.ts'

// Engines that cannot use an unbounded text (TEXT, CLOB, NVARCHAR(MAX)) in a key, a unique constraint or an index
const BOUNDED_KEYS = new Set(['mysql', 'mariadb', 'sqlserver', 'oracle'])

/** Texts without a length that a key, a unique constraint, a foreign key or an index uses get one, where the
 * engine needs it; a note says so. */
export function boundIndexedTexts(build: RelationalBuild, tables: Table[]) {
  if (!BOUNDED_KEYS.has(build.options.dialect)) return
  const notes: Note[] = []
  for (const table of tables) {
    const keyed = new Set([
      ...table.primaryKey,
      ...table.uniques.flatMap((unique) => unique.columns),
      ...table.indexes.flatMap((index) => index.columns),
      ...table.foreignKeys.flatMap((fk) => fk.columns),
    ])
    for (const column of table.columns) {
      if (!keyed.has(column.name) || column.type.kind !== 'primitive' || column.type.name !== 'string' || column.type.length) continue
      column.type = { ...column.type, length: DEFAULT_LENGTH }
      notes.push({ code: 'textKeyLength', params: { column: `${table.name}.${column.name}`, length: String(DEFAULT_LENGTH) } })
    }
  }
  build.notes.push(...notes)
}
