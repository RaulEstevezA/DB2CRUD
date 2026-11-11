/**
 * A TypeScript generator for an ORM (Strategy of common/orm.ts): every file of the project, composed from the
 * modules of common/ and the ORM's own database layer. Each module writes one kind of file.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { Generator } from '../../types.ts'
import { createContext, type Context } from './context.ts'
import { dtosFile } from './dtos.ts'
import type { TsOrm } from './orm.ts'
import { contractFile, envExampleFile, gitignoreFile, packageFile, readmeFile, tsconfigFiles } from './project.ts'
import { repositoryFile } from './repositories.ts'
import { serviceFile } from './services.ts'
import { errorsFile, pagingFile } from './support.ts'
import { testFiles } from './tests.ts'
import { unitOfWorkFile } from './unitOfWork.ts'

function code(context: Context): GeneratedFile[] {
  const files: (GeneratedFile | null)[] = [
    ...context.orm.databaseFiles(context),
    errorsFile(),
    pagingFile(context),
    unitOfWorkFile(context),
  ]
  for (const info of context.tables) {
    files.push(repositoryFile(context, info))
    if (context.settings.services && info.service) {
      if (context.settings.serviceTypes === 'dtos') files.push(dtosFile(context, info))
      files.push(serviceFile(context, info))
    }
  }
  return files.filter((file): file is GeneratedFile => file !== null)
}

export function typescriptGenerator(orm: TsOrm): Generator {
  return {
    language: 'typescript',
    orm: orm.id,
    generate({ schema, design, settings }) {
      const context = createContext(orm, schema, design, settings)
      return [
        readmeFile(context),
        packageFile(context),
        ...tsconfigFiles(context),
        envExampleFile(context),
        gitignoreFile(),
        contractFile(context),
        ...code(context),
        ...testFiles(context),
      ]
    },
  }
}
