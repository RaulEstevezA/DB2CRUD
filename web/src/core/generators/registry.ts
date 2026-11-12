/**
 * Registry of the generators (Registry pattern). To support a new stack, write its generator (types.ts), add
 * it to `GENERATORS` and describe its options in settings/settings.ts.
 */
import type { CrudDesign } from '../crud/types.ts'
import type { GeneratedFile } from '../export/files.ts'
import type { DbSchema } from '../schema/types.ts'
import { normalizeSettings, type ProjectSettings } from '../settings/settings.ts'
import { pythonGenerator } from './python/common/generator.ts'
import { djangoOrm } from './python/django/index.ts'
import { sqlalchemyOrm } from './python/sqlalchemy/index.ts'
import type { Generator } from './types.ts'
import { typescriptGenerator } from './typescript/common/generator.ts'
import { drizzleOrm } from './typescript/drizzle/index.ts'
import { prismaOrm } from './typescript/prisma/index.ts'
import { sequelizeOrm } from './typescript/sequelize/index.ts'
import { typeormOrm } from './typescript/typeorm/index.ts'

export const GENERATORS: readonly Generator[] = [
  pythonGenerator(sqlalchemyOrm),
  pythonGenerator(djangoOrm),
  typescriptGenerator(typeormOrm),
  typescriptGenerator(prismaOrm),
  typescriptGenerator(drizzleOrm),
  typescriptGenerator(sequelizeOrm),
]

export function findGenerator(settings: Pick<ProjectSettings, 'language' | 'orm'>): Generator | undefined {
  return GENERATORS.find((generator) => generator.language === settings.language && generator.orm === settings.orm)
}

/** The files of the project, sorted by path, for settings made consistent first. */
export function generateProject(schema: DbSchema, design: CrudDesign, settings: Partial<ProjectSettings>): GeneratedFile[] {
  const normalized = normalizeSettings(settings)
  const generator = findGenerator(normalized)
  if (!generator) return []
  return generator.generate({ schema, design, settings: normalized }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
