/**
 * Types written in SQL inside ORM code (a Drizzle `customType`, a JPA `columnDefinition`), as the rules understand
 * them. SQLite keeps every integer in 64 bits and every real number in double precision.
 */
import type { DbType, Dialect } from '../../schema/types.ts'

/** The database type of a type written in SQL (`datetime`, `varchar(20)`, `numeric(10, 2)`), or null when the rules
 * do not know it. */
export function sqlTypeOf(text: string, dialect: Dialect | null): DbType | null {
  const sql = text.trim()
  const match = /^([a-z ]+?)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?$/i.exec(sql)
  if (!match) return null
  const name = match[1].toLowerCase()
  const size = match[2] !== undefined ? Number(match[2]) : undefined
  const scale = match[3] !== undefined ? Number(match[3]) : undefined
  if (/^(smallint|int2|tinyint)$/.test(name)) return { sql, kind: 'integer', bits: 16 }
  if (/^(int|integer|int4|mediumint)$/.test(name)) return { sql, kind: 'integer', bits: dialect === 'sqlite' ? 64 : 32 }
  if (/^(bigint|int8)$/.test(name)) return { sql, kind: 'integer', bits: 64 }
  if (/^(real|float4|float)$/.test(name)) return { sql, kind: 'float', bits: dialect === 'sqlite' ? 64 : 32 }
  if (/^(double|double precision|float8)$/.test(name)) return { sql, kind: 'float', bits: 64 }
  if (/^(decimal|numeric)$/.test(name))
    return { sql, kind: 'decimal', ...(size !== undefined ? { precision: size } : {}), ...(scale !== undefined ? { scale } : {}) }
  if (/^(varchar|character varying|nvarchar)$/.test(name))
    return size !== undefined ? { sql, kind: 'text', length: size } : { sql, kind: 'text' }
  if (/^(char|character|nchar)$/.test(name))
    return size !== undefined ? { sql, kind: 'text', length: size, fixed: true } : { sql, kind: 'text', fixed: true }
  if (/^(text|tinytext|mediumtext|longtext|citext|clob)$/.test(name)) return { sql, kind: 'text' }
  if (/^(boolean|bool)$/.test(name)) return { sql, kind: 'boolean' }
  if (name === 'date') return { sql, kind: 'date' }
  if (/^(time|time without time zone)$/.test(name)) return { sql, kind: 'time', timezone: false }
  if (/^(timetz|time with time zone)$/.test(name)) return { sql, kind: 'time', timezone: true }
  if (/^(datetime|timestamp|timestamp without time zone)$/.test(name)) return { sql, kind: 'datetime', timezone: false }
  if (/^(timestamptz|timestamp with time zone)$/.test(name)) return { sql, kind: 'datetime', timezone: true }
  if (/^(uuid|uniqueidentifier)$/.test(name)) return { sql, kind: 'uuid' }
  if (/^(json|jsonb)$/.test(name)) return { sql, kind: 'json' }
  if (/^(bytea|blob|binary|varbinary|longblob)$/.test(name))
    return size !== undefined ? { sql, kind: 'binary', length: size } : { sql, kind: 'binary' }
  return null
}
