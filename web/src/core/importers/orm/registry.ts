/**
 * The readers of ORM code, and the choice of one for the files given: each reader says how sure it is that the
 * files are its ORM's, and the surest one reads them. A reader never fails on code it does not understand: it
 * keeps what it can and leaves notes; only code with no table at all is refused.
 */
import type { DbSchema } from '../../schema/types.ts'
import { djangoReader } from './django.ts'
import { doctrineReader } from './doctrine.ts'
import { drizzleReader } from './drizzle.ts'
import { efcoreReader } from './efcore.ts'
import { eloquentReader } from './eloquent.ts'
import { jpaReader } from './jpa.ts'
import { mongodbReader } from './mongodb.ts'
import { mongooseReader } from './mongoose.ts'
import { prismaReader } from './prisma.ts'
import { documentsReader } from './documents.ts'
import { beanieReader } from './beanie.ts'
import { springDataReader } from './springdata.ts'
import { sequelizeReader } from './sequelize.ts'
import { sqlalchemyReader } from './sqlalchemy.ts'
import { sqlmodelReader } from './sqlmodel.ts'
import { tortoiseReader } from './tortoise.ts'
import { typeormReader } from './typeorm.ts'
import type { OrmReader, SourceFile } from './types.ts'

export const ORM_READERS: OrmReader[] = [
  sqlalchemyReader,
  sqlmodelReader,
  djangoReader,
  tortoiseReader,
  prismaReader,
  typeormReader,
  sequelizeReader,
  drizzleReader,
  jpaReader,
  efcoreReader,
  doctrineReader,
  eloquentReader,
  mongooseReader,
  mongodbReader,
  springDataReader,
  beanieReader,
  documentsReader,
]

/** The reader for these files, or null when none recognises them. */
export function detectOrm(files: SourceFile[]): OrmReader | null {
  let best: OrmReader | null = null
  let score = 0
  for (const reader of ORM_READERS) {
    const found = reader.detect(files)
    if (found > score) {
      best = reader
      score = found
    }
  }
  return best
}

export type OrmReadResult = { ok: true; schema: DbSchema; reader: OrmReader } | { ok: false; error: 'unknownOrm' | 'noTables' }

/** The schema the ORM code of these files declares. */
export function readOrmCode(files: SourceFile[]): OrmReadResult {
  const reader = detectOrm(files)
  if (!reader) return { ok: false, error: 'unknownOrm' }
  const schema = reader.read(files)
  if (schema.tables.length === 0) return { ok: false, error: 'noTables' }
  return { ok: true, schema, reader }
}
