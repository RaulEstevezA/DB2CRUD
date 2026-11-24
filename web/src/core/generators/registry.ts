/**
 * Registry of the generators (Registry pattern). To support a new stack, write its generator (types.ts), add
 * it to `GENERATORS` and describe its options in settings/settings.ts.
 */
import { conversionsAvailable, type ApplicationModels } from '../conversions/plan.ts'
import type { CrudDesign } from '../crud/types.ts'
import type { GeneratedFile } from '../export/files.ts'
import type { DbSchema } from '../schema/types.ts'
import { normalizeSettings, type ProjectSettings } from '../settings/settings.ts'
import { csharpGenerator } from './csharp/generator.ts'
import { efcoreOrm } from './csharp/efcore/index.ts'
import { sqlOrm as csharpSqlOrm } from './csharp/sql/index.ts'
import { javaGenerator } from './java/generator.ts'
import { jpaOrm } from './java/jpa/index.ts'
import { springDataOrm } from './java/springdata/index.ts'
import { sqlOrm as javaSqlOrm } from './java/sql/index.ts'
import { exposedOrm } from './kotlin/exposed/index.ts'
import { sqlOrm as kotlinSqlOrm } from './kotlin/sql/index.ts'
import { kotlinGenerator } from './kotlin/generator.ts'
import { seaormOrm } from './rust/seaorm/index.ts'
import { sqlOrm as rustSqlOrm } from './rust/sql/index.ts'
import { rustGenerator } from './rust/generator.ts'
import { fluentOrm } from './swift/fluent/index.ts'
import { sqlOrm as swiftSqlOrm } from './swift/sql/index.ts'
import { swiftGenerator } from './swift/generator.ts'
import { phpGenerator } from './php/common/generator.ts'
import { doctrineOrm } from './php/doctrine/index.ts'
import { sqlOrm as phpSqlOrm } from './php/sql/index.ts'
import { eloquentOrm } from './php/eloquent/index.ts'
import { pythonGenerator } from './python/common/generator.ts'
import { djangoOrm } from './python/django/index.ts'
import { sqlalchemyOrm } from './python/sqlalchemy/index.ts'
import { beanieOrm } from './python/beanie/index.ts'
import { sqlOrm as pythonSqlOrm } from './python/sql/index.ts'
import type { Generator } from './types.ts'
import { typescriptGenerator } from './typescript/common/generator.ts'
import { drizzleOrm } from './typescript/drizzle/index.ts'
import { mongooseOrm } from './typescript/mongoose/index.ts'
import { prismaOrm } from './typescript/prisma/index.ts'
import { sequelizeOrm } from './typescript/sequelize/index.ts'
import { sqlOrm as typescriptSqlOrm } from './typescript/sql/index.ts'
import { typeormOrm } from './typescript/typeorm/index.ts'

export const GENERATORS: readonly Generator[] = [
  pythonGenerator(sqlalchemyOrm),
  pythonGenerator(djangoOrm),
  pythonGenerator(pythonSqlOrm),
  pythonGenerator(beanieOrm),
  typescriptGenerator(typeormOrm),
  typescriptGenerator(prismaOrm),
  typescriptGenerator(drizzleOrm),
  typescriptGenerator(sequelizeOrm),
  typescriptGenerator(typescriptSqlOrm),
  typescriptGenerator(mongooseOrm),
  javaGenerator(jpaOrm),
  javaGenerator(javaSqlOrm),
  javaGenerator(springDataOrm),
  csharpGenerator(efcoreOrm),
  csharpGenerator(csharpSqlOrm),
  phpGenerator(doctrineOrm),
  phpGenerator(eloquentOrm),
  phpGenerator(phpSqlOrm),
  kotlinGenerator(exposedOrm),
  kotlinGenerator(kotlinSqlOrm),
  rustGenerator(seaormOrm),
  rustGenerator(rustSqlOrm),
  swiftGenerator(fluentOrm),
  swiftGenerator(swiftSqlOrm),
]

export function findGenerator(settings: Pick<ProjectSettings, 'language' | 'orm'>): Generator | undefined {
  return GENERATORS.find((generator) => generator.language === settings.language && generator.orm === settings.orm)
}

/** The files of the project, sorted by path, for settings made consistent first. */
/** The design without the operations on one item of a list, which only document databases have. */
function withoutItems(design: CrudDesign, settings: ProjectSettings): CrudDesign {
  if (settings.database === 'mongodb') return design
  const whole = <T extends { kind: string }>(items: T[]) => items.filter((item) => item.kind !== 'addItem' && item.kind !== 'removeItem')
  return {
    ...design,
    repositories: design.repositories.map((item) => ({ ...item, queries: whole(item.queries) })),
    services: design.services.map((item) => ({ ...item, operations: whole(item.operations) })),
  }
}

/**
 * The files of the project. With application models, their conversions are written only when the models are in the
 * project's language, or in none (`conversionsAvailable`); otherwise the project is the one without models.
 */
export function generateProject(
  schema: DbSchema,
  design: CrudDesign,
  settings: Partial<ProjectSettings>,
  models: ApplicationModels | null = null,
): GeneratedFile[] {
  const normalized = normalizeSettings(settings)
  const generator = findGenerator(normalized)
  if (!generator) return []
  const usable = models && conversionsAvailable(models, normalized.language).ok ? models : null
  return generator
    .generate({ schema, design: withoutItems(design, normalized), settings: normalized, models: usable })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
