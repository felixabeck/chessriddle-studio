# Plan: In-app feedback from ChessRiddle Studio, with or without a ChessRiddle account

Repositories: ChessRiddle (`/home/felixb/Projekte/chess-tactics-app.worktrees/studio-feedback`, branch `build/studio-feedback-20261106`, target `develop`) and ChessRiddle Studio (`/home/felixb/Projekte/chessfable.worktrees/studio-feedback`, branch `build/studio-feedback-20261106`, target `master`). The same plan file is placed in both worktrees' `tasks/plans/`.

## Goal

A ChessRiddle Studio user opens "Send feedback" from the Help menu or from the error screen, picks a type, writes a message, optionally gives an email address, and the message reaches `feedback@chessriddle.com` marked as ChessRiddle Studio, with app version and operating system attached. It works without a ChessRiddle account. Existing ChessRiddle web/mobile feedback keeps working unchanged. The borrowed En Croissant PostHog telemetry is removed from Studio.

## MANDATE

Felix, chat 2026-11-06 (verbatim):

* "How can users give feedback in ChessFable? Can we implement something like the feedback button we have for ChessRiddle? Or what do you suggest as an easy way to give me feedback to improve the product after I published it?"
* "I just changed the name from Chess Fable to Chess Riddle Studio. So this is linked more tightly to Chess Riddle now."
* "Yes, I will definitely add this login … Yes, those users can login, but I also expect users who don't have a JazzRiddle [ChessRiddle] account to use JazzRiddle Studio. So those should also be able to send me feedback. … I will make the Jazz Riddle Studio the desktop app for my Jazz Riddle app."
* "I think optional is better. I don't need to know the user if the feedback is important. Yes, build this now across both repositories, each in a separate worktree with executor grog [Grok], full auto."

The recommendation Felix approved with "build this now" (assistant, same chat): one ChessRiddle `/feedback` endpoint where login is optional — logged-in callers unchanged (reply address from the account, submission linked to the user); callers without login accepted with an optional email field and a stricter per-IP rate limit. Studio gets one feedback dialog, also reachable from the error screen; version and operating system attached automatically; subject marked "ChessRiddle Studio"; inbox `feedback@chessriddle.com`; ChessRiddle privacy policy gets a Studio section in every language it is published in; the borrowed PostHog key is removed. No backend deployment is authorized by this order.

## Threat model and non-goals

