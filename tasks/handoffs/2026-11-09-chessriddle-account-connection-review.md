# Plan: Connect a ChessRiddle account from ChessRiddle Studio (integration phase A)

Repositories: ChessRiddle (`/home/felixb/Projekte/chess-tactics-app.worktrees/studio-account`, branch `build/studio-account-20261109`, target `develop`) and ChessRiddle Studio (`/home/felixb/Projekte/chessfable.worktrees/chessriddle-account`, branch `build/chessriddle-account-20261109`, target `master`). The same plan file is in both worktrees' `tasks/plans/`.

## Goal

A ChessRiddle Studio user opens the Accounts page, clicks Connect ChessRiddle, signs in on chessriddle.com in the browser, approves the connection, and Studio shows "connected as <username>, plan Free/Gold". The connection survives restarts, refreshes silently, and can be ended from Studio or from ChessRiddle account settings. A desktop token can do nothing beyond the routes this phase allows, on the ChessRiddle API or on Supabase. No ChessRiddle code or secret enters the public Studio repository.

## MANDATE

Felix, chat 2026-11-09: "Build Phase E, Phase A, Executor Codex." Read as phase A of `tasks/handoffs/2026-11-06-chessriddle-integration-plan.md`; Phase E depends on phase B's panel and is not started.

