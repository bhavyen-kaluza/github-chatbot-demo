#!/usr/bin/env node
// Disconnect GitHub: deletes the saved token. The next chat starts "not connected".
import { loadToken, clearToken } from './lib/github-auth.mjs'

const had = loadToken()
clearToken()
console.log(had ? `Disconnected @${had.login ?? 'unknown'}. The chatbot will now say GitHub is not connected.` : 'GitHub was not connected.')
