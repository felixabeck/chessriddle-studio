# Plan: Connect ChessRiddle Studio to ChessRiddle accounts

Status: **Phases A and B built (2026-11-09). Phases C to E not built.** Product choices marked "Felix" are his; technical choices are recommendations. Each phase gets its own detailed `build` plan and review in the repository it changes.

## Roadmap and current state (recorded 2026-11-09, updated 2026-11-10)

This section overrides the phase order further down. It is the agent's recommendation, which Felix asked to have recorded on 2026-11-09. He has not yet decided the signing question below.

### Where phase A stands

* **Studio:** on `master` since `bc4695aa`. The account card stays hidden in release builds until the constant `RELEASE_AVAILABLE` in `src-tauri/src/chessriddle.rs` is switched at release. The `.dev` identifier can use it now, with compile-time `CHESSRIDDLE_API_ORIGIN` and `CHESSRIDDLE_WEB_ORIGIN` overrides limited to literal `127.0.0.1`.
* **ChessRiddle:** local branch `build/studio-account-20261109` in `/home/felixb/Projekte/chess-tactics-app.worktrees/studio-account`, base `develop` at `ed84c20ce5`, reviewed and fully gated at `5118e54dc0`. Until 2026-11-09 it was not pushed and not deployed. Since then the ChessRiddle build run studio-release has been rebasing, re-reviewing and releasing it, and its commit ids changed with the rebase. Its record, `tasks/handoffs/2026-11-09-studio-release-review.md` in the ChessRiddle repository, holds the current state. Observed on 2026-11-10: the rebased branch was 22 commits ahead of `origin/develop`, not yet pushed.
* **Branch hold, lifted.** Felix lifted it on 2026-11-09: "I lift the branch hold from 2026-11-09: this work may now go to develop and to production." (ChessRiddle `d-20261109-06`). The hold as he first gave it, Felix 2026-11-09: "I only want to push it when I'm ready to deploy and when the studio is complete to release ... I don't want to deploy the connection if Chessriddle Studio is not ready yet. So leave this in a branch but don't push it to develop." While the hold stood, ChessRiddle work for later phases stacked on this branch. With the hold lifted, later phases follow the ChessRiddle repository's normal flow once its release run has finished.
* **Review record:** `tasks/handoffs/2026-11-09-chessriddle-account-connection-review.md`; detailed plan: `tasks/plans/2026-11-09-chessriddle-account-connection.md`.

### Order

1. **Tactics in Studio (phase B), built 2026-11-09.** Standard tactics plus retry-your-mistakes. Studio is on `master`, hidden in release builds by `RELEASE_AVAILABLE`. The ChessRiddle side stacks on `build/studio-account-20261109` as commits `21d30a65d2`, `7ce3d60015` and `8605a3d044` (ids before the release rebase). Their release is the ChessRiddle run studio-release named above. Review record: `tasks/handoffs/2026-11-09-chessriddle-tactics-phase-b-review.md`. Since 2026-11-10 the training has no New Tab action of its own: it opens from the one Puzzles entry as the default source of a puzzle tab, beside the offline databases (`d-20261110-01`, review record `tasks/handoffs/2026-11-09-puzzles-one-entry-review.md`).
   **Tactics made complete, built 2026-11-10 (Studio side).** Felix decided on 2026-11-10 that Studio offers tactics only and no further puzzle modes (`docs/context/PRODUCT-DECISIONS.md`, `d-20261110-08`). Studio now reads and saves difficulty, motif and the timer on the ChessRiddle account, with keyboard shortcuts, a session summary, Analyse and a website link. Review record: `tasks/handoffs/2026-11-10-tactics-mode-review.md`. **Open on the ChessRiddle side:** the desktop allowlist (`backend/app/core/auth.py`) must admit `GET` and `PATCH /api/v1/users/me/settings` for the Studio login; a handover prompt for that change was given to Felix on 2026-11-10. Until it is deployed, Studio shows no settings control and runs tactics at default difficulty with all motifs. The real flow (settings, motif, timer against a ChessRiddle backend) is unverified until then.
