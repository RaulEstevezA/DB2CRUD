/**
 * Configuration read from the environment. Nothing secret has a default: see .env.example.
 */

export interface Settings {
  port: number
}

/** Reads the settings on every call, so a changed environment (tests, reloads) is always seen. */
export function getSettings(): Settings {
  return {
    port: Number(process.env.PORT ?? 3000),
  }
}
