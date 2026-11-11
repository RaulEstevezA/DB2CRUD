/**
 * How the application validates requests and answers errors: the same in production and in the tests.
 */

import type { INestApplication } from '@nestjs/common'
import { ErrorsFilter, validationPipe } from './common/errors'

export function configure(app: INestApplication): INestApplication {
  app.useGlobalPipes(validationPipe())
  app.useGlobalFilters(new ErrorsFilter())
  app.getHttpAdapter().getInstance().disable('x-powered-by')
  return app
}
