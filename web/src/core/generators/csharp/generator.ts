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
import { testFiles } from './tests.ts'

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
  generate({ schema, design, settings }) {
    const context = createContext(schema, design, settings)
    return [
      readmeFile(context),
      ...projectFiles(context),
      envExampleFile(context),
      gitignoreFile(),
      contractFile(context),
      ...code(context),
      ...testFiles(context),
    ]
  },
}
