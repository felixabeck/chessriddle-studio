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
| Assistant panel, targets, help topics | `src/components/assistant/`, `src/components/assistant/topics/` |
| Assistant state and turns | `src/state/coachAvailability.ts`, `src/state/assistant.ts`, `src/state/assistantTurns.ts` |
| Native scoresheet photo intake and reading | `src-tauri/src/coach/scoresheet_photo.rs`, `src-tauri/src/coach/scoresheet.rs` |
| Scoresheet import pane, review panel, tree builder, photo store | `src/components/tabs/ImportPhotoPane.tsx`, `src/components/panels/scoresheet/`, `src/utils/scoresheet.ts`, `src/state/scoresheetPhotos.ts` |

## The switch

`RELEASE_AVAILABLE` in `src-tauri/src/coach/mod.rs` is `true` since Felix's release on 2026-11-24, so every build has the Coach. It stays as the kill switch: with it `false`, a release build has no Coach (no panel, no settings category, no hotkey, and every Coach command refuses with `unavailable`), while a build whose identifier ends in `.dev` (`pnpm dev`, or a build made with `--config src-tauri/tauri.dev.conf.json`) still has it.

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

## Assistant

The Assistant is a read-only AI helper that explains how ChessRiddle Studio works, links directly to settings and pages in the app, and can prepare a feedback draft when something is missing or broken. It changes no setting, file, database, or game, and never sends feedback itself.

**Entry points and visibility.** The Assistant is reachable from the Help menu (`Assistant`, in both the macOS native menu and the in-app menu) and from a button beside Feedback in the navigation row. Both entries appear only when the Coach switch is enabled and at least one AI connection exists in the credential registry (`coach_has_connection`, checked without reading the system keyring; failures fail closed, log, and re-check after connections change). It opens as a docked right panel (or an overlay with a close control below `56em` window width), sharing the Coach's stored connection, model, and effort selection. The conversation lives in memory for that window only.

**What a turn sends.** Built natively from the bounded renderer input and sent only to the provider of the chosen connection:

- the Assistant's instructions, the user's question, and the earlier completed exchanges of this window's conversation,
- the app version and operating system (native facts) and the interface language,
- where the user is: the current page and, on a board tab, its tab kind,
- setup facts already held by the renderer without starting a read: the names of installed engines (fenced as data; sent as "not known" if the engine list has not been read yet) and whether a reference database is chosen,
- the topic index (id, title, one-line summary of every shipped help topic),
- the settings list (target id, category, title, description of every setting shown in this build, in the interface language),
- the link targets (id and label),
- the full text of the help topics the model requests via its `read_topics` tool.

