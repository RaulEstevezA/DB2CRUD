/**
 * Tests of project files: what is saved is what is opened, and damaged files are never trusted.
 */
import { describe, expect, it } from 'vitest'
import { decide, updateEndpoint } from '../design/edit.ts'
import { example } from '../test/fixtures.ts'
import { EXAMPLES } from '../../examples/index.ts'
import { createProject, projectFileName, readProject } from './project.ts'

describe('project files', () => {
  it('opens what was saved', () => {
    const { design, settings } = example('store', { framework: 'fastapi', auth: 'jwt' }, (proposed) =>
      updateEndpoint(decide(proposed, { kind: 'expose', model: 'Address' }, 'resource'), 'Customer', 'Customer.list', {
        filters: ['name'],
      }),
    )
    const project = createProject({ format: 'typescript', text: EXAMPLES[0].text }, design, settings, new Date('2026-11-09T10:00:00Z'))
    const read = readProject(JSON.stringify(project))
    expect(read).toEqual({ ok: true, project })
    expect(projectFileName(settings)).toBe('shop-api.model2api.json')
  })

  it('refuses what is not a project', () => {
    expect(readProject('nope')).toEqual({ ok: false, error: 'notJson' })
    expect(readProject('{"format": "model2db-project", "version": 1}')).toEqual({ ok: false, error: 'notProject' })
    expect(readProject('{"format": "model2api-project", "version": 99, "input": {"text": ""}}')).toEqual({
      ok: false,
      error: 'newerVersion',
    })
    expect(readProject('{"format": "model2api-project", "version": 1}')).toEqual({ ok: false, error: 'noInput' })
  })

  it('drops damaged parts and normalizes the settings', () => {
    const text = JSON.stringify({
      format: 'model2api-project',
      version: 1,
      input: { text: 'interface A { id: number }', format: 'cobol' },
      design: {
        resources: [
          { model: 'A', expose: { value: 'resource' } },
          {
            model: 'B',
            expose: { value: 'resource', status: 'active', confidence: 'high', reasons: [], options: ['resource'] },
            endpoints: [{ id: 'x' }],
          },
        ],
      },
      settings: { framework: 'nope', persistence: 'jpa', name: 'My API' },
    })
    const read = readProject(text)
    if (!read.ok) throw new Error(read.error)
    expect(read.project.input.format).toBeNull()
    expect(read.project.design!.resources.map((resource) => resource.model)).toEqual(['B'])
    expect(read.project.design!.resources[0].endpoints).toEqual([])
    expect(read.project.settings).toMatchObject({ framework: 'fastapi', persistence: 'memory', name: 'my-api' })
  })
})