2. **Release preparation, in parallel:** Windows check, code signing, download page on chessriddle.com.
3. **First public release:** rebase the ChessRiddle branch onto `develop`, re-review, run full gates, push and deploy on Felix's go, switch `RELEASE_AVAILABLE`, publish Studio. The ChessRiddle part of this step started on 2026-11-09 when Felix lifted the hold (see above); switching `RELEASE_AVAILABLE` and publishing Studio still wait for his go.
4. **Send to a trainer collection (phase C), as an update.** Small, but only Gold trainers use it.
5. **Repertoire (phases D1, D2, D3):** website first, then Studio sync, then the phone app through Philipp. It is the most valuable feature and the largest. Felix's design work can start during steps 1 to 3.
6. **Own-game puzzles (phase E):** left out unless Felix asks.

Reasons: repertoire must not hold the first release, because it is the largest item and needs Felix's design. The connection alone gives users nothing to do, so it ships with its first feature. Holding everything would keep the ChessRiddle branch drifting from `develop`, which already caused legal-text conflicts. Studio's release configuration builds signed update packages, so later features can arrive as updates.

### Open before a public release

* **Felix decides:** buy code-signing certificates, or launch unsigned with a warning on the download page. `src-tauri/tauri.conf.json` has `certificateThumbprint: null` on Windows and an ad-hoc `signingIdentity: "-"` on macOS.
* **Untested:** the connection on real Windows, meaning Credential Manager and the browser round trip. It needs a Windows machine.
* **`pg_cron` scheduling for desktop-credential cleanup:** verified on a local database by the ChessRiddle run studio-release (its review record, "Proof before the gates"). Verification in production follows its deploy.
* **Not built:** the chessriddle.com download page.

### What tactics needs on the ChessRiddle side

* Add each puzzle route to `DESKTOP_ROUTE_ALLOWLIST` in `backend/app/core/auth.py` (exact method and served path template). Before phase B it held only `GET /api/v1/users/me` and `POST /api/v1/desktop-auth/revoke`; phase B added the four training routes.
* Attribution already accepts surface `desktop` and platforms `linux`, `macos`, `windows`. `_is_native_app_client` deliberately excludes desktop, so `puzzle_client_compatibility.py` needs an explicit decision about which puzzle types desktop receives.
* Carried obligations CR-5, CR-6 and CR-7 below still bind phase B.
* Until the hold was lifted, ChessRiddle commits stacked on `build/studio-account-20261109`, because they need its credentials and allowlist, and were never pushed to `develop`.

### Proving the real flow locally

The phase A real end-to-end proof used the `.dev` release binary, real IPC, Chromium, PostgreSQL 17, real Alembic migrations and `supabase/gotrue:v2.197.0`. Its harness scripts and report are kept in `~/.local/share/chessriddle-real-flow-20261109/`, outside the repository. They name their original run paths under `/tmp`.

Next.js rewrites a literal `127.0.0.1` site to `localhost`, which causes a self-redirect loop in local runs only. The harness serves the web app on `localhost` and opens the consent URL there through an `xdg-open` shim, keeping the `redirect_uri` byte-identical on `127.0.0.1`. Do not treat that loop as a product defect.

## Goal

ChessRiddle Studio (this desktop app, GPL-3, public source) and ChessRiddle (closed-source web trainer with paid Gold) work together without exposing any ChessRiddle code or secret. In order of build:

1. Connect a ChessRiddle account from the desktop app.
2. ChessRiddle tactics training inside the desktop app.
3. Send positions or games from the desktop database to a ChessRiddle trainer collection.
4. Repertoire: a repertoire feature on the ChessRiddle website first; then sync from the desktop; the phone app last, through a GitHub issue for Philipp after Felix has accepted the web version.
5. Optional, last: puzzles from the user's own games.

## MANDATE

Felix, in chat 2026-11-05/06: the most interesting use is "review my opening, my repertoires in ChessRiddle, in the app … I prepare something on my computer and then I am on the go in the tournament … I just click it through on the phone." "ChessRiddle training inside the desktop app. This sounds very good to me. I'm not sure how this is possible without exposing the code." Trainer preparation: "This would make it much easier for trainers to prepare. I would definitely include this." Own-game puzzles: "I think it's a bad training. But I would be open to include this as well." Repertoire order: "at first we would have to build the repertoire in ChessRiddle on the web and only then afterwards comes the app", with a GitHub issue for Philipp once Felix is "completely convinced". Pricing: sync free; Felix left the free/limit choice to the recommendation (recommended and not objected to: syncing and viewing free, repertoire training Gold).

