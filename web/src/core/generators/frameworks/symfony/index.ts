/**
 * Symfony generator: writes a PHP project with Symfony 8, its Validator, and Doctrine ORM when it is chosen.
 * It composes the modules of this folder and the writers every PHP framework shares (languages/php/); each
 * writes one kind of file.
 */
import type { GeneratedFile, Generator } from '../../common/types.ts'
import { enumFiles } from '../../languages/php/model.ts'
import { serviceFile } from '../../languages/php/service.ts'
import { valuesFile } from '../../languages/php/storage.ts'
import { exceptionFiles, listingFiles } from '../../languages/php/support.ts'
import { baseControllerFile, configFiles, errorSubscriberFile, jsonBodyFile, kernelFiles, securityFiles } from './app.ts'
import { createContext } from './context.ts'
import { inputFile } from './input.ts'
import { entityFile, repositoryFiles } from './persistence.ts'
import { composerFile, envFiles, gitignoreFile, phpunitFile, readmeFile } from './project.ts'
import { testFiles } from './tests.ts'
import { controllerFile, presenterFile } from './web.ts'

export const symfonyGenerator: Generator = {
  framework: 'symfony',
  serverUrl: 'http://localhost:8000',
  generate({ spec, settings, openApi }) {
    const context = createContext(spec, settings)
    const code: (GeneratedFile | null)[] = [
      ...kernelFiles(),
      ...configFiles(context),
      ...exceptionFiles(context),
      errorSubscriberFile(),
      ...listingFiles(context),
      valuesFile(context),
      jsonBodyFile(),
      baseControllerFile(),
      ...securityFiles(context),
      ...enumFiles(context, context.layout.enums()),
    ]
    for (const resource of spec.resources) {
      code.push(
        inputFile(context, resource),
        presenterFile(context, resource),
        entityFile(context, resource),
        ...repositoryFiles(context, resource),
        serviceFile(context, resource),
        controllerFile(context, resource),
      )
    }
    return [
      readmeFile(context),
      composerFile(context),
      phpunitFile(),
      ...envFiles(context),
      gitignoreFile(),
      { path: 'openapi.yaml', content: openApi },
      ...code.filter((file): file is GeneratedFile => file !== null),
      ...testFiles(context),
    ]
  },
}
