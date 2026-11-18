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
import { testFiles } from './tests.ts'

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
  generate({ schema, design, settings }) {
    const context = createContext(schema, design, settings)
    return [
      readmeFile(context),
      ...gradleFiles(context),
      envExampleFile(context),
      gitignoreFile(),
      contractFile(context),
      ...code(context),
      ...testFiles(context),
    ]
  },
}