## Threat model and non-goals

* The desktop app is public code; anyone can modify and redistribute it, so **nothing it sends is trusted**: no API secret or client secret ships in it, and no entitlement, rate limit, puzzle selection, answer check or rating decision depends on it. These stay on the ChessRiddle server and key on the authenticated user (and IP), as for the web app. Client attribution headers are a rendering and metrics hint only; a modified app can claim any surface.
* A token issued to the desktop app may be stolen from a user's machine. It must not carry more authority than the desktop features need (see A).
* ChessRiddle tokens are credentials: native memory and the OS keyring only, never the renderer, web storage, logs or error payloads (async-resource-invariants). The renderer receives display data only.
* All ChessRiddle and Supabase traffic is native (reqwest, as for Lichess), so the webview CSP and capability scopes are **not** widened; the renderer never talks to these hosts. The API and auth base URLs are compile-time constants (a development build may use a local backend under the `.dev` identifier only); release builds require HTTPS and keep redirect/Authorization stripping.
* Server text is never rendered as markup: error codes map to a closed set of Studio-owned translated strings; server display text is plain text; any link the native side opens is checked against a fixed chessriddle.com allowlist.
* GPL boundary: no ChessRiddle source (board components, puzzle logic, Flutter code) is copied into this repository, and no Studio/En Croissant source into ChessRiddle. The two meet only at the HTTP API.
* Non-goals: offline puzzle solving in the desktop app, two-way repertoire merge in the first version, any change to ChessRiddle pricing (Felix decides pricing).

## Traced premises

These premises describe the code on 2026-11-06, before phase A was built. Phases A and B have since changed several of them: ChessRiddle has a desktop connect page and opaque desktop credentials, Studio's credentials module has a ChessRiddle provider beside Lichess, and client attribution accepts surface `desktop` with the platforms `linux`, `macos` and `windows`.

* ChessRiddle auth is Supabase JWT; `backend/app/core/auth.py:85-170` accepts any project JWT with audience `authenticated` (issuer checked only when present). No OAuth authorize/consent route exists in the ChessRiddle frontend or backend today.
* Studio's Lichess flow is a loopback PKCE flow (`src-tauri/src/oauth.rs`, `AuthLifecycle` at :109, callback at :166) with native reqwest calls; Lichess tokens never expire, so there is no refresh path. `src-tauri/src/credentials.rs` is Lichess-typed: `OsCredentialStore::new` appends a fixed `.lichess` suffix to the identifier-derived service, the registry is `lichess-accounts.json`, and each handle holds one token string with its own journal/reconcile logic.
* Puzzles: `GET /puzzles/<mode>/next` returns a puzzle whose standard tactic payload `TacticPuzzleDTO` includes the full `principal_variation` (`backend/app/schemas/puzzle.py:521-533`); `POST /puzzles/{id}/submit` (`routes/puzzles/shared.py:196`, rate-limited, Idempotency-Key) takes a `variation_tree` (`PuzzleNode`) plus `time_taken_ms`, `is_rated`, `solution_shown`, `extra="forbid"` (`schemas/puzzle.py:367-408`).
* Client attribution (`backend/app/core/client_attribution.py:16-17`) allows surfaces `web`/`app` and platforms `web`/`ios`/`android`; `puzzle_client_compatibility.py` gates CUSTOM content to `web/web` with shared-session protocol ≥ 4 or native versions ≥ `MIN_NATIVE_CUSTOM_CONTENT_VERSION` (`None` today, :26 and :203-211); an unknown client falls into "unattributed".
* Trainer collections: `GET /training/collections`, `POST /training/collections/{id}/custom` (FEN + optional solution) and `POST /training/collections/{id}/custom/import` (PGN) (`routes/trainer_collections.py`, router prefix at :61, routes at :169, :205-240), both gated by `require_client_supported_puzzle_types(..., {CUSTOM})` and by `Permission.TRAINER_TOOLS` ("requires a Gold trainer tools subscription", `trainer_collection_service.py:604-610`).
* There is no repertoire model in the ChessRiddle backend. Offline puzzle packs exist only in the mobile app; the web app has no offline data cache today.

