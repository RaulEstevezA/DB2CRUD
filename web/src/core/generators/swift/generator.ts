/**
 * The Swift generator: Swift with async/await + FluentKit 1 (Fluent without Vapor) data access layers, with no web
 * framework. Every file of the package, composed from the modules of this folder; each module writes one kind of file.
 */
import type { GeneratedFile } from '../../export/files.ts'
import type { Generator } from '../types.ts'
import { createContext, type Context } from './context.ts'
import { dtoFiles, updateFile } from './dtos.ts'
import { entityFile, modelFile } from './entities.ts'
import { contractFile, envExampleFile, gitignoreFile, packageFile, readmeFile } from './project.ts'
import { repositoryFile } from './repositories.ts'
import { serviceFile } from './services.ts'
import { commonFile, databaseFile, errorsFile, unitOfWorkFile } from './support.ts'
import { testFiles } from './tests.ts'

function code(context: Context): GeneratedFile[] {
  const files: (GeneratedFile | null)[] = [databaseFile(context), errorsFile(context), commonFile(context), unitOfWorkFile(context)]
  for (const info of context.tables) {
    if (info.writesEntity) files.push(entityFile(context, info), modelFile(context, info))
    files.push(repositoryFile(context, info))
    if (context.settings.services && info.service) {
      if (context.settings.serviceTypes === 'dtos') files.push(...dtoFiles(context, info))
      if (info.role === 'entity') files.push(updateFile(context, info))
      files.push(serviceFile(context, info))
    }
  }
  return files.filter((file): file is GeneratedFile => file !== null)
}

export const swiftGenerator: Generator = {
  language: 'swift',
  orm: 'fluent',
  generate({ schema, design, settings }) {
    const context = createContext(schema, design, settings)
    return [
      readmeFile(context),
      packageFile(context),
      envExampleFile(context),
      gitignoreFile(),
      contractFile(context),
      ...code(context),
      ...testFiles(context),
    ]
  },
}
