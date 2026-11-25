/**
 * The Swift generator: data access layers in Swift with async/await and no web framework, over Fluent, SQLKit or MongoKitten, the
 * strategy (orm.ts) it is given. Every file of the package, composed from the modules of this folder; each module writes one kind of file.
 */
import type { GeneratedFile } from '../../export/files.ts'
import type { Generator } from '../types.ts'
import { createContext, type Context } from './context.ts'
import { dtoFiles, updateFile } from './dtos.ts'
import type { SwiftOrm } from './orm.ts'
import { contractFile, envExampleFile, gitignoreFile, packageFile, readmeFile } from './project.ts'
import { repositoryFile } from './repositories.ts'
import { serviceFile } from './services.ts'
import { commonFile, errorsFile, unitOfWorkFile } from './support.ts'
import { canMake, testFiles } from './tests.ts'
import { planConversions } from '../../conversions/plan.ts'
import { conversionFiles, conversionTestFile, modelsPath, modelsTarget, servicePlans } from './conversions.ts'

function code(context: Context): GeneratedFile[] {
  const files: (GeneratedFile | null)[] = [
    ...context.orm.databaseFiles(context),
    errorsFile(context),
    commonFile(context),
    unitOfWorkFile(context),
  ]
  for (const info of context.tables) {
    if (info.writesEntity) files.push(...context.orm.entityFiles(context, info))
    files.push(repositoryFile(context, info))
    if (context.settings.services && info.service) {
      if (context.settings.serviceTypes === 'dtos') files.push(...dtoFiles(context, info))
      if (info.role === 'entity') files.push(updateFile(context, info))
      files.push(serviceFile(context, info))
    }
  }
  return files.filter((file): file is GeneratedFile => file !== null)
}

/** The files with the database types named as the strategy asks: `SqlUnitOfWork` is `MongoUnitOfWork` in a document database. */
function named(orm: SwiftOrm, files: GeneratedFile[]): GeneratedFile[] {
  const { prefix } = orm
  if (!prefix) return files
  const rename = (text: string) => text.replace(/\bSql(?=UnitOfWork\b|\w+Repository\b)/g, prefix)
  return files.map((file) => ({ ...file, content: rename(file.content) }))
}

export function swiftGenerator(orm: SwiftOrm): Generator {
  return {
    language: 'swift',
    orm: orm.id,
    generate({ schema, design, settings, models }) {
      const context = createContext(orm, schema, design, settings)
      const plans = models ? servicePlans(context, planConversions(schema, design, models, orm.documents === true)) : []
      const conversions = models ? conversionFiles(context, models.schema, plans) : []
      const tests = testFiles(context)
      const conversionTests =
        models && tests.length > 0 && (settings.tests === 'all' || settings.tests === 'services')
          ? conversionTestFile(context, plans, models.schema, (info) => canMake(context, info))
          : null
      const target =
        conversions.length > 0
          ? { target: modelsTarget(context), path: modelsPath(context), imported: settings.modelsSource === 'import' }
          : null
      return named(orm, [
        readmeFile(context),
        packageFile(context, target),
        envExampleFile(context),
        gitignoreFile(),
        contractFile(context),
        ...code(context),
        ...conversions,
        ...tests,
        ...(conversionTests ? [conversionTests] : []),
      ])
    },
  }
}
