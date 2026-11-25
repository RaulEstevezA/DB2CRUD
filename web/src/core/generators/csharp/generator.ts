/**
 * The C# generator: .NET 10 data access layers with no web framework, over EF Core or ADO.NET, the strategy (orm.ts) it
 * is given. Every file of the project, composed from the modules of this folder; each module writes one kind of file.
 */
import type { GeneratedFile } from '../../export/files.ts'
import type { Generator } from '../types.ts'
import { createContext, type Context } from './context.ts'
import { dtoFiles } from './dtos.ts'
import { contractFile, envExampleFile, gitignoreFile, projectFiles, readmeFile } from './project.ts'
import { repositoryFiles } from './repositories.ts'
import { serviceFile } from './services.ts'
import { commonFiles, errorFiles, unitOfWorkFiles } from './support.ts'
import type { CsharpOrm } from './orm.ts'
import { canMake, testFiles } from './tests.ts'
import { planConversions } from '../../conversions/plan.ts'
import { conversionFiles, conversionTestFile, servicePlans } from './conversions.ts'

function code(context: Context): GeneratedFile[] {
  const files: (GeneratedFile | null)[] = [
    ...context.orm.databaseFiles(context),
    ...errorFiles(context),
    ...commonFiles(context),
    ...unitOfWorkFiles(context),
  ]
  for (const info of context.tables) {
    if (info.writesEntity) files.push(context.orm.entityFile(context, info))
    files.push(...repositoryFiles(context, info))
    if (context.settings.services && info.service) {
      files.push(...dtoFiles(context, info))
      files.push(serviceFile(context, info))
    }
  }
  return files.filter((file): file is GeneratedFile => file !== null)
}

/** The files with the database classes named as the strategy asks: `SqlUnitOfWork` is `MongoUnitOfWork` in a document database. */
function named(orm: CsharpOrm, files: GeneratedFile[]): GeneratedFile[] {
  const { prefix } = orm
  if (!prefix) return files
  const rename = (text: string) => text.replace(/\bSql(?=UnitOfWork\b|\w+Repository\b)/g, prefix)
  return files.map((file) => ({ ...file, path: rename(file.path), content: rename(file.content) }))
}

export function csharpGenerator(orm: CsharpOrm): Generator {
  return {
    language: 'csharp',
    orm: orm.id,
    generate({ schema, design, settings, models }) {
      const context = createContext(orm, schema, design, settings)
      const plans = models ? servicePlans(context, planConversions(schema, design, models, orm.documents === true)) : []
      const conversions = models ? conversionFiles(context, models.schema, plans) : []
      const tests = testFiles(context)
      const conversionTests =
        models && tests.length > 0 && (settings.tests === 'all' || settings.tests === 'services')
          ? conversionTestFile(context, plans, models.schema, (info) => canMake(context, info), context.orm.testMembers(context))
          : null
      return named(orm, [
        readmeFile(context),
        ...projectFiles(context, conversions.length > 0 && settings.modelsSource === 'import'),
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
