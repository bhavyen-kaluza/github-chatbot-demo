#!/usr/bin/env node
// Connect GitHub: opens the browser, waits for GitHub to send it back, saves the token.
import { loadEnv, requireEnv } from './lib/env.mjs'
import { loginInteractive, describeStatus, GitHubTokenError } from './lib/github-auth.mjs'

loadEnv()
requireEnv(['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'])

try {
  const token = await loginInteractive()
  const status = describeStatus(token)
  console.log(`\nConnected to GitHub as @${token.login}. Token expires in ${(status.expiresInMs / 3600000).toFixed(1)}h and refreshes itself.`)
  console.log('Next:  npm run chat     or     npm run web')
} catch (err) {
  const hint = err instanceof GitHubTokenError && err.code === 'incorrect_client_credentials'
    ? '\nCheck GITHUB_CLIENT_SECRET in .env against the app settings on GitHub.'
    : err instanceof GitHubTokenError && err.code === 'redirect_uri_mismatch'
      ? '\nThe callback URL registered on the app must be exactly http://localhost:3000/api/github/oauth/callback.'
      : ''
  console.error(`\nLogin failed: ${err.message}${hint}`)
  process.exit(1)
}
