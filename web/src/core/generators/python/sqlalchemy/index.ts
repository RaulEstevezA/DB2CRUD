/**
 * Python + SQLAlchemy 2 generator: entities (when they are missing), repositories, a unit of work, services
 * and tests, synchronous or asynchronous, with every project setting (docs/design.md, section 4). It
 * composes the modules of this folder; each writes one kind of file.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { Generator } from '../../types.ts'
import { createContext, type Context } from './context.ts'
import { dbFile, entityFiles } from './database.ts'
import { dtosFile } from './dtos.ts'
import { contractFile, envExampleFile, gitignoreFile, pyprojectFile, readmeFile, requirementsFiles } from './project.ts'
import { repositoryFile } from './repositories.ts'
import { serviceFile } from './services.ts'
import { errorsFile, pagingFile } from './support.ts'
import { testFiles } from './tests.ts'
import { unitOfWorkFile } from './unitOfWork.ts'

/** Empty `__init__.py` files that make every folder of `app/` a package. */
function packages(files: GeneratedFile[]): GeneratedFile[] {
  const folders = new Set<string>()
  for (const file of files) {
    if (!file.path.startsWith('app/')) continue
    const parts = file.path.split('/').slice(0, -1)
    for (let index = 1; index <= parts.length; index++) folders.add(parts.slice(0, index).join('/'))
  }
  return [...folders].sort().map((folder) => ({ path: `${folder}/__init__.py`, content: '' }))
}

function code(context: Context): GeneratedFile[] {
  const files: (GeneratedFile | null)[] = [
    dbFile(context),
    errorsFile(),
    pagingFile(context),
    unitOfWorkFile(context),
    ...entityFiles(context),
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

export const sqlalchemyGenerator: Generator = {
  language: 'python',
  orm: 'sqlalchemy',
  generate({ schema, design, settings }) {
    const context = createContext(schema, design, settings)
    const app = code(context)
    return [
      readmeFile(context),
      pyprojectFile(context),
      ...requirementsFiles(context),
      envExampleFile(context),
      gitignoreFile(),
      contractFile(context),
      ...app,
      ...packages(app),
      ...testFiles(context),
    ]
  },
}
