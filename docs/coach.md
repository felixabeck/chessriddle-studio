# Coach

The Coach is a chat about the position on the analysis board. The user asks a question, a language model answers, and the model can ask the user's own engine and reference database before it does. Decisions: `d-20261122-18` to `d-20261122-21` in `tasks/decisions.md`.

| Part | Where |
| --- | --- |
| Native: connections, secrets, sign-in, provider traffic, the turn | `src-tauri/src/coach/` |
| Shared rotating-token session (also used by the ChessRiddle connection) | `src-tauri/src/infra/token_session.rs` |
| Panel, transcript, composer | `src/components/panels/coach/` |
| Connections in Settings | `src/components/settings/coach/` |
| Renderer state: selection, conversation per tab, running turns | `src/state/coach.ts`, `src/state/coachSession.ts`, `src/state/coachTurns.ts` |
| Repertoire lines for the position | `src/state/repertoireIndex.ts` |

## The switch

`RELEASE_AVAILABLE` in `src-tauri/src/coach/mod.rs` is `false`. A release build has no Coach: no panel, no settings category, no hotkey, and every Coach command refuses with `unavailable`. A build whose identifier ends in `.dev` (`pnpm dev`, or a build made with `--config src-tauri/tauri.dev.conf.json`) always has it. Turning the switch on is a release decision and needs Felix's explicit "release".

## Connections

A connection is one way to reach a model. Its secret lives in the system keyring as one document. The renderer gets a summary (label, kind, address, account email, status) and never a key or a token.

| Kind | How it is made | Wire format | Hosts |
| --- | --- | --- | --- |
| ChatGPT sign-in | "Continue with ChatGPT": OpenAI's documented sign-in for locally run apps, in the system browser | Responses API | `auth.openai.com`, `api.openai.com` |
| Grok sign-in | "Sign in with Grok": the device-code flow of xAI's command-line client. Unofficial, labelled so, and it may stop working | Responses API | `auth.x.ai`, `api.x.ai` |
| API key or local model | An address and an optional key. Presets for OpenAI, Google Gemini, DeepSeek, Qwen, OpenRouter, Ollama, LM Studio | Chat Completions | The address the user entered |

There is at most one ChatGPT and one Grok connection. A new sign-in takes the place of the existing one. To switch to another ChatGPT account, remove the connection first and sign in again: the provider issues a client id per installation and account, and a sign-in that returns a different one is refused.

Google has no sign-in for other apps: a Google AI Pro or Ultra subscription cannot be used here, and signing in as Google's own command-line tools is against Google's terms and has cost users their access (`d-20261122-32`). Gemini is reached with an API key from Google AI Studio through Google's OpenAI-compatible address, which the "Google Gemini" preset fills in. Three things differ from other services and are handled in the Chat Completions backend for every provider alike:

- A tool call can come with provider data (`extra_content`; Gemini puts the signature of its reasoning there) that has to go back unchanged with that call in the next round of the turn. It is kept with the call for the turn and never read.
- A tool call can come without an index and with an empty id; it then gets an id of its own so that its result can name it.
- A wrong or missing key is answered with HTTP 400 and words, not with 401.

An API address is `https` to a public host, or `http` to this machine or a private-range address. A key is only ever attached to a request at the stored scheme, host and port, below the stored path.

Removing a sign-in deletes it on this computer first and then asks the provider once to withdraw it. If the provider does not confirm within ten seconds, Settings says so.

## What is sent, and where

A turn sends the following to the provider of the chosen connection, and to nobody else:

- the Coach's instructions and the user's question (at most 4,000 characters),
- the earlier messages of this tab's conversation (the newest 40, at most 96 KiB),
- the position: the start position and the moves that lead to it,
- the game in the tab as PGN, with its comments and variations (at most 24 KiB),
- what the user's engine found: a baseline search of the position, and every line the model asked the engine about,
- move statistics from the reference database, if one is selected,
- the lines the user's repertoire files play from the position (at most 8 KiB).

Not sent: other tabs, files, database contents beyond the move statistics of the positions asked about, engine binaries, account data of other connections. There is no telemetry. Requests to the sign-in providers ask them not to store the conversation (`store: false`).

The ChatGPT sign-in sends OpenAI a random id for this installation (stored beside the Coach's credential registry) and the app's name. The first-use notice in the panel tells the user which data goes to the chosen provider before the first question is sent.

Every request of the Coach carries the app's shared user agent: the app's name and version and the publisher's contact address (`STUDIO_USER_AGENT` in `src-tauri/src/infra/net.rs`). It says nothing about the user.

Provider error texts stay in the native log, shortened and without the connection's key. The renderer gets one of the codes in `src-tauri/src/coach/error.rs`.

## A turn

A turn is an analysis operation: the renderer reserves it with `prepare_analysis`, `coach_turn` claims it, and cancel, closing the tab, a reload and quitting end it like any other analysis. It runs a private engine process of the user's chosen engine, which is gone when the turn ends.

Bounds: 6 model rounds, 4 tool calls per round, 5 minutes in total, a 2-second baseline search and 1.5 seconds per engine call. Moves the model writes as `[[...]]` lines are checked for legality from the turn's position. An illegal line costs one repair round and is shown as plain text if it stays illegal.

The model never changes the game. A line in an answer previews on the board when clicked, and a button inserts it as a variation.

## Checking the real providers

The unit tests run every sign-in and both wire formats against loopback doubles. A real sign-in needs the account owner in the browser once:

1. Start a `.dev` build (`pnpm dev`).
2. Settings → Coach → "Continue with ChatGPT" (or "Sign in with Grok"), approve in the browser.
3. "Check" on the connection lists its models.
4. Open a game, open the Coach panel, pick the connection and a model, ask a question. The answer should name engine lines, and "The engine is checking …" should appear while it works.
5. Remove the connection. No notice means the provider confirmed the sign-out.

For Grok, step 4 is also the check that xAI's stream uses the event names the Responses backend reads (`response.output_text.delta`, `response.output_item.done`, `response.completed`). xAI does not document them.

A local Ollama or LM Studio proves the local address class the same way without an account.

For Google Gemini, create a key at `aistudio.google.com/apikey`, add the connection with the preset, and run steps 3 and 4. An answer that names engine lines proves the second round of a turn, which Gemini refuses when the provider data of a tool call did not come back.
