/**
 * The C# generator: .NET 10 + EF Core 9 data access layers over AppDbContext, with no web framework. Every file of
 * the project, composed from the modules of this folder; each module writes one kind of file.
 */
import type { GeneratedFile } from '../../export/files.ts'
import type { Generator } from '../types.ts'
import { createContext, type Context } from './context.ts'
import { dtoFiles } from './dtos.ts'
import { dbContextFile, entityFile, pgEnumsFile } from './entities.ts'
import { contractFile, envExampleFile, gitignoreFile, projectFiles, readmeFile } from './project.ts'
import { repositoryFiles } from './repositories.ts'
import { serviceFile } from './services.ts'
import { commonFiles, databaseFile, errorFiles, unitOfWorkFiles } from './support.ts'
import { canMake, databaseMembers, testFiles } from './tests.ts'
import { planConversions } from '../../conversions/plan.ts'
import { conversionFiles, conversionTestFile, servicePlans } from './conversions.ts'

function code(context: Context): GeneratedFile[] {
  const files: (GeneratedFile | null)[] = [
    dbContextFile(context),
    pgEnumsFile(context),
    databaseFile(context),
    ...errorFiles(context),
    ...commonFiles(context),
    ...unitOfWorkFiles(context),
  ]
  for (const info of context.tables) {
    if (info.writesEntity) files.push(entityFile(context, info))
    files.push(...repositoryFiles(context, info))
    if (context.settings.services && info.service) {
      files.push(...dtoFiles(context, info))
      files.push(serviceFile(context, info))
    }
  }
  return files.filter((file): file is GeneratedFile => file !== null)
}

export const csharpGenerator: Generator = {
  language: 'csharp',
  orm: 'efcore',
  generate({ schema, design, settings, models }) {
    const context = createContext(schema, design, settings)
    const plans = models ? servicePlans(context, planConversions(schema, design, models)) : []
    const conversions = models ? conversionFiles(context, models.schema, plans) : []
    const tests = testFiles(context)
    const conversionTests =
      models && tests.length > 0 && (settings.tests === 'all' || settings.tests === 'services')
        ? conversionTestFile(context, plans, models.schema, (info) => canMake(context, info), databaseMembers(context))
        : null
    return [
      readmeFile(context),
      ...projectFiles(context, conversions.length > 0 && settings.modelsSource === 'import'),
      envExampleFile(context),
      gitignoreFile(),
      contractFile(context),
      ...code(context),
      ...conversions,
      ...tests,
      ...(conversionTests ? [conversionTests] : []),
    ]
  },
}
