// Loads .env from the project folder into process.env (without overriding
// variables that are already set), and checks the ones a command needs.
//
// Why a file and not the shell: `source .env` only works for the current
// terminal and only if you remember to run it. Reading the file directly means
// `npm run chat` works the same from any terminal, and the secrets never need
// to be typed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ENV_FILE = path.join(PROJECT_DIR, '.env')

function parseDotEnv(text) {
  const out = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    const q = value[0]
    if ((q === "'" || q === '"') && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1)
    else {
      // Unquoted values may carry a trailing comment.
      const hash = value.indexOf(' #')
      if (hash >= 0) value = value.slice(0, hash).trim()
    }
    out[key] = value
  }
  return out
}

export function loadEnv() {
  let text
  try { text = fs.readFileSync(ENV_FILE, 'utf8') } catch { return false }
  for (const [key, value] of Object.entries(parseDotEnv(text))) {
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value
  }
  return true
}

/** Exit with a plain explanation when a required variable is missing or still a placeholder. */
export function requireEnv(keys) {
  const missing = keys.filter(k => !process.env[k] || /^(\.\.\.|Iv23li\.\.\.|sk-ant-\.\.\.)$/.test(process.env[k]))
  if (missing.length === 0) return
  const hasFile = fs.existsSync(ENV_FILE)
  console.error(`\nMissing ${missing.join(', ')} in ${hasFile ? ENV_FILE : '.env'}.`)
  if (!hasFile) console.error('Create it with:  cp .env.example .env   then fill in the values.')
  else console.error('Open .env and replace the placeholder values.')
  process.exit(1)
}
