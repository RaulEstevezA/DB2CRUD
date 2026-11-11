/**
 * A Python generator for an ORM (Strategy of common/orm.ts): every file of the project, composed from the
 * modules of common/ and the ORM's own database layer. Each module writes one kind of file.
 */
import type { GeneratedFile } from '../../../export/files.ts'
import type { Generator } from '../../types.ts'
import { createContext, type Context } from './context.ts'
import { dtosFile } from './dtos.ts'
import type { PythonOrm } from './orm.ts'
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

export function pythonGenerator(orm: PythonOrm): Generator {
  return {
    language: 'python',
    orm: orm.id,
    generate({ schema, design, settings }) {
      const context = createContext(orm, schema, design, settings)
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
}