## Approach

### A. Account connection (both repositories)

* **ChessRiddle — who logs the user in:** there is no OAuth authorize/consent surface today. Phase A's own plan decides between Supabase's OAuth server for third-party clients and a ChessRiddle-hosted "connect desktop app" page that completes PKCE, and confirms that the resulting token passes `verify_supabase_token`. Email/password accounts must work, not only social logins. The redirect allowlist names exactly `http://127.0.0.1:*/callback`, PKCE only, no client secret.
* **ChessRiddle — token authority:** desktop-issued tokens carry an identifying claim (issuing client or app claim) and are refused on account, email, payment and destructive routes; only the routes B–D need accept them.
* **ChessRiddle — attribution:** add surface `desktop` and platforms `linux`/`macos`/`windows` to `client_attribution.py`, and decide for every consumer that switches on `surface == "app"` (including the training-sequence client class) how a desktop client is treated. Attribution never gates entitlement.
* **Studio — one OAuth/PKCE path, two providers:** extract the provider-neutral part of `oauth.rs` (loopback listener, state, PKCE verifier/challenge, code exchange, token-free error mapping) into one helper that both Lichess and ChessRiddle call, in the same change (rule 11; async-resource "the second approximately similar implementation gets extracted"); each `AuthLifecycle` attempt is bound to its provider so a code can only reach its own token endpoint. Lichess moves onto the helper in phase A.
* **Studio — credentials:** generalise `credentials.rs` so the keyring service is `identifier + provider suffix` (development and release stay separated) and one account is one keyring record written atomically with its registry journal. Store only the refresh token in the keyring (Windows Credential Manager limits a blob to 2560 bytes; confirm the crate's encoding) and keep the access token in native memory.
* **Studio — refresh, revocation, failure classes:** one native owner single-flights refresh (Supabase rotates refresh tokens and revokes the family on reuse, which would also sign the user out of web and phone). Only a definitive `invalid_grant` clears the stored credential; network errors and 5xx keep it and retry later. Sign-out calls the Supabase logout/revoke endpoint before deleting the keyring record, and a failed revoke is reported, not hidden. Startup reconciles the registry against the keyring like the Lichess path.
* **Studio — renderer surface:** Specta commands with typed errors; the renderer sees "connected as <display name>, plan Free/Gold" as non-authoritative display data, refetched from the server and never persisted as entitlement. Settings → Accounts gets a ChessRiddle card.

### B. Training inside the desktop app (Studio plus ChessRiddle)

* The Train panel shows one puzzle at a time on the existing board. The native module fetches the next puzzle and **strips `principal_variation` and every other solution field before returning it to the renderer**; the renderer receives position, side to move and display metadata only. The native module keeps the solution only to show it after the server's verdict. (Superseded by CR-5 below: as built, the native module keeps no solution copy and the verdict's `correct_variation` supplies the line.)
* The panel builds the `variation_tree` the submit contract requires (with `time_taken_ms`, `is_rated`, `solution_shown`) and shows the server's verdict, rating change and solution. Gold-only modes appear only when the server allows them; a refusal shows a Studio string plus an allowlisted chessriddle.com upgrade link.
* ChessRiddle side: the attribution and compatibility consumers from A, so a desktop client receives only types it renders (start with standard tactics, which are already ungated).
* Proof includes a contract check of the native request/response types against the ChessRiddle OpenAPI schema, because mocked-IPC e2e cannot catch wire drift.

### C. Send to a trainer collection (Studio plus a ChessRiddle gate change)

* ChessRiddle: allow CUSTOM content for the desktop client in `puzzle_client_compatibility.py` (a desktop rule and a decision on the shared-session protocol header the desktop sends), deployed before Studio ships C; until then every send is a 409 `client_update_required`.
* Studio: from a game, a position or a database selection, "Send to ChessRiddle collection" lists the trainer's collections (`GET /training/collections`) and posts FEN/solution or PGN to `/training/collections/{id}/custom` or `/custom/import` with an `Idempotency-Key`. The dialog handles the trainer-tools refusal (403, no Gold trainer tools) with a Studio string and the upgrade link, and reports per-item results through the closed error-code mapping.
* Proof: request-builder unit tests plus a check against a local ChessRiddle backend with the new gate.

