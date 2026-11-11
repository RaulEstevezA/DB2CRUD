/**
 * Entry point: starts the API on PORT (3000 by default).
 */

import { createApp } from './app.js'
import { getSettings } from './config.js'

const { port } = getSettings()
createApp().listen(port, () => {
  console.log(`API listening on http://localhost:${port}`)
})