Not sent: games, positions, files, file names and paths, database names, account names, keys, or setting values. A separate first-use notice (stored per connection under `assistant-notice-accepted`, independent of the Coach's acceptance) names this list before the first question is sent.

**Bounds and turn lifecycle.** An Assistant turn runs under a window-owned native read reservation (`prepare_native_read` / `cancel_native_read`), so Stop, closing the window, reloading, or quitting cancels it. It shares the Coach's bounded model loop and turn driver: 6 model rounds, 4 tool calls per round, and a 5-minute deadline, with its own slot pool (`MAX_ASSISTANT_TURNS = 4` overall, at most one per window). Native input bounds (`src-tauri/src/coach/mod.rs` `MAX_ASSISTANT_*`): 4,000-character question, 40 history messages / 96 KiB (shared with Coach), up to 64 topics (32 KiB per body, 512 KiB total, at most 4 topics per `read_topics` call), 256 settings (128 KiB total), 512 link targets, 64 engine names, plus per-field character limits (`128` id/turn-id/page/engine-name, `200` title, `400` summary/description, `64` tab kind, `32` language).

**Links, feedback hand-off, and help topics.** The model writes links as `[[target-id]]`, split by the shared bracket scanner. Only target ids offered in that turn become clickable links, rendered with the app's translated label (never model text); unknown ids and unclosed brackets stay plain text, with no repair round. Clicking a setting or category link navigates to Settings via a one-shot non-persisted request that clears any active search, switches to the category, scrolls to the row, and highlights it. The `draft_feedback` tool validates a feedback type and message against `src-tauri/src/feedback.rs`'s limits (10–5,000 characters) and attaches the draft to the answer; clicking the answer's feedback link opens the feedback form prefilled for the user to review and send. Shipped English help topics live in `src/components/assistant/topics/`, load lazily on first use, and resolve `{{label:...}}` references into the active interface language.

## Reading a scoresheet photo

The scoresheet photo import turns 1 to 4 photographs of a handwritten chess scoresheet into a legal unsaved game on an analysis board, with the photos shown beside the notation for review.

**Entry points and intake.** Shown as the "From photo" card in `ImportModal` whenever the Coach switch is enabled. Without a connection (`coach_has_connection` in the credential registry, without reading the keyring), the pane links to Settings → AI (`coach`); otherwise it shares the Coach and Assistant's stored connection, model, and effort selection. Three native intake producers feed one bounded processor in `src-tauri/src/coach/scoresheet_photo.rs`:

- **File picker (`scoresheet_pick_photos`)**: opens the native multi-file image picker on `spawn_blocking` (never inside `BLOCKING_GATEWAY`), listing `jpg`, `jpeg`, `png`, and `webp` in lower and upper case. Dismissing the picker returns `cancelled`.
- **Clipboard (`scoresheet_paste_photo`)**: reads an image from the system clipboard via `arboard` on `BLOCKING_GATEWAY` (always off the UI thread so Linux cannot deadlock on its own clipboard content). No image or a backend error returns `clipboardEmpty`; an unprocessable image returns `photoUnreadable`.
- **Window drop (`ScoresheetPhotosDropped` + `scoresheet_take_dropped_photos`)**: when image paths are dropped on a window, the native drop handler obtains up to 4 single-use `ImageRead` path-authority grants, keeps them in a per-window slot (never file bytes), and emits `ScoresheetPhotosDropped { drop }` to that window. `scoresheet_take_dropped_photos(drop)` consumes the slot once for the calling window (`notFound` otherwise); the slot is also cleared on a replacement drop, webview reload, or window close.

Picked and dropped files are read through the path authority with single-use `ImageRead` grants; symlinks and non-regular files are refused. Every input image is recognised by magic bytes (JPEG, PNG, WebP — never by extension), decoded under explicit limits, oriented by EXIF, scaled down only to fit the long edge bound, flattened over white if transparent, and re-encoded from pixels as metadata-free JPEG (removing camera location and other EXIF/metadata).

**What a reading sends, and where.** Built natively from the validated request (`scoresheet_read`) and sent only to the provider of the chosen connection (Responses API `input_image` / `input_text`, Chat Completions `image_url` / `text`, with no `detail` field):

- the 1 to 4 processed JPEG photos as `data:image/jpeg;base64,...` URLs (including player names and anything else written on the sheet),
- the transcription instructions (transcribe exactly what is written, convert piece letters to English SAN, return one JSON object with `status`, `headers`, and `moves`),
- in correction rounds (when replaying moves from the standard starting position encounters an illegal move), the failed move number and colour, the failed token, the current position's FEN, and its legal SAN moves (no tools are sent).

Not sent: other files, file names or paths, games, engines, databases, or other connections. A separate first-use notice (`scoresheet-notice-accepted`, stored per connection) names this list before the first read is sent. Processed photos are held in renderer memory only (for at most 4 open tabs, cleared on tab close, replacement game, or finish) and are never written to web storage or disk.

**Bounds and turn lifecycle.**

- **Image processing (`src-tauri/src/coach/scoresheet_photo.rs`):** up to `4` photos (`MAX_SCORESHEET_PHOTOS`; extra files are counted in `skipped`), input file at most `32 MiB` (`MAX_INPUT_FILE_BYTES`), decoder limits of `12,000 px` per side (`MAX_DECODE_DIMENSION`) and `256 MiB` allocation (`MAX_DECODE_ALLOC_BYTES`), long edge scaled down to at most `2,048 px` (`MAX_LONG_EDGE`), JPEG encoded at quality `85` and retried once at quality `70` if above `1.5 MiB` (`MAX_OUTPUT_JPEG_BYTES = 1_536 * 1024`; still over `1.5 MiB` fails with `photoUnreadable`). `scoresheet_read` re-validates every incoming JPEG data URL natively against the `1.5 MiB` bound and JPEG magic bytes.
- **Reading turn (`src-tauri/src/coach/scoresheet.rs`):** runs under a window-owned native read reservation (`prepare_native_read` / `cancel_native_read`), so Cancel, closing the tab/window, reloading, or quitting cancels it (`cancelled`). Admission allows at most `1` read per window and `2` overall (`MAX_SCORESHEET_READS`, else `busy`). A read runs at most `4` model rounds (`MAX_READ_ROUNDS`, initial reply + malformed retries or illegal-move correction rounds) within `TURN_DEADLINE` (`300` seconds, else `limitExceeded`), with at most `300` rows (`1..=300` ascending), `12`-character move tokens (`MAX_MOVE_TOKEN_CHARS`), `120`-character headers (`MAX_HEADER_CHARS`), and `600` remaining tokens in `stopped` (`MAX_STOPPED_TOKENS`). A provider, transport, or deadline failure in any round fails the whole read.

**Commands, event, and error codes.**

- Commands (all listed in `CLOSED_ERROR_COMMANDS`): `scoresheet_pick_photos`, `scoresheet_paste_photo`, `scoresheet_take_dropped_photos`, `scoresheet_read`.
- Registered event (`collect_events!`): `ScoresheetPhotosDropped`.
- Error codes added to `src-tauri/src/coach/error.rs`: `photoUnreadable`, `clipboardEmpty`, `imagesUnsupported` (including HTTP `400`/`404`/`422` refusals naming images/vision/modalities on requests with images and a `no_image` model reply), and `scoresheetUnreadable` (`not_a_scoresheet` or no legal move read).

## Checking the real providers

The unit tests run every sign-in and both wire formats against loopback doubles. A real sign-in needs the account owner in the browser once:

1. Start a `.dev` build (`pnpm dev`).
2. Settings → AI → "Continue with ChatGPT" (or "Sign in with Grok"), approve in the browser.
3. "Check" on the connection lists its models.
4. Open a game, open the Coach panel, pick the connection and a model, ask a question. The answer should name engine lines, and "The engine is checking …" should appear while it works.
5. Remove the connection. No notice means the provider confirmed the sign-out.

For Grok, step 4 is also the check that xAI's stream uses the event names the Responses backend reads (`response.output_text.delta`, `response.output_item.done`, `response.completed`). xAI does not document them.

A local Ollama or LM Studio proves the local address class the same way without an account.

For Google Gemini, create a key at `aistudio.google.com/apikey`, add the connection with the preset, and run steps 3 and 4. An answer that names engine lines proves the second round of a turn, which Gemini refuses when the provider data of a tool call did not come back.
