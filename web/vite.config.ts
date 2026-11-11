/**
 * Build, development server and test configuration of the web version.
 *
 * The production build is published at raulesteveza.github.io/tools/DB2CRUD/, so it uses that base path;
 * the development server serves from the root.
 */
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig(({ command, isPreview }) => ({
  plugins: [react()],
  base: command === 'build' || isPreview ? '/tools/DB2CRUD/' : '/',
  build: {
    rolldownOptions: {
      output: {
        // Libraries in their own files: they change less often than DB2CRUD, so browsers keep them cached
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            {
              name: 'codemirror',
              test: /node_modules[\\/](@codemirror[\\/](state|view|commands|language)|@lezer[\\/](common|highlight|lr)|style-mod|w3c-keyname|crelt)[\\/]/,
            },
            { name: 'yaml', test: /node_modules[\\/]yaml[\\/]/ },
            // DB2CRUD's own core, by stage: they change together, but each stays a reasonable size
            { name: 'importers', test: /src[\\/]core[\\/](importers|model|analysis)[\\/]/ },
            { name: 'generators', test: /src[\\/]core[\\/]generators[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    // Core tests run in Node; interface tests opt into jsdom with a comment at the top of the file
    environment: 'node',
    // Node 25 has its own experimental localStorage, which hides the browser one of jsdom
    execArgv: ['--no-experimental-webstorage'],
  },
}))