* Studio is public GPL code. Anything it sends is untrusted: surface, platform, version and the optional email are hints, never authority. A modified client can claim any value.
* The anonymous endpoint is reachable by anyone on the internet. Adversary: scripted spam/abuse of the mailbox and of Mailjet quota, and use of the optional email field to make the mailbox send to or show arbitrary addresses. Defences: per-IP rate limits (stricter for anonymous), existing message length bounds, the email is used only as the `ReplyTo` of a message sent to our own fixed recipient (never as a recipient), validated as an email address.
* An authenticated caller's behaviour, receipts, and replay semantics must not change; an anonymous request must never read, replay or collide with an authenticated user's receipt, and vice versa.
* Bearer tokens never enter the Studio renderer (`.claude/rules/async-resource-invariants.md`). Studio's HTTP goes through the native side; the webview CSP and capabilities are not widened.
* Non-goals: the ChessRiddle account login in Studio (separate plan `tasks/handoffs/2026-11-06-chessriddle-integration-plan.md` in the Studio repo), screenshots/attachments from Studio, mobile app changes (Philipp's area; only scripted API-type regeneration is allowed), changes to the web FeedbackModal UI, a development-backend override in Studio, any deployment.

## Traced premises

* `backend/app/api/routes/feedback.py:28-80` — `POST /feedback`, `@limiter.limit("5/minute", key_func=get_user_or_ip)`, `Depends(setup_request_context)` (always authenticated, 401 otherwise, `backend/app/core/dependencies.py:196-235`); keyed path calls `submit_keyed_feedback(..., user_id, idempotency_key, reply_to=ctx.email_lower, metadata)`, unkeyed path sends then stores `FeedbackSubmission(user_id=..., **metadata)`.
* `backend/app/core/auth.py:321-348` — `get_current_user_optional` exists (returns `None` without/with unusable token), already used by `payments.py:246,326`, `arenas.py:106`.
* `backend/app/models/feedback.py:59-97` — `FeedbackReceipt` PK `(user_id, idempotency_key)`, `user_id` NOT NULL FK `users.id ON DELETE CASCADE`, unique `delivery_id`; migration `backend/alembic/versions/1d84e2c8ba65_add_feedback_delivery_receipts.py` (RLS on, service_role-only policy). `FeedbackSubmission` (`:120-139`) already has nullable `user_id`.
* `backend/app/repositories/feedback_receipt_repository.py` — claim/complete/release keyed by `(user_id, idempotency_key)`; request hash via `canonical_request_hash`.
* `backend/app/services/feedback_service.py:150-223` — subject `[ChessRiddle Feedback] {type_label}`; body lists user email (`Not available` when None), body `page_url`/`user_agent`, screenshot flag; `ReplyTo` only when an email is given; route metadata (surface, platform, app version) is not in the email.
* `backend/app/core/client_attribution.py:16-17,112-137` — allowed surfaces `{web, app}`, platforms `{web, ios, android}`; unknown values become `None`; `backend/tests/core/test_client_attribution.py:93` asserts `desktop`/`windows` → `None`. Consumers branching on surface: `puzzles/_helpers.py:211`, `client_release_gate.py:111`, `puzzle_client_compatibility.py:58-111,209-214`, plus many that only record the value.
* `backend/app/core/rate_limit.py:218-236,449-513,690-702` — SlowAPI limiter, `get_user_or_ip`, `get_ip_only`; a stacked second decorator exists (`payments_crypto.py:40-45`) with an exemption.
* `backend/app/infrastructure/sentry_reporting.py:113,445` — `/api/v1/feedback` is on the PII-scrubbed route list.
* `frontend/web/src/components/feedback/FeedbackModal.tsx:35,263-288` — web payload `feedback_type, message, page_url, user_agent, image_base64` with `Idempotency-Key`.
* Privacy policy: `frontend/web/src/app/[locale]/privacy/PrivacyEN.tsx:2949` ("In-app feedback form"), `PrivacyDE.tsx:3148`, `PrivacyES.tsx:3049` (only DE/EN/ES bodies exist; other locales show English); revision labels `frontend/web/src/lib/constants/legalDocuments.ts` (`PRIVACY_REVISION="2026-11-06"`), append-only hash history `legalDocumentRevisions.ts`, procedure `docs/context/LEGAL.md:39`.
* Production API base: `https://chessriddle.com/api/v1` (`frontend/mobile/lib/core/constants/api_constants.dart:13`, `nginx/chessriddle.conf:162`).
* Studio native HTTP: reqwest via `json_http_client` (`src-tauri/src/main.rs:488-507`, `src-tauri/src/infra/net.rs:43-77`: SafeResolver, no redirects, 10s connect, 30s total); typed `Error`/`ErrorPayload` with `RemoteHttpRejection` (`src-tauri/src/error.rs`); commands registered in `collect_commands!` (`main.rs:2091-2248`), bindings via `pnpm bindings:generate`; renderer consumes through `src/platform/tauri.ts` proxy and must have a production `tauri.<name>` consumer (`ipc:consumers:check`).
* Studio chrome: Help menu `src/routes/-appMenu.ts:164-185`, handlers and `AboutModal` in `src/routes/__root.tsx:250-356`; `AppModal` `src/components/common/AppModal.tsx`; notifications pattern `SaveToDatabaseModal.tsx`, `src/components/files/notifyError.ts`; error screen `src/components/ErrorComponent.tsx:8,49-51` (GitHub issue link).
* Studio telemetry: `src/platform/analytics.ts` (upstream author's key `phc_kgEB…`, introduced in upstream commit `2c686ae9`), used by `src/App.tsx:43,163-172` and `src/components/settings/SettingsPage.tsx:70,110-125,642-649`; `telemetryEnabledAtom` `src/state/atoms.ts:609-613` (default false); keys `Settings.Privacy.Telemetry(.Desc)` in 16 catalogues; `posthog-js` `package.json:128`; `e2e/security-consent.spec.ts:10,22`; CSP `src-tauri/tauri.conf.json:76` does not list PostHog.
* Studio i18n: 16 catalogues in `src/translation/`, `pnpm i18n:extract`, `pnpm i18n:check` (`docs/localization.md`).

## Approach

### A. Studio marker without new attribution values (ChessRiddle)

No change to `client_attribution.py` in this task; desktop surface/platform values and their consumer decisions stay with the integration plan's phase A. The feedback email recognises Studio feedback from the request body `user_agent` beginning with `ChessRiddle Studio/` (a display hint only; any client may claim it, per the threat model). When the integration plan adds a `desktop` surface, the marker switches to it.

### B. Optional-auth feedback endpoint (ChessRiddle)

* **Auth — fail closed:** a new feedback-route dependency returns an anonymous context only when the `Authorization` header is absent. When the header is present, it runs exactly the existing `setup_request_context` path, so an invalid, expired or unusable token still returns 401 (web/mobile session recovery keeps working). `get_current_user_optional` is not used, because it maps a present-but-unusable token to `None`. The anonymous context carries client attribution and the locale from `Accept-Language`, no user.
* **Authenticated behaviour unchanged:** reply-to from the account, receipts keyed by user, submission linked to user, 5/minute per user, `image_base64` allowed.
* **Contract:** `FeedbackRequest` gains optional `contact_email: EmailStr | None = None` (max 254); omitting the key stays valid. It is used as `ReplyTo` only for anonymous requests; authenticated requests ignore it. Anonymous requests that carry `image_base64` are rejected with 422 (no unauthenticated attachments). OpenAPI/generated API types are regenerated by the project script.
* **Stable idempotency digest:** the hashed request payload keeps exactly today's field set for every request that omits `contact_email` and for every authenticated request, so receipts created before the deploy replay unchanged; `contact_email` enters the digest only for anonymous requests that carry it.
* **Anonymous receipts — one table, null-safe uniqueness:** anonymous keyed requests reuse `feedback_receipts`. `user_id` becomes nullable and keeps `REFERENCES users(id) ON DELETE CASCADE` (account deletion still erases owned receipts; no owned row ever becomes ownerless). The composite primary key is replaced by `delivery_id` as primary key plus a unique constraint on `(user_id, idempotency_key)` with `NULLS NOT DISTINCT`, declared on the model and in the migration, so two concurrent anonymous first-claims for one key resolve to one row exactly like the authenticated race. No sentinel user, no new NOT NULL column without `server_default`; still-running old containers' inserts stay valid during the deploy window. RLS stays on with the existing service-role-only policy; the existing `cleanup-submission-receipts` pg_cron job already covers the table, so anonymous receipts follow the seven-day cleanup. Repository `claim`/`complete`/`release` accept `user_id: UUID | None`; fencing no longer relies on a non-null `user_id` coming back from `RETURNING`. The anonymous principal is never a `users` row and never appears in a data export.
* **Submission record:** anonymous `FeedbackSubmission` rows have `user_id = NULL` and the same metadata columns.
* **Rate limits:** authenticated stays `5/minute` keyed `get_user_or_ip` (requests with a present Authorization header, valid or not, keep only this limit; invalid ones then get 401 and send nothing). Requests without an Authorization header additionally get per-IP `3/minute` and `20/day`, as named constants, exempt when the header is present. While the rate-limit Redis is unavailable, anonymous feedback is refused with 503 instead of using per-worker memory — both when startup fell back to process-lifetime `memory://` storage outside development and when a request hits the per-request in-memory fallback after a Redis error (d-20260825-09); development's primary `memory://` storage stays allowed; authenticated behaviour under that fallback is unchanged. The decision is recorded as a supersession note for d-20260825-09's residual.
* **Email:** recipient stays the fixed `feedback@chessriddle.com`; `contact_email` is only ever `ReplyTo`, never `To`/`Cc`. Subject `[ChessRiddle Studio Feedback] <type>` when the Studio marker (A) matches, otherwise unchanged. The body shows the reply address or "Not provided"; existing escaping applies to every displayed field.
* **PII:** `contact_email` is scrubbed from Sentry events like the rest of the feedback body; not logged.

### C. Privacy policy (ChessRiddle web)

Extend the "In-app feedback form" section in `PrivacyEN.tsx`, `PrivacyDE.tsx`, `PrivacyES.tsx`: feedback is also possible from the ChessRiddle Studio desktop app and without an account; then it contains the message, feedback type, app version, operating system and an optional email address used only as reply address; the IP address is processed transiently for rate limiting; the anonymous retry receipt is not linked to an account and follows the same seven-day cleanup. Follow `docs/context/LEGAL.md` revision procedure (new privacy revision label and appended hash). A test asserts the Studio paragraph exists in all three bodies.

### D. Studio native feedback command (Studio)

* A native module sends the feedback: one Specta command taking feedback type, message, optional contact email and an idempotency key (UUID) from the renderer, returning `Result<FeedbackOutcome, Error>`. `FeedbackOutcome` is a Specta-exported enum with one variant per mapping row below (`Sent`, `InProgress`, `KeyMismatch`, `InvalidInput`, `RateLimited`, `DeliveryFailed`, `ServiceUnavailable`); only transport failures and local validation use `Err(Error)` with the existing categories. The renderer switches on the variant, never on `ErrorPayload` status.
* The API base `https://chessriddle.com/api/v1` is a compile-time constant in Rust; the renderer never supplies a URL. Request uses the existing `json_http_client` (SafeResolver, no redirects, timeouts). No `Authorization` header in this task; when the ChessRiddle login lands, the native side attaches its own token and the renderer contract stays the same.
* Headers: `X-Client-Surface: desktop`, `X-Client-Platform: linux|macos|windows`, `X-Client-App-Version: <app version>`, `Idempotency-Key`, `User-Agent: ChessRiddle Studio/<version> (<os>)`. Body: `feedback_type`, `message`, `contact_email` when given, `user_agent` = `ChessRiddle Studio/<version> (<os type> <os version>)`. (Surface/platform headers are dropped by today's backend allowlist and become useful once the integration plan adds them.)
* Validation before sending: message trimmed length 10–5000, email syntactically plausible when present.
* Outcome mapping is a closed set decided natively from status plus the server's `error.code`/`details.reason`, never from free text: 201 → sent; 409 `feedback_submission_in_progress` → in progress (renderer keeps the key, user may retry); 409 `idempotency_key_request_mismatch` → renderer mints a new key on the next submit; 422 → invalid input; 429 → rate limited; 400 (today's mapping of a Mailjet delivery failure) and 5xx/503 → delivery failed, try later; 401 (backend not yet deployed) → service unavailable, try later; transport errors → network. Default arm: any other status, and a 409 or error body without a parseable known reason (HTML, truncated JSON), → `DeliveryFailed`, which keeps the key. No native retry loop. Server message text and raw bodies never reach the renderer or the log.
* Request building and response mapping are pure functions with Rust unit tests asserting the URL constant, every header, no `Authorization`, the body shape, and each mapping row. Tests use target-independent expectations so Windows/macOS CI runs them unchanged.
* Decision record in `tasks/decisions.md`: native HTTP route, no CSP/capability widening.

### E. Studio feedback dialog and entry points (Studio)

* One `FeedbackModal` component on `AppModal`: type (bug, suggestion, praise, other), message textarea with length hint, optional email field with the note that it is only used to reply, a line saying app version and operating system are sent, and a link to `https://chessriddle.com/privacy`. Submit shows pending state; success closes with a success notification; errors show the mapped message and keep the input. The idempotency key is reused on retry of an unchanged payload and renewed when the payload changes or after a mismatch outcome.
* Entry points, each owning its own mounted instance: the Help menu item "Send feedback" on all three platforms (Help menu on macOS too, not the Application menu), handled in `__root.tsx` like About; and the error screen, where `ErrorComponent` renders its own `FeedbackModal` so it works when `RootLayout` has failed. The error screen offers "Send feedback" as the primary action and keeps the GitHub issue link (`felixabeck/chessriddle-studio`) as secondary. Known limit, unchanged: after a root crash the native Help menu still points at the unmounted root handler (same as About today); the error-screen button is the working entry.
* All strings through i18next in all 16 catalogues; `pnpm i18n:extract` and `pnpm i18n:check` green.

### F. Remove borrowed telemetry (Studio)

Delete `src/platform/analytics.ts`, the `posthog-js` dependency, `telemetryEnabledAtom`, the Settings privacy telemetry switch and its translation keys, the startup `app_started` capture, and adjust `App.test.tsx` and `e2e/security-consent.spec.ts` (and its snapshots). Retire stale storage the same way `localStorage.removeItem("document-dir")` is retired in `src/state/atoms.ts`: remove `telemetry-enabled`, the PostHog persistence key `ph_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z_posthog` and the PostHog consent key `__ph_opt_in_out_phc_kgEBtifs0EgWlrl4ROYEbnsQ1b7BS2W5BKLNyXe7f8z`. Decision record in `tasks/decisions.md` (reason: key belongs to the upstream author's PostHog project, traffic was blocked by CSP, nothing of Felix's receives it; reversal: reintroduce with a ChessRiddle-owned project, privacy text and CSP decision).

## Decisions and trade-offs

Decided autonomously (full auto), recorded in each repo's `tasks/decisions.md`:

* One endpoint with optional auth instead of a second anonymous endpoint (rejected: two contracts for one domain concept, rule 11).
* Invalid token → 401, not anonymous fallback (rejected alternative: silent downgrade hides broken sessions and makes the reply address disappear).
* Anonymous limits 3/minute and 20/day per IP (rejected: 5/minute only — too loose for an unauthenticated mail-sending endpoint; 1/day — blocks real users on shared IPs).
* Native HTTP from Rust, no CSP change (rejected: webview fetch + CSP widening; contradicts the integration plan's threat model and token rule).
* Mailjet delivery failure stays the existing 400 response (Studio maps it to "delivery failed"); changing it to 5xx would change web behaviour outside this mandate.
* No screenshot upload from Studio in this task (rejected for now: larger payload and capture plumbing; reversal: add `image_base64` later, contract already supports it).
* Telemetry removed entirely rather than left as a no-op toggle (rejected: a visible switch that does nothing misleads users).
* Studio marker from the body `user_agent` prefix instead of adding `desktop` to the attribution allowlist now (rejected: allowlist change forces consumer decisions that belong to the integration plan; reversal: switch the marker to the surface when that plan lands).
* Anonymous receipts in the existing table with `NULLS NOT DISTINCT` uniqueness (rejected: a second table needs its own cron cleanup and RLS; a sentinel user breaks account semantics).
* Anonymous feedback fails closed (503) while rate-limit Redis is down (rejected: per-worker memory fallback multiplies the anonymous cap on an unauthenticated mail path).
* Anonymous `image_base64` rejected (rejected: allow — unauthenticated 5 MB attachments to the mailbox).

## Risks / open questions

* Studio feedback works only after the backend change is deployed; until then anonymous Studio requests get 401 and the dialog shows the mapped "service unavailable, try later" message. Deployment is not authorized; report the needed deploy.
* Privacy revision bump may trigger the existing re-acceptance flow for logged-in users per `LEGAL.md`; that is the established procedure for any text change.

## Not part of this task

ChessRiddle login in Studio; screenshots from Studio; mobile UI; web FeedbackModal changes; any deploy; desktop surface/platform attribution values and desktop-specific puzzle compatibility; the native menu's stale root handler after a crash.

## Phases

ChessRiddle phases B1→B2 run sequentially in the ChessRiddle worktree. Studio phases S1→S2 run sequentially in the Studio worktree (S1 and S2 both touch `src/translation/*.json`; S2 starts after S1 is committed). The two sequences are file-disjoint and run in parallel; S2 depends only on the contract in B (frozen here), not on B's code.

### Phase B1 — optional-auth feedback (A, B)
Files: `backend/app/api/routes/feedback.py`, `backend/app/core/dependencies.py` (new dependency), `backend/app/schemas/feedback.py`, `backend/app/services/feedback_service.py`, `backend/app/repositories/feedback_receipt_repository.py`, `backend/app/models/feedback.py`, `backend/app/core/rate_limit.py` (constants and the Redis-down check if needed), new Alembic revision parented on the current `alembic heads`, RLS/FK drift baselines if they change, `backend/app/infrastructure/sentry_reporting.py` / `backend/app/core/sentry_config.py` if scrubbing needs it, tests under `backend/tests/**` (endpoints incl. invalid-token 401 and anonymous success, schema omit-valid, digest stability for a pre-change receipt, Mailjet payload To/ReplyTo for both principals, anonymous image rejection, anonymous rate limits and the authenticated exemption, Redis-down anonymous 503, service subject marker, idempotency integration including the concurrent first-insert race in the anonymous namespace, account-deletion cascade, retention, export, sentry), regenerated `backend/openapi.json`, `frontend/web/src/types/api.generated*.ts`, `frontend/mobile/lib/core/api/generated/api_types.dart` via the project script; `tasks/decisions.md` via `./scripts/findings.py record-decision`. Role: sensitive.
PROOF COMMAND: `(cd backend && uv run alembic heads) && (cd backend && uv run python ../scripts/run_backend_tests_postgres.py --migrate-and-guards) && (cd backend && uv run python ../scripts/run_backend_tests_postgres.py -- tests/integration/test_feedback_idempotency.py tests/integration/test_account_deletion_cascade.py -q) && bash scripts/affected-tests.sh --changed-path backend/app/api/routes/feedback.py --changed-path backend/app/core/dependencies.py --changed-path backend/app/repositories/feedback_receipt_repository.py --changed-path backend/app/services/feedback_service.py --changed-path backend/app/models/feedback.py --changed-path backend/app/schemas/feedback.py --changed-path backend/app/core/rate_limit.py && python scripts/gate_receipt.py ensure api-types`

### Phase B2 — privacy policy (C)
Files: `frontend/web/src/app/[locale]/privacy/Privacy{EN,DE,ES}.tsx`, `frontend/web/src/lib/constants/legalDocuments.ts`, `frontend/web/src/lib/constants/legalDocumentRevisions.ts`, related tests including the three-language Studio paragraph assertion. Role: sensitive (legal).
PROOF COMMAND: `cd frontend/web && npx vitest related --run src/lib/constants/legalDocuments.ts src/lib/constants/legalDocumentRevisions.ts 'src/app/[locale]/privacy/PrivacyEN.tsx' 'src/app/[locale]/privacy/PrivacyDE.tsx' 'src/app/[locale]/privacy/PrivacyES.tsx'`

### Phase S1 — remove telemetry (F)
Files: `src/platform/analytics.ts` (delete), `src/App.tsx`, `src/App.test.tsx`, `src/components/settings/SettingsPage.tsx`, `src/state/atoms.ts`, `src/translation/*.json`, `package.json`, `pnpm-lock.yaml`, `e2e/security-consent.spec.ts` and its snapshots, `tasks/decisions.md` via `./scripts/findings.py record-decision`. Role: normal.
PROOF COMMAND: `pnpm exec tsgo --noEmit && pnpm i18n:check && pnpm exec vitest related --run src/App.tsx src/components/settings/SettingsPage.tsx src/state/atoms.ts && pnpm test:e2e:container --project=security-consent` (if the removed switch changes the committed screenshot, regenerate only that project's snapshot with `pnpm test:e2e:update --project=security-consent`, never a host-native snapshot)

### Phase S2 — native feedback command, dialog and entry points (D, E)
Files: new `src-tauri/src/feedback.rs`, `src-tauri/src/main.rs` (module + `collect_commands!`), `src-tauri/src/error.rs` only if needed, `src/bindings/generated.ts` (generated), new `src/components/feedback/FeedbackModal.tsx` (+ test), `src/routes/-appMenu.ts` (+ test for both `isMacOS` trees), `src/routes/__root.tsx` (+ root test that the Help-menu feedback action opens the dialog), `src/platform/errors.ts` only if needed, `src/components/ErrorComponent.tsx` (+ test that "Send feedback" opens the dialog with no `RootLayout` mounted), `src/translation/*.json`, `tasks/decisions.md` via `./scripts/findings.py record-decision`. Role: normal.
PROOF COMMAND: `pnpm bindings:check && PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- feedback:: && pnpm rust:windows:check && pnpm exec tsgo --noEmit && pnpm i18n:check && pnpm gates:contract:check && pnpm exec vitest related --run src/components/feedback/FeedbackModal.tsx src/components/ErrorComponent.tsx src/routes/-appMenu.ts src/routes/__root.tsx`

## Reviews

### Round 1 (plan-r1) — 15 Grok lenses (xai.low; review-plan at its role effort)
Verdicts: plan REVISE, minimalism APPROVED, correctness REVISE, error-handling REVISE, tests REVISE, ipc-contract REVISE, persisted-state APPROVED, tauri-security APPROVED (no findings), platform-semantics APPROVED, api-contract REVISE, concurrency REVISE, integration REVISE, migration REVISE, security APPROVED, react-lifecycle REVISE. Raw reports: `$RUN_TMP/lens-<lens>-r1.txt`.

| ID | Claim | Witnesses (lens#ordinal) | Disposition | Correction / reason |
|---|---|---|---|---|
| I-1 | Anonymous receipts have no storable, race-safe identity (NOT NULL PK/FK; NULL-distinct unique; `complete()` RETURNING user_id) | plan#1, concurrency#1, correctness#2, migration#1, integration#1, security#5 | Fix | B "Anonymous receipts": nullable `user_id` keeping CASCADE, `delivery_id` PK, `UNIQUE (user_id, idempotency_key) NULLS NOT DISTINCT`, fencing not on returned user_id, no sentinel user. Verified `postgresql_nulls_not_distinct` already used (`backend/app/models/puzzle.py:1095`). |
| I-2 | Adding `contact_email` changes the keyed digest and breaks in-window retries | plan#2, api-contract#1, correctness#1, error-handling#1, integration#2 | Fix | B "Stable idempotency digest". |
| I-3 | S2 command has no production consumer until S3 (`ipc:consumers:check`) | plan#3, ipc-contract#2 | Fix | S2+S3 merged into Phase S2 with `pnpm gates:contract:check`. |
| I-4 | B2 proof skips integration tests and `--migrate-and-guards` | plan#4, migration#4, tests#1, tests#2, concurrency#2 | Fix | Phase B1 proof adds `alembic heads`, `--migrate-and-guards`, integration files; race test in anonymous namespace named. |
| I-5 | `get_current_user_optional` maps invalid token to anonymous | plan#5, api-contract#2, error-handling#2, integration#3, security#1 | Fix | B "Auth — fail closed": new dependency, header-absent only. Verified `backend/app/core/auth.py:339-347`. |
| I-6 | Privacy proof does not prove DE/ES | plan#6 | Fix | C: three-language assertion; B2 proof names all three. |
| I-7 | S1/S3 both edit translations | plan#7 | Fix | Phases note sequential order. |
| I-8 | 409 handling must switch on reason (in-progress vs mismatch) and 401/429 categories | api-contract#3, error-handling#5, ipc-contract#1 | Fix | D outcome mapping (closed set from status + code/reason). |
| I-9 | Anonymous IP limits would also hit authenticated callers | api-contract#4, security#2 | Fix | B "Rate limits": exempt when Authorization present. |
| I-10 | `contact_email` must default to None (omit-valid) | api-contract#5 | Fix | B "Contract". |
| I-11 | Redis-down in-memory fallback multiplies anonymous caps | error-handling#3, integration#4, security#4 | Fix | B "Rate limits": anonymous 503 while limiter Redis is down; d-20260825-09 supersession note. |
| I-12 | Mailjet failure arrives as 400 validation_error, not 422/5xx | error-handling#4 | Fix | D mapping: 400 → delivery failed. Backend status unchanged (decision recorded; web behaviour outside mandate). Verified `backend/app/api/routes/feedback.py:84-85`, `backend/app/core/errors.py:417-424`. |
| I-13 | No test proves anonymous limits | tests#3 | Fix | B1 test list. |
| I-14 | B1 proof misses `test_client_release_gate.py` | tests#4 | Fix | Obsolete: attribution change removed (I-19). |
| I-15 | S1 proof skips the telemetry e2e spec | tests#5 | Fix | S1 proof adds `pnpm test:e2e --project security-consent`. |
| I-16 | S2 proof does not assert URL/headers/no-Authorization/mapping | tests#6 | Fix | D: pure request/response functions with unit tests. |
| I-17 | Error screen cannot open a modal owned by the failed `RootLayout`; proof misses `__root.tsx` | correctness#3, react-lifecycle#1, react-lifecycle#2, tests#7 | Fix | E: `ErrorComponent` owns its own instance; test with no `RootLayout`; proof includes `__root.tsx`. |
| I-18 | Native menu closures target unmounted root after crash | react-lifecycle#3 | Skip | Pre-existing for About, unchanged by this task, reachable only after a root crash where the error-screen button works; stated as known limit in E. Below rule 4d bar for filing. |
| I-19 | Attribution allowlist change belongs to the integration plan | minimalism#1 | Fix | A rewritten: Studio marker from body `user_agent`; B1 phase dropped. |
| I-20 | Removed telemetry leaves `telemetry-enabled` and PostHog persistence keys | persisted-state#1, persisted-state#2 | Fix | F: removeItem for both keys next to `document-dir` retirement. |
| I-21 | Platform values need Windows/macOS proof | platform-semantics#1 (nit) | Fix | S2 proof adds `pnpm rust:windows:check`; target-independent tests. |
| I-22 | macOS Help placement | platform-semantics#2 (nit) | Fix | E: Help menu on all three. |
| I-23 | Anonymous `image_base64` opens unauthenticated attachments | security#3 | Fix | B "Contract": anonymous image → 422. |
| I-24 | Mailjet payload To/ReplyTo not pinned | security#6 (nit) | Fix | B "Email" + B1 tests. |
| I-25 | A second receipt table would escape the cron cleanup | migration#2 | Fix | Single-table choice keeps the existing job (B). |
| I-26 | Receipts must keep ON DELETE CASCADE | migration#3 | Fix | B "Anonymous receipts". |

### Round 2 (plan-r2) — 14 Grok lenses
Five lens leaves were first launched with prompts missing the lens body (an unexpanded `~`); they were terminated before completing and relaunched under the same names with correct prompts; the malformed artefacts are kept in `$RUN_TMP/malformed-r2/` and are not evidence.
Verdicts: plan APPROVED, minimalism APPROVED, correctness APPROVED, error-handling APPROVED, tests REVISE, ipc-contract REVISE, persisted-state APPROVED, platform-semantics APPROVED, api-contract APPROVED, concurrency APPROVED, integration APPROVED, migration APPROVED, security APPROVED, react-lifecycle APPROVED.
Closed in round 2 by their witnesses: I-1, I-2, I-3, I-4, I-5, I-6, I-7, I-9, I-10, I-12, I-13, I-14, I-16, I-19, I-21, I-22, I-23, I-24, I-25, I-26 (all witnesses CLOSED, review-plan APPROVED). I-18 Skip unchanged.

| ID | Claim | Witnesses | Disposition | Correction |
|---|---|---|---|---|
| I-8 (NOT CLOSED) | The two 409 outcomes collapse into one `RemoteHttpRejection` payload; renderer type unnamed | ipc-contract r2#1-2 | Fix | D: `Result<FeedbackOutcome, Error>` with a Specta enum per mapping row; renderer switches on the variant. |
| I-29 (lineage I-8) | No default arm for unknown status / unparseable 409 body | error-handling r2#1 | Fix | D: default arm → `DeliveryFailed`, keeps the key; raw bodies never forwarded or logged. |
| I-15 (NOT CLOSED) | S1 e2e leg uses host-native runner; screenshot spec only valid in container | plan r2#1, tests r2#1, tests r2#3 | Fix | S1 proof: `pnpm test:e2e:container --project=security-consent`, snapshot update only via the container update command. Verified `package.json:78-80`. |
| I-28 (lineage I-17) | Nothing proves `__root.tsx` wires the Help feedback action | tests r2#2 | Fix | S2 Files: root test that the Help-menu action opens the dialog. |
| I-30 (lineage I-20) | PostHog consent key `__ph_opt_in_out_<token>` also left behind | persisted-state r2#1 | Fix | F: remove that key too. |
| I-31 (lineage I-11) | Anonymous 503 must cover both Redis-down stores (startup `memory://` and per-request fallback) | security r2#1 | Fix | B "Rate limits": both triggers named; development `memory://` allowed. |
| I-32 | Risks wording on pre-deploy 401 contradicts D | correctness r2#1 (nit), integration r2 late#1 (nit) | Fix | Risks text aligned; nit-only witnesses, closed by arbiter. |


### Round 3 (plan-r3) — 6 Grok closure lenses
Verdicts: plan APPROVED, tests APPROVED, ipc-contract APPROVED, error-handling APPROVED, persisted-state APPROVED, security APPROVED. Closed: I-8, I-15, I-28, I-29, I-30, I-31 (every witness and review-plan CLOSED). I-32 closed by arbiter (nit-only). No open plan issues. Adoptions per round: r1=25 r2=6 r3=0.

## Implementation and diff review — ChessRiddle Studio

Phases (Grok write leaves, xai.low via leaf.grok.*.*): S1 `f5e22519` (telemetry removal), S2 `313aa459` (native command, dialog, entry points). Decisions: Studio `d-20261106-06`. Finding filed: `f-20261106-13` (Settings Board tab selects lack accessible names, observed by the S1 leaf).

Diff review round 1 over `merge-base..313aa459` (9 Grok code lenses + 1 records lens; same family as the authoring leaves, no family separation): correctness, root-cause, error-handling, ipc-contract, tauri-security APPROVED with no findings; code-quality (4 should-fix, 1 nit), minimalism (3 nits), persisted-state (1), tests (5 should-fix, 2 nits) APPROVED with findings; records REVISE (f-20261106-11 facts disputed, f-20261106-13 location and SHA). Dispositions: every finding ≥80 Fix, except Skip for the browser e2e of the dialog (both entry points are a native menu and an error boundary that the mocked browser harness cannot reach; real-app verification covers them). Records: annotations on f-20261106-13 (correction) and f-20261106-11 (dispute, unverified, belongs to another session). Repair `bda8f0cf`.
Closure round 2 (`313aa459..bda8f0cf`): all round-1 items CLOSED; 7 new findings (tests 5, persisted-state cookie domain 1, code-quality nit 1), all Fix; repair `test(feedback): cover the whole native send path and every cookie scope`.
Closure round 3: all CLOSED; 2 new (tests truncated-body read, code-quality nit), Fix; repair `test(feedback): prove a truncated response body is a network error`.
Closure round 4: correctness, tests, code-quality APPROVED, no findings. diff_adopted_per_round: r1=14 r2=7 r3=2 r4=0.
Verification: Grok verify-ui leaf drove the real release binary through `scripts/app-driver.mjs` (WebKitGTK): Settings without Privacy tab, error screen with Send feedback primary, dialog layout and 10-character gate; VERDICT PASS, screenshots inspected by the orchestrator. Native GTK Help menu not verifiable by WebDriver.

### Studio final-gate repair (2026-11-06)
First gate run exited 76 (origin/master moved: icon crop and a build-ledger row); rebased, `git range-diff` showed every commit `=`, review carried. Second run: `e2e-container` red, 119 failed. Bisect on a probe worktree: S1 alone moves only the Settings snapshot (Privacy tab removed); S2 restyled tabs and buttons because the eager `FeedbackModal` import changed Vite chunking and moved the Mantine theme CSS modules before Mantine's core styles. Filed `f-20261106-30` (entry build) for the order-dependent cascade. Repair: lazy-load the dialog through one shared `LazyFeedbackModal`, re-record `settings-appearance-dark-engine-gap.png` (diff only the missing Privacy tab), and move the German Settings navigation loop from the removed Privacy tab to Sound. Full container suite after repair: 353 passed. Closure rounds: g1 (correctness, tests APPROVED; code-quality 3 should-fix + 2 nits, all Fix), g2 (code-quality 1, tests 1, Fix), g3 (tests 1, Fix by the orchestrator as a one-line overlap, measured red with the early return removed), g4 correctness and tests APPROVED with no findings.
