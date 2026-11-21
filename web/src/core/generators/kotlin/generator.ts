/**
 * The Kotlin generator: Kotlin on the JVM + Exposed 1.6 (its DSL over JDBC) data access layers, with no web
 * framework. Every file of the project, composed from the modules of this folder; each module writes one kind of file.
 */
import type { GeneratedFile } from '../../export/files.ts'
import type { Generator } from '../types.ts'
import { createContext, type Context } from './context.ts'
import { dtoFiles } from './dtos.ts'
import { entityFile, enumColumnFile, tableObjectFile } from './entities.ts'
import { contractFile, envExampleFile, gitignoreFile, gradleFiles, readmeFile } from './project.ts'
import { repositoryFiles } from './repositories.ts'
import { serviceFile } from './services.ts'
import { commonFiles, databaseFile, errorsFile, unitOfWorkFiles } from './support.ts'
import { canMake, testFiles } from './tests.ts'
import { planConversions } from '../../conversions/plan.ts'
import { conversionFiles, conversionTestFile, servicePlans } from './conversions.ts'

function code(context: Context): GeneratedFile[] {
  const files: (GeneratedFile | null)[] = [
    databaseFile(context),
    errorsFile(context),
    enumColumnFile(context),
    ...commonFiles(context),
    ...unitOfWorkFiles(context),
  ]
  for (const info of context.tables) {
    if (info.writesEntity) files.push(entityFile(context, info), tableObjectFile(context, info))
    files.push(...repositoryFiles(context, info))
    if (context.settings.services && info.service) {
      files.push(...dtoFiles(context, info))
      files.push(serviceFile(context, info))
    }
  }
  return files.filter((file): file is GeneratedFile => file !== null)
}

export const kotlinGenerator: Generator = {
  language: 'kotlin',
  orm: 'exposed',
  generate({ schema, design, settings, models }) {
    const context = createContext(schema, design, settings)
    const plans = models ? servicePlans(context, planConversions(schema, design, models)) : []
    const conversions = models ? conversionFiles(context, models.schema, plans) : []
    const tests = testFiles(context)
    const conversionTests =
      models && tests.length > 0 && (settings.tests === 'all' || settings.tests === 'services')
        ? conversionTestFile(context, plans, models.schema, (info) => canMake(context, info))
        : null
    return [
      readmeFile(context),
      ...gradleFiles(context, conversions.length > 0 && settings.modelsSource === 'import'),
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
