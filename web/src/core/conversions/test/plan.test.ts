/**
 * The conversion plans of shared/test-cases/matching/<case>/plan.json: the design proposed from the case's database
 * and models (with the matching as proposed), planned for every table with a model. The desktop version must give
 * the same plans (`UPDATE_SHARED=1 npx vitest run src/core/conversions` writes them again).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { proposeCrud } from '../../crud/propose.ts'
import { MATCHING_CASES, readCase } from '../../matching/test/cases.ts'
import { conversionsAvailable, planConversions, withoutHidden, type ConversionPlan } from '../plan.ts'

const UPDATE = process.env.UPDATE_SHARED === '1'

describe('conversion plans', () => {
  for (const name of existsSync(MATCHING_CASES) ? readdirSync(MATCHING_CASES).sort() : [])
    it(name, () => {
      const folder = join(MATCHING_CASES, name)
      const { database, models, project } = readCase(folder)
      const design = proposeCrud(database, null, models, project)
      const plans = planConversions(database, design, { schema: models, project }, database.dialect === 'mongodb')
      const path = join(folder, 'plan.json')
      if (UPDATE) writeFileSync(path, `${JSON.stringify(plans, null, 1)}\n`)
      else expect(plans).toEqual(JSON.parse(readFileSync(path, 'utf8')))
    })

  it('are written only for models in the language of the project, or in none', () => {
    const { models } = readCase(join(MATCHING_CASES, 'shop-typescript'))
    expect(conversionsAvailable({ schema: models }, 'typescript')).toEqual({ ok: true })
    expect(conversionsAvailable({ schema: models }, 'python')).toEqual({
      ok: false,
      reason: 'language',
      models: 'typescript',
      project: 'python',
    })
    expect(conversionsAvailable({ schema: { ...models, origin: { format: 'json' } } }, 'python')).toEqual({ ok: true })
  })

  it('leave to the user the fields read from a column the service never returns', () => {
    const plan: ConversionPlan = {
      table: 'customers',
      model: 'Customer',
      direction: 'both',
      write: [{ column: 'password_hash', value: { kind: 'field', path: ['passwordHash'] } }],
      read: [
        { field: 'email', value: { kind: 'column', column: 'email' } },
        { field: 'passwordHash', value: { kind: 'column', column: 'password_hash' } },
      ],
    }
    expect(withoutHidden(plan, ['password_hash'])).toEqual({
      ...plan,
      read: [plan.read![0], { field: 'passwordHash', value: { kind: 'todo', reason: 'hidden', detail: 'password_hash' } }],
    })
    expect(withoutHidden(plan, [])).toBe(plan)
  })
})
