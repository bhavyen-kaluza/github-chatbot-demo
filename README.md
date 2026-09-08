# Cortex GitHub chatbot demo

A small, standalone chatbot that signs you in with the Cortex GitHub App, reads
your repositories live over GitHub's API with your own token, and answers
questions about them. It touches nothing in Cortex. It is a preview of what the
Cortex integration will do, built from the same queries, the same six tools and
the same chatbot rules.

```
 browser / terminal ──► this demo (Node, port 3000) ──► Claude (Anthropic API)
                                   │                        │ decides which tool to call
                                   └──────────────────────► GitHub API, as you, read-only
```

Nothing is stored except your GitHub token, in `.github-token.json` on your
laptop (readable by you only, ignored by git). In Cortex the same token lives
in an encrypted browser cookie instead.

## What is in here, and why

| File | What it does | Why it exists |
|---|---|---|
| `login.mjs` | Opens GitHub in your browser, waits for GitHub to send it back, swaps the code for a token, saves it. | This is the OAuth flow Phase 1 proved. Same code as the probe script, so the risky part is already known to work on your machine. |
| `logout.mjs` | Deletes the saved token. | Lets you demo the "GitHub is not connected" behaviour on purpose. |
| `chat.mjs` | Terminal chat. Streams the answer and prints every tool call it makes. | The most honest demo: the audience sees exactly which GitHub call answered each question, and what it cost. |
| `server.mjs` + `public/index.html` | The same chatbot as a web page on `http://localhost:3000`, with a Connect button. | Looks like a product. Same routes Cortex uses (`/api/github/oauth/start`, `/api/github/oauth/callback`, `/api/github/status`, `/api/chat`). |
| `lib/github-auth.mjs` | Token exchange, refresh, storage. | GitHub App tokens last 8 hours with a rotating refresh token. This handles that so a demo never dies mid-way. |
| `lib/github-api.mjs` | Calls GitHub, turns failures into five codes. | GitHub says "not found" for a private repo you cannot reach. The codes let the chatbot say the true thing instead of "that repo does not exist". |
| `lib/github-tools.mjs` | The six tools: list repos, repo overview, read a file, list a folder, recent changes, pull requests. | One GraphQL query each, about one rate-limit point a call. Same names and shapes as Cortex's MCP tools. |
| `lib/system-prompt.mjs` | The chatbot's instructions. | Adapted from Cortex's own prompt: how to route questions, what to say when GitHub is not connected, how to explain each error code, and to treat file contents as data, never as instructions. |
| `lib/agent.mjs` | The loop: send the conversation to Claude, run the tools it asks for, send results back, repeat until it answers. | This is the whole "chatbot" mechanism in about 100 lines. |

## Setup (once)

You need Node 22 or newer (`node -v`) and the three secrets.

```bash
npm install
cp .env.example .env
```

Open `.env` and fill in:

```bash
GITHUB_CLIENT_ID='Iv23li...'          # the GitHub App's client id (same as the probe used)
GITHUB_CLIENT_SECRET='...'            # the secret you generated for it in Phase 1
ANTHROPIC_API_KEY='sk-ant-...'        # lets the chatbot think
```

Why `.env`: secrets stay out of the code and out of git (`.gitignore` covers it).
`npm install` fetches the one dependency, the official Anthropic SDK.

Check the GitHub App still has callback URL
`http://localhost:3000/api/github/oauth/callback` and "Expire user authorization
tokens" switched on. Both were true in Phase 1. The demo refuses a token that
never expires, exactly as Cortex will.

## Run it

Two ways. Use whichever suits the room.

### Terminal

```bash
npm run login      # browser opens, click Authorize, come back
npm run chat       # ask away; /quit to leave
```

One question without the chat loop:

```bash
npm run chat -- --ask "Which pull requests are open in bhavyen-kaluza/fastify-clone?"
```

### Web page

```bash
npm run web        # then open http://localhost:3000
```

