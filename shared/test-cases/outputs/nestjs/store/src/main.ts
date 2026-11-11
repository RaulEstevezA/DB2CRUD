/**
 * Entry point: starts the API on PORT (3000 by default).
 */

import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { configure } from './app.setup'

async function bootstrap(): Promise<void> {
  const app = configure(await NestFactory.create(AppModule))
  const port = Number(process.env.PORT ?? 3000)
  await app.listen(port)
  console.log(`API listening on http://localhost:${port}`)
}

void bootstrap()