### D. Repertoire (ChessRiddle first, then Studio, then mobile)

* **D1, ChessRiddle web (Felix designs the UI):** a repertoire model (user, name, colour, PGN with variations and comments, updated-at), upload/replace and list/read endpoints, a viewer that clicks through lines in desktop and phone browsers, and an offline copy for tournament halls (new work: the web app has no offline data cache today). Repertoire training (spaced repetition) is the Gold part. A generous technical cap per file and per account against abuse, not a marketing limit.
* **D2, Studio:** "Sync to ChessRiddle" on a repertoire file uploads the exported PGN; every sync replaces the server copy (desktop is the editing side). Two-way sync is out of scope for the first version.
* **D3, mobile:** only after Felix accepts D1 on the web, a GitHub issue for Philipp following the repository's mobile-issue template (decision, exact backend behaviour, call sites, tests, backend-deploy dependency).

### E. Own-game puzzles (optional, last)

* Server-side selection of critical positions from games the user uploads; reuses B's panel. Not started without a separate go from Felix.

## Decisions and trade-offs

* **Felix:** product roles (done: ChessRiddle Studio), sync free and repertoire training Gold, repertoire UI design, whether E is built, any price or limit shown to users.
* **Technical (recommended):** PKCE loopback rather than a pasted token (no copy-paste, revocable, same flow as Lichess, one shared helper); refresh token in the keyring, access token in memory; desktop tokens restricted server-side; the desktop never decides entitlement; no CSP widening.
* Rejected: embedding the ChessRiddle website in a webview (foreign UI, cookie and CSP problems, no board integration); shipping any shared ChessRiddle client code in Studio (GPL boundary); an API key per installation (extractable from public code); a content hash to skip unchanged repertoire uploads (no observed cost; PGN repertoires are small).

## Risks / open questions

* Which login surface A uses (Supabase OAuth server vs. a ChessRiddle connect page) and how desktop-token restriction is enforced are decided in A's own plan after checking the project's Supabase configuration.
* Legal texts: when A ships, ChessRiddle's privacy policy (and Studio's, once the download page has one) describes the account link, in every supported language, in the same run.
* Desktop traffic gets the same per-user and per-IP rate limits as the web app.

## Not part of this task

Release of ChessRiddle Studio, the download page on chessriddle.com, code signing, catalog hosting.

## Phases

1. **A** — ChessRiddle: login surface, desktop-token restriction, `desktop` attribution and its consumers (ChessRiddle `build` run, its push/deploy rules). Studio: shared OAuth/PKCE helper with Lichess moved onto it, generalised credentials, refresh/revoke owner, Accounts card. Sensitive in both repositories. Proof: Studio `cargo test` for the helper, both providers and the failure classes, `pnpm bindings:check`, `pnpm verify:app` sign-in against a local ChessRiddle backend and Supabase target; ChessRiddle tests for attribution and token restriction.
2. **B** — Studio Train panel (solution stripped natively, submit contract) plus the ChessRiddle compatibility consumers. Proof: OpenAPI contract check, e2e with mocked IPC, verify:app against the local backend, ChessRiddle route tests.
3. **C** — ChessRiddle CUSTOM gate for desktop (deployed first), then the Studio send dialog. Proof: request-builder tests, verify:app against the local backend with the gate.
4. **D1** — ChessRiddle repertoire feature, planned and reviewed in a ChessRiddle `build` run with Felix's design input.
5. **D2** — Studio sync, after D1 is live.
6. **D3** — GitHub issue for Philipp, after Felix accepts D1.
7. **E** — only on Felix's go.

## Carried to phase plans

Obligations the round-2 lenses named; each phase's own plan must carry them verbatim.