Felix, chat 2026-11-06 (from the feedback plan's MANDATE): "Yes, I will definitely add this login … Yes, those users can login, but I also expect users who don't have a JazzRiddle [ChessRiddle] account to use JazzRiddle Studio. … I will make the Jazz Riddle Studio the desktop app for my Jazz Riddle app."

Felix, chat 2026-11-09, answering whether the website also lets users disconnect the app: "Add it to settings (Recommended)": account settings gets one small row, "ChessRiddle Studio connected", with a Disconnect button.

Handoff phase A, verbatim obligations:

* CR-1 (A): desktop-token restriction is an **allowlist** of routes, enforced once in the shared auth dependency (`backend/app/core/auth.py`), not a per-route deny-list. If the connect-page login is chosen, the plan states how that page mints a token with the identifying claim.
* CR-2 (A): split A into a behaviour-preserving first commit (shared OAuth/PKCE helper with Lichess moved onto it, existing `oauth.rs` tests green) and the ChessRiddle provider after it.
* CR-3 (A): the single-flight refresh owner writes the rotated refresh token to the keyring (same handle, replace) before it releases the lock or uses the new access token; if that write fails, it keeps the token in memory and reports the failure, never silently dropping it.
* CR-4 (A): sign-out always completes locally through the `PendingDelete` journal; the server revoke is best-effort and its failure is reported as "disconnected locally, server session still active"; any retry is explicit and user-visible, never a background resurrection.
* CR-6 (A/B): the link allowlist compares the parsed URL exactly: scheme `https`, host `chessriddle.com` or `www.chessriddle.com`.
* CR-7 (A/B): the attribution consumers that switch on `surface == "app"` include `puzzle_client_compatibility.py:58,107`, `client_release_gate.py:111` and `routes/puzzles/_helpers.py:211` (MIXED unmasking).

Felix's conditions for this run: backend deploy needs his separate go; he sees the connect page before it ships; legal texts are updated in every supported language in the same run.

Felix, chat 2026-11-09: "All of this, what we built in Chessriddle now to the connection, should not be pushed to develop, because I only want to push it when I'm ready to deploy and when the studio is complete to release. because before I don't want to have it when I have to deploy soon in Chessriddle. I don't want to deploy the connection if Chessriddle Studio is not ready yet. So leave this in a branch but don't push it to develop." And: "In studio, of course you can push."

## Threat model and non-goals

* Studio is public, modifiable code. No secret ships in it. The connection is a public client using PKCE; its client id is a public constant.
* Nothing Studio sends is trusted: entitlement, limits and route access are decided on the server from the verified JWT. Client attribution is a metrics hint.
* A desktop token may be stolen from a user's machine. It carries only the authority of the phase's allowlist.
* A local process may squat a loopback port or observe the redirect. It holds no PKCE verifier and cannot redeem a code; the `state` value binds the callback to the attempt.
* ChessRiddle tokens stay native: OS keyring and native memory. They never reach the renderer, web storage, logs or error payloads.
* Server text is plain text. Error codes map to a closed set of Studio-owned strings. Links the native side opens pass the exact CR-6 comparison.
* Webview CSP and capability scopes are not widened. All ChessRiddle traffic is native. Studio never talks to Supabase.
* GPL boundary: no ChessRiddle source enters Studio and no Studio source enters ChessRiddle. They meet at HTTP.
* Non-goals: phases B–E, Studio release, a list of arbitrary third-party OAuth apps, multiple simultaneous ChessRiddle accounts in Studio.

## Traced premises

* Production Supabase Auth runs v2.197.0 (Management API health, 2026-11-09), and the OAuth 2.1 server is present and disabled: `oauth_server_enabled=false`, `oauth_server_authorization_path=null`, dynamic registration false. The feature is documented as beta.
* Access tokens issued for an OAuth client carry a signed `client_id` claim. Supabase Auth source `internal/tokens/service.go:702-730`; docs "OAuth 2.1 token security". Web session tokens have none.
* Refresh requests name the client and a session bound to a client refuses another (`internal/tokens/service.go:299-307`). Production has rotation on and a 10-second reuse interval; `jwt_exp` is 3600.
* OAuth client redirect URIs match by exact string (`internal/api/oauthserver/authorize.go:550-559`), at most 10 per client (`service.go:32`), and `http://127.0.0.1` is permitted (`service.go:206-211`). A port-0 listener cannot work.
* Consent API calls check `Origin` with `IsRedirectURLValid`, which requires the same scheme as Site URL or an allow-list match (`internal/utilities/request.go:106-136`). Production `site_url` is `http://chessriddle.com` and `uri_allow_list` holds only exact `/auth/callback` URLs, so a request from `https://chessriddle.com` is refused today. The authorization path is also appended to Site URL, so the redirect would start in cleartext.
* `POST /auth/v1/logout?scope=local` ends the caller's own session from its JWT (`internal/api/logout.go:21-59`). `supabase.auth.oauth` in the installed auth-js 2.118.0 exposes `getAuthorizationDetails`, `approveAuthorization`, `denyAuthorization`, `listGrants`, `revokeGrant` (`GoTrueClient.ts:500-504`). `revokeGrant` invalidates all sessions and refresh tokens for that client.
* An OAuth-server access token keeps the user's role and subject (`internal/tokens/service.go:710-729`). Supabase documents that OAuth scopes "do not control access to your database tables or API endpoints", and RLS authorizes by `auth.uid()` (`backend/alembic/versions/c1d2e3f4a5b6_rls_baseline_full.py:126`). Auth's own user routes accept it, and logout defaults to global (`internal/api/logout.go:25`). A FastAPI allowlist therefore cannot contain a Supabase-issued token.
* Backend: `_resolve_token_identity` (`backend/app/core/auth.py:205`) is the point both `get_current_user` and account deletion pass through. `get_current_user_optional` (`:321`) does not pass `Request`. Backend reads no `client_id`. It performs no per-request session lookup, so an already-issued access token stays valid until expiry after a revoke.
* Rate-limit keying verifies bearer JWTs separately to pick a user bucket (`backend/app/core/rate_limit.py:120`). Request context reuses the cached verified payload and reads `email` from it (`backend/app/core/dependencies.py:222-225`).
* `GET /api/v1/users/me` returns `username` and `permissions.tier` (`backend/app/api/routes/users.py:196`), without email or credentials. It is the only API route phase A needs.
* `client_attribution.py:16-17,85` maps unknown surfaces to `None`. Consumers of `surface == "app"`: `puzzle_client_compatibility.py`, `client_release_gate.py`, `routes/puzzles/_helpers.py`, and the metrics groupings `engagement_metrics.py:687,764`, `admin_members_repository.py:54`, `admin_usage.py:1049`, `admin_members.py:813`.
* Web login is email/password through `signInWithPassword`; no social login exists. `ProtectedRoute` preserves path and query through login. Small page pattern: `frontend/web/src/app/[locale]/auth/lichess/callback/`. `nginx/nginx.conf:86` redacts only confirmation query strings. UI languages are 16 under `frontend/web/src/messages/<locale>/common.json`; legal documents are DE/EN/ES with revision hashes pinned in `legalDocumentRevisions.ts`. Account settings have no connected-apps surface.
* Studio: `oauth.rs` binds port 0 (`:507`), holds Lichess URLs and scope inline, and `authenticate` refuses non-Unix (`:566`), pinned by the refusal inventory test. `credentials.rs:36-37` fixes the `.lichess` keyring suffix and `lichess-accounts.json`; journal states are `Active`, `PendingAdd`, `PendingDelete`; re-storing an account performs no journal write (`:395`). Windows limits a secret to 1280 UTF-16 units. `LichessAccountHandle` reaches `lichess.rs:188` and `fs.rs:1478`.
* `feedback.rs:15` holds a literal `https://chessriddle.com/api/v1/feedback` with no development override. `native_json_http_client` (`infra/net.rs:45`) disables redirects and rejects loopback through DNS, while literal `127.0.0.1` connects. `AccountCard` and `AccountCards` are built around Lichess/Chess.com game providers (`AccountCards.tsx:250`, `Accounts.tsx:183`).

## Approach

### Login mechanism

Optimal: ChessRiddle's backend issues its own desktop credentials → I use it. The web page authorizes with the user's existing session; the backend mints a separate, opaque desktop credential. Supabase cannot accept it, because it is not a JWT, so the database, Auth and Realtime are out of its reach by construction. This states CR-1's connect-page case: the identifying claim is the credential's own record in ChessRiddle's database, recognised by a fixed prefix and looked up by hash. Email/password accounts work because sign-in happens on the existing web login.

### Server credential contract

Two service-only tables with RLS enabled and no policies, following `alembic-rls-policy.md`, cascade-deleted with the user:

* Authorization codes: hash, user, redirect URI, S256 challenge, expiry of 5 minutes, single use.
* Desktop sessions: user, hashed access token, access expiry of 1 hour, hashed confirmed refresh token, hashed pending refresh token and its random salt, created and last-used times.

Refresh tokens have the form `<prefix><session id>.<secret>`, so a retired token still names its session. Only SHA-256 hashes of random 256-bit secrets are stored. An expiry cleanup job bounds both tables.

Routes, under `/api/v1/desktop-auth`:

* `POST /authorize` needs a web session. It validates the redirect URI as exactly `http://127.0.0.1:<port>/callback` with a port from 1024 to 65535, requires S256, and returns the redirect URL carrying code and state.
* `POST /token` is public and rate limited per IP. It accepts the standard form-encoded `authorization_code` and `refresh_token` grants and answers in the OAuth 2 token JSON shape. Every unknown, expired, consumed or revoked input returns HTTP 400 with `{"error":"invalid_grant"}`, so the terminal case is one code.
* Refresh rotates under a row lock and is idempotent until confirmed, so a lost response or an overlapping retry is recoverable at any delay. Rotation stores a random salt and derives the next refresh and access tokens as SHA-256 of the presented confirmed refresh token, the salt and a purpose label. Every replay of the confirmed token before confirmation recomputes and returns the same tokens, so a delayed request can never supersede a retry. The server holds no plaintext and no new secret. The client confirms receipt by a request with the new access token or a refresh with the new refresh token; the pending token then becomes the confirmed one and the old one is retired.
* A refresh request has a server age bound of 15 seconds. Studio's 30-second total timeout includes up to 10 seconds of connection time, so the bound leaves 15 seconds for everything before the application sees the request. Age is measured from entry into the application, on a monotonic clock, before any database or thread-pool wait, and checked once the row lock is held. An older request changes nothing and returns 503, which the client treats as a transient failure. An original that entered within 15 seconds of being sent has therefore acted before Studio's timeout, and so before its retry exists.
* Confirmation takes the same row lock as refresh and rechecks that the pending token is still the one the access token belongs to, so a confirmation that lost a race with a refresh changes nothing. Only a session with a pending rotation takes the lock.
* A retired token, recognised by its session id, returns `invalid_grant` and revokes the session, whichever party presents it. No timing decides this.
* `POST /revoke` takes the desktop bearer token and ends that session.
* `GET /connections` and `DELETE /connections` need a web session, and serve the settings row.

`DELETE /connections` runs in one READ COMMITTED transaction: it deletes the user's codes first, then in a separate statement the user's sessions. Code redemption locks the code row with `FOR UPDATE`, inserts the session, marks the code consumed and commits. If redemption holds the row, the code delete waits for its commit; the session delete that follows takes a fresh statement snapshot and sees the new session. If the code delete wins, redemption finds no row. An approval made after the delete is a new consent.

### Restricting desktop credentials (CR-1)

In the shared resolver, a bearer value with the desktop prefix never reaches JWT verification. It is looked up by hash; missing, expired or revoked is a 401. The request's method and matched route template are then compared to one allowlist constant, which in phase A is exactly `GET /api/v1/users/me` and `POST /api/v1/desktop-auth/revoke`. A refusal is a typed 403 that optional auth cannot turn into anonymous access, so `get_current_user_optional` must receive `Request`. A desktop credential with no request context fails closed. Request context works without a JWT payload or email. Rate-limit keying treats any desktop-prefixed value like an anonymous request and keys it by IP, because the value is unverified at that point. Web and mobile tokens are unchanged, and web-session-only routes refuse desktop credentials through the same allowlist.

### Client attribution (CR-7)

`surface` accepts `desktop`, and `platform` accepts `linux`, `macos`, `windows`. Studio sends these on ChessRiddle API calls. Each listed consumer treats a desktop client as neither `app` nor `web`, with the behaviour stated and tested for compatibility, release gate and MIXED unmasking. Metrics keep desktop in their unknown bucket in phase A, because the allowlist lets no attempt be recorded. Attribution never gates entitlement.

### Consent page

`/auth/connect` under the localized auth layout, behind `ProtectedRoute`, which preserves the query through login. Before showing anything it checks the redirect URI form and that a challenge and state are present; an invalid request shows an error and offers no Allow. It shows the signed-in account, the fixed text that ChessRiddle Studio asks to connect, and what it may do, then Allow and Cancel. Consent is asked on every connect. Allow calls `/authorize` and navigates only to the returned URL after checking the same exact form. Cancel navigates to the redirect URI with `error=access_denied` and the state. Failure states are translated. All 16 locales get the messages.

### Disconnect on the website

Account settings shows one row, "ChessRiddle Studio connected", when `GET /connections` returns a connection, with a Disconnect button. Loading, failure and empty states are handled, and the row is absent with no connection. Access ends immediately, because every desktop request is checked against the session record.

### Legal texts

Privacy DE/EN/ES describe the connection: what Studio can read, that tokens are stored in the operating system's credential store, how to disconnect in both places, and retention. Terms DE/EN/ES name desktop access. New revision labels and hashes land in the same commit.

### Studio: one OAuth path, two providers (CR-2)

The provider-neutral part of `oauth.rs` (loopback listener, state, PKCE, code exchange, token-free error mapping, attempt lifecycle) becomes one helper, with Lichess moved onto it in a behaviour-preserving first commit. Each attempt is bound to its provider, so a code can reach only that provider's token endpoint.

### Studio: endpoints and links

One native module owns ChessRiddle's API origin as a compile-time constant, and `feedback.rs` moves onto it. Release builds accept only `https://chessriddle.com`. A loopback override is compile-time, literal `127.0.0.1` only, and honoured only under the `.dev` identifier. A compile-time availability constant stays false until Phase 6, and the `.dev` build sets it true. While false, the connect action is absent from the UI and the native command returns a typed refusal. Every link Studio opens for ChessRiddle passes CR-6's exact comparison before it reaches the opener, including the consent URL.

### Studio: credentials

`credentials.rs` is parameterised by provider: keyring service `identifier + suffix`, its own registry file, and a distinct handle type, so a ChessRiddle handle cannot reach Lichess endpoints. Lichess addresses stay byte-identical with no migration. One account is one record and only the refresh token is stored; at most one ChessRiddle account exists. Startup reconciliation covers both registries. No token-shape abstraction is added.

### Studio: token owner (CR-3, CR-4)

One native owner serialises refresh, disconnect and reconnect, with no lock held across `.await`. The access token lives only in its memory and is refreshed before expiry. A rotated refresh token is written to the keyring before the new access token is used or waiting callers proceed; a failed write keeps it in memory and is reported, and the card asks to reconnect after restart if it was lost. `invalid_grant` is the only response that clears the credential and shows reconnect-needed. Network errors, 429 and 5xx keep it. Disconnect journals `PendingDelete`, completes locally, then best-effort calls `POST /desktop-auth/revoke`. There is no background retry. Disconnect has typed outcomes: failure before local access was removed, where the card stays connected; or removed, carrying two independent flags as in `d-20260831-20`, "server session still active" and durability uncertain. The card follows the native account list, never its own assumption. The owner's exit paths are normal completion, disconnect, application exit and error.

### Studio: Windows

The ChessRiddle connect path carries no typed refusal. Its listener, keyring and registry dependencies have Windows implementations, and its tests run in `rust-windows-test` and `rust-macos-test`. Real Windows Credential Manager persistence and a browser round trip are not run by any gate, and are a release check for Felix's Windows build.

### Studio: renderer

A dedicated ChessRiddle card on the Accounts page, fed by native commands and never persisted as entitlement, shows Connect, in-progress, connected as username and plan, reconnect-needed, and the disconnect outcomes. New commands are registered through Specta. The plan is display data refetched from `/users/me`. Strings go through i18next.

## Decisions and trade-offs

* Felix: web settings Disconnect row (answered). ChessRiddle commits stay on a local branch until Studio is ready (answered). The connect page is shown to Felix before deployment.
* Decided autonomously (recorded in each repository's `tasks/decisions.md` when implemented):
  * ChessRiddle-issued opaque desktop credentials over Supabase's OAuth server. Round 1 showed a Supabase token keeps full user authority at Supabase. A restricting access-token hook would run on every login in production and still leave Auth's own routes open. The OAuth server is also beta, requires a `site_url` change and fixes loopback ports. Reversal: replace the provider endpoints and the credential tables.
  * Opaque tokens looked up per request over a new signed JWT: immediate revocation and no new signing secret, at the cost of one indexed lookup on allowlisted routes.
  * `/users/me` and `/desktop-auth/revoke` are the only allowlisted routes. Later phases add routes explicitly.
  * Consent on every connect. No stored consent record.
  * A dedicated renderer card rather than extending the game-provider `AccountCard`.
  * No Windows refusal for this provider.
  * Threat-model edit, focused judgment: only the two bullets naming Supabase changed. The adversary, the stolen-token limit and the renderer boundary are unchanged, and the mechanism now meets them.
* Rejected: pasted tokens, embedding the website in a webview, Supabase's OAuth server (above), a Custom Access Token Hook with a restricted Postgres role (above).

## Risks / open questions

* ChessRiddle now owns a small credential service: a security-sensitive surface reviewed as such, with its tests naming each refusal.
* Windows Credential Manager and browser round trip have no automated runtime proof.
* Two rare sequences cost one reconnect and grant no authority: Studio restarted during a stalled refresh and confirmed its new tokens before the stalled original reached the row lock, or a request that took more than 15 seconds to enter the application and then reached the row lock after its retry was confirmed. nginx sets no `proxy_ignore_client_abort`, so it drops a request whose client has gone.
* The ChessRiddle branch stays local and drifts from `develop` until release. Alembic heads, legal revision labels and hashes, `backend/openapi.json` and locale catalogs are the likely conflicts. Phase 6 rebases, regenerates and re-reviews them.

## Not part of this task

Phases B–E, Studio release, download page, code signing. Production deployment happens only in Phase 6, after Felix's go. Pushing any ChessRiddle commit of this work to `develop`, or to any remote branch.

## Phases

**Landing per repository.** ChessRiddle phases 1–2 are reviewed, gated and committed on local branch `build/studio-account-20261109` in their worktree. The branch and worktree are kept and nothing is pushed. Studio phases 3–5 land on `master` by the ordinary reviewed push. Studio's availability constant stays false, so its connect action stays absent until Phase 6.

1. **ChessRiddle backend.** Existing: `backend/app/core/auth.py`, `core/dependencies.py`, `core/rate_limit.py`, `core/client_attribution.py`, `core/puzzle_client_compatibility.py`, `core/client_release_gate.py`, `api/routes/puzzles/_helpers.py`, `main.py`, `backend/scripts/check_rls_drift_runtime.py` (both tables with empty policy tuples), `backend/scripts/check_pg_cron_drift_runtime.py` (the cleanup job), `backend/openapi.json`, `frontend/web/src/types/api.generated.ts`. New: `api/routes/desktop_auth.py`, `services/desktop_auth_service.py`, schema and model modules, one Alembic revision with RLS and cleanup job, tests. Role `sensitive`. RULES include `.claude/rules/alembic-rls-policy.md`. PROOF: `bash scripts/affected-tests.sh --changed-path <each changed path>`, naming tests for: PKCE mismatch; code reuse; a non-loopback, `localhost` or port-less redirect; rotation; a rotation whose response is dropped and which is retried after the client timeout, once and twice, returning identical tokens; a delayed original overlapping its successful retry leaving the client's tokens valid; a request older than the age bound at the row lock changing nothing and returning 503; an access-token confirmation racing a refresh leaving the new pending token intact; a retired token revoking the session so its current tokens stop working, including when an attacker redeemed and confirmed first and including across a later rotation; every `invalid_grant` case; changing bogus desktop-prefixed values staying in one IP rate-limit bucket; a desktop credential reaching `/users/me` and refused 403 on another route, on `DELETE /users/me`, on an optional-auth route and on `/desktop-auth/connections`; a web token unchanged; revocation taking effect on the next request; and a concurrent code redemption against `DELETE /connections` leaving no live session. Also the existing ephemeral `--migrate-and-guards` proof for the migration and both drift guards.
2. **ChessRiddle web.** New: `frontend/web/src/app/[locale]/auth/connect/` page and client, a settings row component. Existing: `src/components/settings/AccountSettings.tsx`, `src/messages/<16 locales>/common.json`, `routeMessageKeys.json`, privacy and terms DE/EN/ES, `lib/constants/legalDocuments.ts`, `legalDocumentRevisions.ts`, `privacyDisclosures.test.ts`. Role `sensitive`. PROOF: `cd frontend/web && npx vitest related --run <paths>`, route-message regeneration check, legal parity and revision tests, and a mocked Playwright spec for allow, cancel, invalid redirect with no Allow, and the settings row, registered in `frontend/web/e2e/mockedSpecs.ts` and run through `python scripts/gate_receipt.py ensure frontend-e2e-mocked`.
3. **Studio helper (CR-2).** `src-tauri/src/oauth.rs` plus new helper module. Role `sensitive`. PROOF: `cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- oauth::`, unchanged existing tests, and `pnpm bindings:check` with no diff.
4. **Studio native provider.** New: `src-tauri/src/chessriddle.rs` (endpoints, links, provider, token owner, unregistered command functions). Existing: `credentials.rs`, `feedback.rs`. No command is registered yet, because the consumer gate rejects an exported command without a production consumer. Role `sensitive`. PROOF: `cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- oauth:: credentials:: feedback:: chessriddle`, naming tests for: concurrent callers, which cannot use a new access token before persistence completes; a failed keyring write leaving the rotated token usable; `invalid_grant` versus network, 429 and 5xx; each disconnect outcome including both flags together; restart reconciliation; provider-bound attempts; and CR-6 accepting HTTPS on both hosts while HTTP or any other host never reaches the opener.
5. **Studio commands, renderer and real flow.** New: `src/components/home/ChessRiddleAccountCard.tsx` with tests. Existing: `src-tauri/src/main.rs` (command registration), `src/bindings/generated.ts` (regenerated), `src/components/home/AccountsPage.tsx`, `src/translation/*`, `e2e/fixtures.ts`, an e2e account spec. Role `normal`. PROOF: `pnpm bindings:check`, `pnpm exec vitest related --run <paths>`, `pnpm i18n:check`, `pnpm ipc:consumers:check`, the e2e account spec. Then one real flow through a `.dev`-identifier release binary against the local ChessRiddle build: backend on a disposable database, disposable Supabase Auth v2.197.0 for web login following the existing auth-recovery gate's stack, and the production web build. The URL Studio opens is driven in a real browser through login, the real consent page, Allow and the native loopback callback. It covers connect, restart, refresh and disconnect from Studio, then connect again and disconnect through the real settings row, asserting Studio's credential is refused and shows reconnect-needed while the web session still works. The harness is a one-off under the run's temporary directory, not committed.
6. **Release — only after Felix says Studio is ready.** Rebase the local ChessRiddle branch onto `develop`, regenerate conflicts, review the rebased range, run full ChessRiddle gates, push to `develop`, deploy through the deploy skills with Felix's go. Then set Studio's availability constant true in its own reviewed commit.

## Reviews

### Round 1 (2026-11-09, Codex read-only lenses, snapshot plan-r1)

Verdicts: plan REVISE, minimalism APPROVED, correctness REVISE, error-handling APPROVED, tests REVISE, ipc-contract APPROVED, persisted-state APPROVED, platform-semantics APPROVED, tauri-security APPROVED, api-contract REVISE, concurrency REVISE, integration REVISE, react-lifecycle REVISE, security REVISE. Raw reports: `/tmp/build-account-20261109/lens-*-r1.txt`.

* I1 Fix (plan#1, security#1): a Supabase token keeps full user authority at Supabase, so a FastAPI allowlist does not meet the threat model's stolen-token limit. Verified against the Supabase docs and `tokens/service.go`. Correction: ChessRiddle-issued opaque credentials.
* I2 Fix (plan#2, correctness#1, error-handling#1, api-contract#1, integration#1): real terminal refresh failures are not `invalid_grant`. Correction: the server contract now returns one code for every terminal case.
* I3 Fix (plan#3): the real login proof could not run with the client id absent. Correction: `.dev` availability against a local backend, no client registration.
* I4 Fix (plan#4): incomplete file inventory; "Settings → Accounts" does not exist. Correction: inventory per phase; the surface is the Accounts page.
* I5 Fix (error-handling#2): local disconnect failures unspecified. Correction: typed disconnect outcomes.
* I6 Fix (tests#1): CR-3 single-flight had no concurrent proof. Correction: named in phase 4.
* I7 Fix (tests#2): CR-6 had no rejection proof. Correction: named in phase 4.
* I8 Fix (tests#3): website disconnect had only a mocked proof. Correction: in the phase 5 real flow.
* I9 Fix (concurrency#1, integration limitation): website revoke could race an unredeemed code. Correction: revoke and redemption transaction contract, named in phase 1.
* I10 Skip (react-lifecycle#1): pre-existing `AccountSettings.tsx:169` late state update after unmount. No user-visible effect and below rule 4d's bar; the new row is its own component with its own cleanup.
* I11 Skip (error-handling limitation; plan, platform-semantics, tauri-security, security, ipc-contract assessments): keep a typed Windows refusal. Four lenses found no source reason for one and a refusal would ship a platform gap with no defect behind it. The missing runtime proof is stated as a release check.

Adoptions: r1=9.

### Round 2 (2026-11-09, Codex read-only lenses, snapshot plan-r2)

Verdicts: plan REVISE, minimalism APPROVED, correctness APPROVED, error-handling APPROVED, tests APPROVED, tauri-security APPROVED, api-contract APPROVED, concurrency APPROVED, integration REVISE, security REVISE, migration REVISE. Raw reports: `/tmp/build-account-20261109/lens-*-r2.txt`. Closed: I1, I2, I3, I5, I6, I7, I8.

* I1 Authority (plan r2#3): the new server mechanism rests on MANDATE CR-1 ("If the connect-page login is chosen, the plan states how that page mints a token with the identifying claim") and on the frozen threat-model limit that a stolen desktop token "carries only the authority of the phase's allowlist".
* I4 Fix, reopened (plan r2#1, migration r2#1): the drift registries were missing. Correction: both named in phase 1, with the guards proof.
* I9 Fix, open (plan r2#2): closure lacked an ordering argument. Correction: the statement order and READ COMMITTED reasoning are in the contract; concurrency and integration closed it, review-plan rechecks.
* I12 Fix (plan r2#4): the real flow bypassed the consent page. Correction: the real page in a real browser.
* I13 Fix (error-handling r2#1): both disconnect warnings can occur together. Correction: two independent flags.
* I14 Fix (tests r2#1): the mocked spec was not in the gate. Correction: registration and command named.
* I15 Fix (integration r2#3): a lost refresh response forced a reconnect. Correction: confirmation-based rotation with no time window.
* I16 Fix (security r2#1): hash-keyed rate limits trusted unverified values. Correction: desktop-prefixed values key by IP.

Adoptions: r1=9 r2=9.

### Round 3 (2026-11-09, Codex read-only lenses, snapshot plan-r3)

Verdicts: plan REVISE, error-handling APPROVED, tests APPROVED, integration REVISE, security REVISE, migration APPROVED, concurrency REVISE. Raw reports: `/tmp/build-account-20261109/lens-*-r3.txt`. Closed: I4, I9, I12, I13, I14, I16.

* I15 Fix, reopened (plan r3#1, error-handling r3#1, integration r3#1, security r3#1, concurrency r3#1 and #2): a cleared hash could not identify its session, and a delayed request could supersede a retry. Correction: refresh tokens name their session, and rotation derives identical tokens until confirmed. Authority: CR-3 ("never silently dropping it") and the plan's rule that network failures keep the credential.
* I17 Fix (plan r3#3): phase 4 exported commands with no consumer. Correction: registration moves to phase 5 with the consumer.
* Skip (migration r3 nits): the bare-PostgreSQL guard run cannot prove cron scheduling. The deploy guard checks it, and the release rebase repeats the migration proof.

Adoptions: r1=9 r2=9 r3=8.

### Round 4 (2026-11-09, Codex read-only lenses, snapshot plan-r4)

Verdicts: plan REVISE, error-handling REVISE, integration REVISE, security REVISE, concurrency REVISE. Raw reports: `/tmp/build-account-20261109/lens-*-r4.txt`. Closed: I17.

I15, second failed closure. Traced judgment, as rule 12a's escalation requires:

* Invariants: a transient failure never forces a reconnect, and a stolen token that is redeemed first must not leave its holder a working session after the real client notices.
* Previous answer: a fixed 60-second window. Evidence against it: a client timeout does not bound server execution, because `db_client_deadline.py:32` allows 150 seconds, and the window also spared an attacker who redeemed first.
* New evidence: the distinguishing fact is order, not elapsed time. A request that entered the application before retirement cannot be a replay of a retired token. `RequestIDMiddleware` is a pure ASGI outer layer, so entry time can be taken before any wait. `nginx/chessriddle.conf` sets no `proxy_ignore_client_abort`, so nginx abandons a request whose client has gone.
* Judgment and change: remove the time parameter and decide by entry time against retirement time. The residual pre-entry stall costs one reconnect and grants no authority.

Adoptions: r1=9 r2=9 r3=8 r4=6.

### Round 5 (2026-11-09, Codex read-only lenses, snapshot plan-r5)

Verdicts: plan REVISE, error-handling APPROVED, integration REVISE, security REVISE, concurrency REVISE. Raw reports: `/tmp/build-account-20261109/lens-*-r5.txt`.

I15, third failed closure. Traced judgment:

* Invariants: unchanged from round 4.
* Previous answer: compare entry time with retirement time. Evidence against it: an entry that predates retirement does not show who received the rotation, because six workers let an attacker overtake a stalled legitimate request, and one retirement time cannot describe older tokens.
* New evidence: the two invariants conflict only while a delayed original can act after its retry exists. Studio's token requests have a fixed 30-second timeout (`src-tauri/src/infra/net.rs`) and it retries only after that timeout, so a server age bound below 30 seconds removes that state.
* Judgment and change: a retired token always revokes, as OAuth refresh rotation prescribes, and a request past the age bound has no effect. The retirement timestamp is removed.

Adoptions: r1=9 r2=9 r3=8 r4=6 r5=4.

### Round 6 (2026-11-09, Codex read-only lenses, snapshot plan-r6)

Verdicts: plan REVISE, error-handling REVISE, integration APPROVED, security APPROVED, concurrency REVISE. Raw reports: `/tmp/build-account-20261109/lens-*-r6.txt`. Security, integration and concurrency closed I15's authority invariants.

* I15 Fix (plan r6#1, error-handling r6#1, integration r6#1): the 25-second bound ignored time before application entry. Correction: a 15-second bound derived from Studio's 30-second total and 10-second connect limits, with the residual stated.
* I18 Fix (concurrency r6#1): access-token confirmation could overwrite a newer pending rotation. Correction: confirmation shares the row lock and rechecks.

Adoptions: r1=9 r2=9 r3=8 r4=6 r5=4 r6=4.

### Round 7 (2026-11-09, Codex read-only lenses, snapshot plan-r7)

Verdicts: plan APPROVED, error-handling APPROVED, integration APPROVED, concurrency APPROVED. Raw reports: `/tmp/build-account-20261109/lens-*-r7.txt`. Closed: I15, I18. No issue remains open.

Adoptions: r1=9 r2=9 r3=8 r4=6 r5=4 r6=4 r7=0. Plan review complete; awaiting Felix's approval.

## Code review (2026-11-09, Codex lenses over the cumulative diffs)

Studio, range from master: correctness, root-cause, error-handling, tests, minimalism, code-quality, tauri-security, ipc-contract, platform-semantics, records. ChessRiddle, local branch: correctness, root-cause, error-handling, tests, minimalism, code-quality, security, api-contract, concurrency, integration, migration, performance, react-lifecycle, i18n, records.

Studio Fix: offline disconnect (CR-4), typed connect failures, one exchange path, unreachable messages removed, named limits, named removal result, 401 recovery tests, a committed visual snapshot, stale bundle pointer. Closure round: all closed. Skip: test-helper duplication in chessriddle.rs (test-only, no product effect).

ChessRiddle Fix: replayed refresh keeps a usable expiry, conditional last-use update, one confirmation helper, named limits, constant-size connection status, settings reconciliation across late reads and unmounts, consent re-sign-in on 401, stale-approval and refresh-lock tests. Closure round: all closed, plus the focus-refetch test default. Skip: finer consent errors for timeout and 429, because the retry message is accurate for both.

## Real flow (2026-11-09)

Passed on the `.dev` release binary against the local ChessRiddle build, disposable database and Supabase Auth v2.197.0: login, real consent page, Allow, native callback, connected card, restart, forced refresh, Studio disconnect with the server session removed, reconnect, website disconnect, reconnect-needed in Studio, web session intact. Next.js turns a literal loopback host into localhost, so the browser used http://localhost for the web origin while Studio kept its literal 127.0.0.1 origins; production is unaffected. Not covered: Windows Credential Manager and a Windows browser round trip.
