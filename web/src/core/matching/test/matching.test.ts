/**
 * The matching of application models with tables against shared/test-cases/matching/<case>/: schema.sql is the
 * database, models.<ext> the application models (read by the importers, or a Mapper project), expected.json the matching, which the
 * desktop version must give too (`UPDATE_SHARED=1 npx vitest run src/core/matching` writes them again).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { matchModels } from '../matching.ts'
import { MATCHING_CASES as FOLDER, readCase } from './cases.ts'
const UPDATE = process.env.UPDATE_SHARED === '1'

describe('matching application models with tables', () => {
  for (const name of existsSync(FOLDER) ? readdirSync(FOLDER).sort() : [])
    it(name, () => {
      const folder = join(FOLDER, name)
      const { database, models, project } = readCase(folder)
      const matching = matchModels(database, models, null, project)
      const path = join(folder, 'expected.json')
      if (UPDATE) writeFileSync(path, `${JSON.stringify(matching, null, 1)}\n`)
      else expect(matching).toEqual(JSON.parse(readFileSync(path, 'utf8')))
    })
})