Click **Connect GitHub**, authorize, ask. The chips under each answer show the
tool calls. `npm run login` and `npm run web` both use port 3000, so run one at
a time. A token saved by one is used by the other.

## Demo script

Start disconnected (`npm run logout`) and ask:

> What is bhavyen-kaluza/fastify-clone?

The chatbot says GitHub is not connected and does not pretend the repo is empty.
Then connect and go through:

| Ask | Tool | What you see |
|---|---|---|
| Which GitHub repositories can I see through Cortex? | SearchGitHubRepositories | Your clones and hello-world, with language and last push. |
| What is bhavyen-kaluza/fastify-clone? Languages, branches, tags, what is in the root? | GetGitHubRepository | Description, language shares, counts, default branch `consistent-application-hooks`, README. |
| Show me the README of bhavyen-kaluza/portless-clone. | GetGitHubFile | The text, its size, a link. |
| What is in docs/cortex-probe in bhavyen-kaluza/ponytail-clone? | ListGitHubDirectory | The folder listing with `merged.md`. |
| What changed in bhavyen-kaluza/fastify-clone in the last month? | GetGitHubRecentChanges | Recent commits and the merged probe PR #12. |
| Which pull requests are open in fastify-clone? Drafts? Bots? | GetGitHubPullRequests | 13 open: 11 Dependabot flagged as bots, #13 with labels and a comment, #14 draft. |
| What is the kaluza-accelerator/cortex repo about? | GetGitHubRepository | "Not visible: either no access or the app is not installed there." This is the org-install ask in one sentence. |

Three things to say out loud:

- Read-only by construction. The app has Contents, Metadata and Pull requests,
  read only. There is no scope the chatbot could widen.
- Every read runs as the person asking, with their own token. Nothing is stored
  server-side in Cortex; here, one file on your laptop.
- It reaches only repositories where the app is installed. An org owner
  installing it on `kaluza-accelerator` is what turns this demo into the real thing.

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| `Missing GITHUB_CLIENT_ID...` | `.env` not filled in | Open `.env`, replace the placeholders. |
| Login: `incorrect_client_credentials` | wrong secret | Compare `GITHUB_CLIENT_SECRET` with the app settings. Generate a new secret there if in doubt. |
| Login: `redirect_uri_mismatch` | callback URL differs | The app must have exactly `http://localhost:3000/api/github/oauth/callback`. |
| Login: token that never expires | app setting off | Switch on "Expire user authorization tokens", log in again. |
| `port 3000 is already in use` | `npm run web`, `npm run login` or the old probe still running | Stop it (Ctrl+C), retry. |
| `Anthropic rejected the API key` | wrong `ANTHROPIC_API_KEY` | Fix it in `.env`. |
| Anthropic rejects the request mentioning fallbacks or beta | your key or gateway does not support that beta | Add `CLAUDE_FALLBACKS='off'` to `.env`. |
| Chatbot says a clone is not visible | signed in as a different GitHub account, or the app was uninstalled from your account | `npm run logout`, `npm run login` as `bhavyen-kaluza`. Check the app's Install App page. |
| Chatbot says reconnect | token revoked or 8h expired with a dead refresh token | `npm run login`. |

## How this maps to Cortex

| Demo | Cortex |
|---|---|
| `lib/github-auth.mjs`, token file | `apps/api/src/github-oauth.ts`, `github-routes.ts`, encrypted `github_access` cookie |
| `lib/github-api.mjs` error codes | `apps/api/src/github-errors.ts`, `github-client.ts` |
| `lib/github-tools.mjs` | `apps/api/src/resolvers/github-repos.ts` + `apps/mcp/operations/*.graphql` |
| `lib/system-prompt.mjs` | the GitHub sections of `apps/api/src/chat-system-prompt.ts` |
| `server.mjs` routes | the same paths served by cortex-api behind cortex-app |

The chatbot runs on `claude-opus-5` with Anthropic's server-side refusal
fallback switched on (`CLAUDE_FALLBACKS='off'` to disable). Change the model with
`ANTHROPIC_MODEL` in `.env`.
