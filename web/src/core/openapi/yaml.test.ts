/**
 * Tests of the YAML writer: what it writes reads back as the same data, and for the contracts of the
 * examples it writes the same text as the `yaml` library.
 */
import { describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import type { ExampleId } from '../../examples/index.ts'
import { example } from '../test/fixtures.ts'
import { buildOpenApi } from './build.ts'
import { toYaml, type YamlValue } from './yaml.ts'

const TEXTS = [
  '',
  ' ',
  'plain text',
  'true',
  'False',
  'null',
  '~',
  '42',
  '-7',
  '3.14',
  '1e5',
  '.inf',
  '0x1F',
  '0o17',
  '- item',
  '-',
  '?',
  '? question',
  'key: value',
  'ends with colon:',
  'a # comment',
  'a#b',
  '#hash',
  '@at',
  '`tick',
  '*star',
  '&anchor',
  '!tag',
  '|pipe',
  '>fold',
  '%percent',
  '---',
  '--- marker',
  '...',
  "it's",
  'say "hi"',
  `both ' and "`,
  '[list]',
  '{map}',
  'a, b',
  ' leading',
  'trailing ',
  '^[A-Z]{2,3}$',
  '/products/{id}',
  'line one\nline two',
  'line one\nline two\n',
  'ends with blank lines\n\n',
  '  indented first\nsecond',
  '\nstarts with a break',
  '\n\n',
  'tab\there',
  'control\u0001char',
  'émoji ñandú 東京',
]

const VALUES: YamlValue[] = [
  { texts: TEXTS },
  Object.fromEntries(TEXTS.filter((text) => text !== '').map((text) => [text, text])),
  { numbers: [0, -1, 1.5, 1e21, 1e-7, -0], flags: [true, false, null] },
  { empty: {}, none: [], nested: [[1, [2, []]], [{}], [{ a: 1, b: [1, { c: 'd' }] }]] },
  [{ a: 'x\ny' }, ['p\nq'], 'r\ns\n'],
  { deep: { deeper: { deepest: ['one', { two: 'three\nfour' }] } } },
]

const FRAMEWORK_URLS = ['http://localhost:8000', 'http://localhost:3000', 'http://localhost:8080']
const EXAMPLES: ExampleId[] = ['store', 'library', 'catalog']

describe('toYaml', () => {
  it.each(VALUES.map((value, index) => [index, value] as const))('reads back as the same data (#%i)', (_index, value) => {
    expect(parse(toYaml(value))).toEqual(value)
  })

  it('writes what the yaml library writes for text that needs no block', () => {
    const single = TEXTS.filter((text) => !text.includes('\n') && !text.includes('\u0001') && !/^(---|\.\.\.)/.test(text))
    const value = { texts: single, keys: Object.fromEntries(single.filter((text) => text !== '').map((text) => [text, 1])) }
    expect(toYaml(value)).toBe(stringify(value, { lineWidth: 0, aliasDuplicateObjects: false }))
  })

  it.each(EXAMPLES.flatMap((id) => FRAMEWORK_URLS.map((url) => [id, url] as const)))(
    'writes the contract of %s as the yaml library does (%s)',
    (id, url) => {
      for (const auth of ['none', 'apiKey', 'jwt'] as const) {
        const document = buildOpenApi(example(id, { auth }).spec, url) as YamlValue
        expect(toYaml(document)).toBe(stringify(document, { lineWidth: 0, aliasDuplicateObjects: false }))
      }
    },
  )
})
