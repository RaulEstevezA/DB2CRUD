/**
 * The Java generator: Java 21 + JPA (Hibernate 7) data access layers over an EntityManager, with no framework.
 * Every file of the project, composed from the modules of this folder; each module writes one kind of file.
 */
import type { GeneratedFile } from '../../export/files.ts'
import type { Generator } from '../types.ts'
import { createContext, type Context } from './context.ts'
import { dtoFiles } from './dtos.ts'
import { entityFile } from './entities.ts'
import { contractFile, envExampleFile, gitignoreFile, pomFile, readmeFile } from './project.ts'
import { repositoryFiles } from './repositories.ts'
import { serviceFile } from './services.ts'
import { commonFiles, databaseFile, errorFiles, unitOfWorkFiles } from './support.ts'
import { testFiles } from './tests.ts'

function code(context: Context): GeneratedFile[] {
  const files: (GeneratedFile | null)[] = [
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

export const javaGenerator: Generator = {
  language: 'java',
  orm: 'jpa',
  generate({ schema, design, settings }) {
    const context = createContext(schema, design, settings)
    return [
      readmeFile(context),
      pomFile(context),
      envExampleFile(context),
      gitignoreFile(),
      contractFile(context),
      ...code(context),
      ...testFiles(context),
    ]
  },
}