* CR-1 (A): desktop-token restriction is an **allowlist** of routes, enforced once in the shared auth dependency (`backend/app/core/auth.py`), not a per-route deny-list. If the connect-page login is chosen, the plan states how that page mints a token with the identifying claim.
* CR-2 (A): split A into a behaviour-preserving first commit (shared OAuth/PKCE helper with Lichess moved onto it, existing `oauth.rs` tests green) and the ChessRiddle provider after it.
* CR-3 (A): the single-flight refresh owner writes the rotated refresh token to the keyring (same handle, replace) before it releases the lock or uses the new access token; if that write fails, it keeps the token in memory and reports the failure, never silently dropping it.
* CR-4 (A): sign-out always completes locally through the `PendingDelete` journal; the server revoke is best-effort and its failure is reported as "disconnected locally, server session still active"; any retry is explicit and user-visible, never a background resurrection.
* CR-5 (B): the native module deserialises the puzzle into an **allowlisted** renderer DTO (position, side to move, display metadata) rather than forwarding the payload minus known fields. It keeps no solution copy: `ValidationResultDTO.correct_variation` supplies the line after the verdict. Keeping the PV out of the renderer is hygiene, not protection (the web API sends it to any client).
* CR-6 (A/B): the link allowlist compares the parsed URL exactly: scheme `https`, host `chessriddle.com` or `www.chessriddle.com`.
* CR-7 (A/B): the attribution consumers that switch on `surface == "app"` include `puzzle_client_compatibility.py:58,107`, `client_release_gate.py:111` and `routes/puzzles/_helpers.py:211` (MIXED unmasking).

## Reviews

### Round 1 (2026-11-06, native read-only lenses; the Grok lens leaves of this session failed their profile check)

* review-plan — REVISE. Adopted (Fix): wrong route prefix `/training/collections` (blocker); CUSTOM gate refuses non-web/non-native clients, so C needs a ChessRiddle change and deploy (blocker); standard tactic payload carries `principal_variation`, now stripped natively; submit takes a `variation_tree`, now named plus an OpenAPI contract check; credentials are Lichess-typed and have no refresh path, now generalised with single-flight refresh; no OAuth authorize/consent surface exists, now an explicit A decision with email/password and token-verification checks; offline packs are mobile-only, D1 offline copy marked new work; CSP is not the surface for native calls, now "no widening"; C handles the trainer-tools 403; attribution consumers named for A/B (nit adopted).
* review-minimalism — REVISE. Adopted: extract one OAuth/PKCE helper instead of a second copy, with Lichess moved onto it; cut the repertoire content hash and skip logic. Skipped (nit, confidence 60): moving attribution from A to B — A needs it for token restriction and metrics from the first request.
* review-tauri-security — REVISE. Adopted: refresh single-flight, failure classes (only `invalid_grant` clears), revoke on sign-out, startup reconciliation (blocker); identifier-derived keyring service, one record per account, refresh token only (Windows blob limit); no CSP widening and compile-time HTTPS base URLs; attribution is a hint, never entitlement or rate limit; desktop tokens restricted on account/payment/destructive routes and exact redirect allowlist; closed error-code mapping, plain-text server text, allowlisted links, display data non-authoritative; provider-bound auth attempts (nit adopted).

### Round 2 (2026-11-06, closure, native read-only lenses)

* review-plan — APPROVED. All round-1 findings CLOSED with source evidence. New: token restriction mixed deny-list and allowlist (carried as CR-1); split A so the Lichess helper move is a behaviour-preserving first commit (CR-2); retaining the stripped PV is redundant because the verdict returns `correct_variation`, and stripping is hygiene, not protection (nit, carried as CR-5). Consumers of `surface == "app"` listed (CR-7).
* review-tauri-security — APPROVED. All round-1 findings CLOSED. New: persist the rotated refresh token before releasing the single-flight lock (CR-3); sign-out completes locally, revoke best-effort and reported (CR-4); allowlisted renderer DTO and a bounded solution map (nit, CR-5); exact scheme/host link comparison (nit, CR-6).
* review-minimalism — APPROVED. All round-1 findings CLOSED; the security corrections are justified by expiring Supabase tokens. Nit below threshold: keep the credentials generalisation to provider suffix plus one record per account, no token-shape abstraction (noted for A).

Adoptions: r1=20 r2=7 (carried, no further plan round needed). Plan review complete; the plan is approved for Felix to read, not for building.
