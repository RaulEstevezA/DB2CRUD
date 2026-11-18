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
import { testFiles } from './tests.ts'

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
    generate({ schema, design, settings }) {
      const context = createContext(orm, schema, design, settings)
      const files: (GeneratedFile | null)[] = [
        readmeFile(context),
        composerFile(context),
        phpunitFile(context),
        envExampleFile(context),
        gitignoreFile(),
        contractFile(context),
        ...code(context),
        ...testFiles(context),
      ]
      return files.filter((file): file is GeneratedFile => file !== null)
    },
  }
}
