/**
 * A PHP generator for an ORM (Strategy of common/orm.ts): every file of the project, composed from the modules of
 * common/ and the ORM's own entities, connection and repository bodies. Each module writes one kind of file.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { Generator } from '../../types.ts'
import { createContext, type Context } from './context.ts'
import { dtoFiles } from './dtos.ts'
import type { PhpOrm } from './orm.ts'
import { composerFile, contractFile, envExampleFile, gitignoreFile, phpunitFile, readmeFile } from './project.ts'
import { repositoryFiles } from './repositories.ts'
import { serviceFile } from './services.ts'
import { commonFiles, errorFiles, unitOfWorkFiles } from './support.ts'
import { canMake, databaseMembers, testFiles } from './tests.ts'
import { planConversions } from '../../../conversions/plan.ts'
import { conversionFiles, conversionTestFile, modelsNamespace, servicePlans } from './conversions.ts'

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

export function phpGenerator(orm: PhpOrm): Generator {
  return {
    language: 'php',
    orm: orm.id,
    generate({ schema, design, settings, models }) {
      const context = createContext(orm, schema, design, settings)
      const plans = models ? servicePlans(context, planConversions(schema, design, models)) : []
      const conversions = models ? conversionFiles(context, models.schema, plans) : []
      const tests = testFiles(context)
      const conversionTests =
        models && tests.length > 0 && (settings.tests === 'all' || settings.tests === 'services')
          ? conversionTestFile(
              context,
              plans,
              models.schema,
              (info) => canMake(context, info),
              (uses) => databaseMembers(context, uses),
            )
          : null
      const files: (GeneratedFile | null)[] = [
        readmeFile(context),
        composerFile(context, conversions.length > 0 && settings.modelsSource === 'import' ? modelsNamespace(context) : null),
        phpunitFile(context),
        envExampleFile(context),
        gitignoreFile(),
        contractFile(context),
        ...code(context),
        ...conversions,
        ...tests,
        conversionTests,
      ]
      return files.filter((file): file is GeneratedFile => file !== null)
    },
  }
}
