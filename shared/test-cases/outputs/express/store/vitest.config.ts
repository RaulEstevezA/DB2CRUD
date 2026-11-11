/** Test configuration: the environment of the tests is set before any of them runs. */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { setupFiles: ['tests/setup.ts'] },
})
