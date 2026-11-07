# Review record: screenshot attachment in Studio feedback (2026-11-07)

Build run studio-feedback-screenshot, Claude Code (Opus 5.5) orchestrator, Grok executor (leaves and lenses), full auto from Felix's "Do this full auto from here on" after plan approval. Two repositories: this one (Studio) and chess-tactics-app (backend, privacy); the backend half has its own record in that repository's build ledger. Separation: Claude orchestrator with Grok leaves and Grok lenses — no family separation between code author and reviewer (both Grok); plan authorship and arbitration shared one Claude context.

Mandate: Felix, 2026-11-07, asked why Studio's feedback has no screenshot option although ChessRiddle has one, and chose "Build it now (Recommended)". Decisions: d-20261107-05 (supersedes the screenshot clause of d-20261106-06), chess-tactics-app d-20261107-14 (recorded as d-20261107-08 before the rebase; that ID was taken upstream).

## Plan (final reviewed revision)

# Plan: Screenshot attachment in ChessRiddle Studio feedback

## Goal
Studio's feedback dialog can attach one image, either a capture of the app page or a picked image file, and sends it to the ChessRiddle feedback API, which accepts it from callers without an account.

## MANDATE
Felix, 2026-11-07: "Why is there no option to add a screenshot? A screenshot is, I think, very valuable for me to understand the problem. So why didn't you include this? Chess Riddle has it as well. And so it's obvious to include this here as well, isn't it?"

Felix then chose "Build it now (Recommended)", whose option text was: "Studio gets ChessRiddle's screenshot button: capture the window or upload an image. The server also accepts screenshots without an account, under the existing per-address limits (3 a minute, 20 a day) and the 10 MB cap. The privacy policy gets updated in every language. It all goes out in the backend deploy that's already waiting for your go."

## Threat model and non-goals
* Input adversary: an anonymous client posting to `POST /api/v1/feedback` with an arbitrary `image_base64`. It is already bounded by the schema cap (10 MiB encoded), the service decode check (PNG/JPEG/WebP/GIF data URL, 5 MiB decoded), nginx's global 10m body cap and the anonymous per-IP limits (3/min, 20/day) plus 503 when the Redis limiter is down. No new rate or size limit is introduced; the change removes the anonymous 422 and adds a content-signature check (A2), so an anonymous caller cannot attach arbitrary bytes under an image name.
* The renderer is untrusted relative to the native command: the native side validates the image (data-URL prefix and MIME allow-list, base64 decodability, decoded size, and a content signature matching the declared format) before sending, so a renderer payload the backend would reject for its content never leaves the process; a backend 400 for an image therefore means the two checks disagree and stays `DeliveryFailed`.
* Environments: Studio on Linux (WebKitGTK), macOS (WKWebView), Windows (WebView2). Capture must work in WebKitGTK, the engine Felix uses.
* Non-goals: ChessRiddle login in Studio; native OS-level window capture (GTK menu bar and decorations are not in the image); drag-and-drop onto the dialog; changes to the web FeedbackModal; any deploy.

## Traced premises
* Backend anonymous image rejection: `chess-tactics-app/backend/app/api/routes/feedback.py:73-80` (`if user is None: if feedback.image_base64: raise APIError(422 … "Screenshots are not accepted without an account.")`).
* Backend image validation: `backend/app/services/feedback_service.py:26-27` (`MAX_IMAGE_SIZE_BYTES = 5 MiB`, `MAX_BASE64_LENGTH = 10 MiB`), `:147-188` (`_validate_image`, regex `^data:(image/(?:png|jpeg|jpg|webp|gif));base64,(.+)$`), Mailjet attachment `:276-286`.
* Schema cap: `backend/app/schemas/feedback.py:14,67-73`.
* Idempotency digest already includes `image_base64`: `feedback_service.py:37-43,52-67`.
* Backend test asserting the rejection: `backend/tests/api/test_feedback_endpoints.py:166` (`test_anonymous_feedback_rejects_image`).
* Privacy texts stating "We do not accept attachments without an account": `frontend/web/src/app/[locale]/privacy/PrivacyEN.tsx:~2996`, and the matching passages in `PrivacyDE.tsx` and `PrivacyES.tsx`; disclosure test `privacyDisclosures.test.ts`, `PrivacyES.test.tsx`.
* chess-tactics-app decision recording the 422: `tasks/decisions.md:~27675` ("Anonymous requests … may not carry `image_base64` (422)").
* nginx: `nginx/nginx.conf:16` `client_max_body_size 10m` (global), `/api/` location in `nginx/chessriddle.conf`.
* Web capture reference: `frontend/web/src/components/feedback/FeedbackModal.tsx:135-182` (`html-to-image` `toPng(document.body, {pixelRatio: min(dpr,2), cacheBust, skipFonts, filter excludes role=presentation/dialog and the toaster})`), file reading `frontend/web/src/lib/imageFile.ts` (PNG/JPEG/WebP, 5 MiB).
* Studio native command: `chessfable/src-tauri/src/feedback.rs` — `FeedbackRequestBody` (no image field), `build_feedback_request`, `submit_feedback(feedback_type, message, contact_email, idempotency_key, state)`, `submit_feedback_request` posting via `state.json_http_client`.
* Studio JSON client total timeout 30 s: `src-tauri/src/infra/net.rs:60-62`.
* Studio dialog: `src/components/feedback/FeedbackModal.tsx` (fingerprint `payloadFingerprint(type,message,email)`, `tauri.submitFeedback(...)`, Mantine `AppModal`), tests `FeedbackModal.test.tsx`; `src/platform/tauri.ts` facade; bindings `src/bindings/generated.ts` (generated).
* Studio CSP: `src-tauri/tauri.conf.json:76` — `img-src 'self' data: …`, `connect-src 'self' ipc: …` (no `blob:`).
* Studio locales: 16 catalogues in `src/translation/*.json`; `pnpm i18n:check` requires a non-empty value in every catalogue (`docs/localization.md`).
* chessfable decision d-20261106-06 ("No screenshot upload in this version").
* Studio has no `html-to-image` dependency; web pins `html-to-image` `1.11.13`.

## Approach

### A. Backend accepts anonymous images
Remove the anonymous `image_base64` 422 branch only. Schema cap, rate limits, the limiter-down 503, the idempotency digest and the Mailjet attachment stay. The route docstring stops saying "(authenticated callers only)", and the committed OpenAPI artefacts that copy it are regenerated with the project's generators (`backend/scripts/dump_openapi.py`, `frontend/web` `generate:api-types`, and the mobile API-type generator the `mobile-api-types` gate runs), never hand-edited.
Acceptance: an anonymous request with a valid PNG returns 201 and the mail send carries the attachment; an anonymous invalid image fails through the existing service validation with **400 `VALIDATION_ERROR`** (unchanged status, same as authenticated); an anonymous image request while the limiter is down returns 503 and sends nothing; an anonymous keyed retry with the same image replays and a different image under the same key is a key mismatch.

### A2. Backend checks image content, not only the declared type
`_validate_image` additionally requires the decoded bytes to start with the signature of an allowed format (PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, GIF `GIF87a`/`GIF89a`, WebP `RIFF????WEBP`) and the signature to match the declared MIME (`jpg` = `jpeg`); a mismatch is the existing 400 `VALIDATION_ERROR`. This applies to every caller. Existing tests that post non-image bytes under an image data URL (zero-filled PNGs, and `b"different image"` in `test_feedback_idempotency.py` for the 409 key-mismatch case) are updated to bytes with a real signature wherever they test something other than the signature.

### B. Privacy texts in every supported language
EN, DE and ES passages about Studio feedback replace "We do not accept attachments without an account" with: an optional screenshot or image may be attached with or without an account and is sent in the feedback email (same Mailjet route and retention as web feedback). Update the disclosure tests that pin the old sentence. Copy follows universal rule 30a; German uses ä/ö/ü/ß.

### C. Studio native command carries the image
`submit_feedback` gains an optional `image: Option<String>` (data URL). Native validation before any network call: prefix `data:image/(png|jpeg|webp);base64,`, base64 decodes, decoded bytes ≤ 5 MiB (mirror of backend `MAX_IMAGE_SIZE_BYTES`) and start with the signature of the declared format. Image validation failure returns a new outcome `FeedbackOutcome::InvalidImage` (not the message/email `InvalidInput`), which the dialog shows as image-specific copy. The body serializes `image_base64` only when present.
Timeouts: `native_json_http_client` has a 30 s `read_timeout` that reqwest 0.12.5 starts at dispatch and that `RequestBuilder::timeout` cannot override (verified `reqwest-0.12.5/src/async_impl/client.rs:2068-2077,2542-2548`). A request carrying an image therefore goes through an upload client built with `safe_http_client` (same resolver and redirect policy) whose connect timeout is 10 s and whose read and total timeouts are 120 s, as named constants in `src-tauri/src/infra/net.rs`; a request without an image keeps `json_http_client`. The selection lives inside the shared send function (`submit_feedback_request`), which receives both clients; the `submit_feedback` command passes `state.json_http_client` and the upload client and contains no selection of its own. Proof: a loopback test calls `submit_feedback_request` with two plain test clients (`reqwest::Client::builder().no_proxy()`, because `safe_http_client`'s `SafeResolver` refuses 127.0.0.1): the JSON client with a short read timeout and the upload client without one, against a server that delays its response headers past the short timeout. The image request must return `Sent` and the text-only request must time out; routing the image through the JSON client turns the test red. A separate test pins the production upload constants (read and total 120 s, connect 10 s) and that the upload client is built through `safe_http_client`.
No new outcome for 413: it stays `DeliveryFailed`, because the 5 MiB decoded check keeps the body (≈6.7 MiB base64) under nginx's 10m. Bindings regenerated with `pnpm bindings:generate`; `src/platform/tauri.ts` is a Proxy over the generated `commands` and needs no edit (no hand-written invoke may be added); the existing dialog call passes `null` in the same phase so the tree type-checks, and its test matchers are updated to the five-argument call.

### D. Studio dialog attachment UI
Below the email field, labelled "Attach image (optional)" like web: two buttons, "Take screenshot" and "Choose image", and, once an image is attached, a thumbnail preview with a remove control. One attachment at a time; a new one replaces the old.
* Capture uses `html-to-image` pinned exactly to `1.11.13`, imported dynamically inside the capture handler. It captures `document.body`, excluding the feedback modal (`role="dialog"`/`role="presentation"`) and the notifications container, with `pixelRatio: min(devicePixelRatio, 2)`, `cacheBust: true`, `skipFonts: true` as on web.
* Size: if the PNG's decoded size exceeds 5 MiB, capture once more as PNG at `pixelRatio: 1`; if still over, show the same "too large" message as the file picker and attach nothing.
* File pick uses Mantine `FileButton` accepting `image/png,image/jpeg,image/webp`; wrong type and over 5 MiB get specific messages; read via `FileReader.readAsDataURL`.
* Failure copy: capture failure (import error, `toPng` throw) shows "Screenshot failed"; file read error/abort shows "Could not read the image"; `InvalidImage` shows "The image could not be sent. Remove it or choose another one." No unhandled rejection, no silent no-op.
* Async discipline (async-resource rule): capture and file read carry a generation token; closing/resetting the dialog, removing the image, a newer attachment, or a successful send invalidates older results; nothing sets state after unmount. `submit()` refuses and Send is disabled while a capture or file read is in flight; attachment buttons are disabled while sending.
* Idempotency: the payload fingerprint includes an attachment identity (bumped on every attachment change), so changing or removing the image after a failed send mints a new key.
* All new strings through i18next with values in all 16 catalogues; no hard-coded JSX or aria-label text (`pnpm i18n:jsx`).
* `DESIGN.md`: `Camera` is already catalogued (`DESIGN.md:151`); add rows only for icons not yet listed.

### E. Decisions superseded
chessfable: record a decision superseding the "No screenshot upload in this version" clause of d-20261106-06. chess-tactics-app: record a decision superseding the anonymous-image 422 clause of d-20261106-11 and recording the signature check. Both cite Felix's 2026-11-07 choice.

### F. Verification
* Backend: pytest for every acceptance case in A and A2 (including 503 with image and signature mismatch); privacy disclosure tests; OpenAPI gates (`python scripts/gate_receipt.py ensure api-types`, `mobile-api-types`).
* Studio native: Rust tests for image validation (accepted formats, rejected MIME, bad base64, over-size, signature mismatch, absent), `InvalidImage` outcome, body serialization with/without `image_base64`, and the upload-timeout selection (fails if the image path used the JSON client policy).
* Studio renderer: vitest for capture success (mocked `html-to-image`), capture failure copy, pixelRatio-1 retry, too-large, file type/size rejection, read-failure copy, remove, stale capture/read after close/remove/send ignored, during an in-flight capture and during an in-flight file read, neither clicking Send nor submitting the form (Enter in a field) invokes `tauri.submitFeedback` (`submit()` itself refuses, not only the button), fingerprint change mints a new key, image passed to `tauri.submitFeedback`, `InvalidImage` copy.
* Real product: a new feedback scenario in `scripts/verify-app.mjs` opens the dialog in the release binary under WebKitGTK, clicks "Take screenshot", and asserts the preview's PNG decodes with width and height > 0 and more than one distinct colour; it fails on a blank or single-colour capture. Run with `pnpm verify:app` after `pnpm build`. The dialog with preview is screenshotted.
* e2e container suite: any snapshot showing the feedback dialog moves only inside the dialog.

## Decisions and trade-offs
* DOM capture (html-to-image) instead of native OS window capture: native capture on Wayland needs the portal and a user prompt; the web app uses DOM capture; the page content is what a bug report needs. The GTK menu bar is not in the image.
* No drag-and-drop in Studio (desktop file drop in Tauri goes through the native drag-drop event, not DOM `dataTransfer.files`); the file picker covers attaching an existing image.
* GIF not offered (web offers PNG/JPEG/WebP; backend also accepts GIF).

## Risks / open questions
* html-to-image in WebKitGTK: canvas taint or blank output on SVG `foreignObject`. Locate probe 2026-11-07 (Playwright WebKit 2359, `html-to-image` 1.11.13, pixelRatio 2): output 2560×800 PNG, red SVG circle and gradient pixels correct, `role="dialog"` element excluded. The Phase 4 real-product scenario decides for WebKitGTK; a failure is reported, not shipped.
* Studio release before the backend deploy: anonymous feedback is unavailable in production until the pending deploy anyway, so no window exists where text works but images fail.

## Not part of this task
Deploy; Studio login; web modal changes; GIF; drag-and-drop; native window capture.

## Phases

### Phase 1 — chess-tactics-app backend, privacy, OpenAPI (repo `/home/felixb/Projekte/chess-tactics-app.worktrees/anon-feedback-screenshot`)
Files: `backend/app/api/routes/feedback.py`, `backend/app/services/feedback_service.py`, `backend/tests/api/test_feedback_endpoints.py`, `backend/tests/services/test_feedback_service.py`, `backend/tests/integration/test_feedback_idempotency.py`, `backend/openapi.json`, `frontend/web/src/types/api.generated.ts`, the mobile generated API types the `mobile-api-types` gate owns, `frontend/web/src/app/[locale]/privacy/Privacy{EN,DE,ES}.tsx` and their tests. Approach A, A2, B. Role normal. Executor Grok.
PROOF COMMAND: `cd backend && uv run pytest tests/api/test_feedback_endpoints.py tests/integration/test_feedback_idempotency.py tests/services/test_feedback_service.py -q`, `cd frontend/web && pnpm vitest run "src/app/[locale]/privacy"`, `python scripts/gate_receipt.py ensure api-types`, `python scripts/gate_receipt.py ensure mobile-api-types`.

### Phase 2 — Studio native command and upload client (repo `/home/felixb/Projekte/chessfable.worktrees/studio-feedback-screenshot`)
Files: `src-tauri/src/feedback.rs`, `src-tauri/src/infra/net.rs`, `src-tauri/src/main.rs` (only if state wiring is needed), `src/bindings/generated.ts` (regenerated), `src/components/feedback/FeedbackModal.tsx` (call site passes `null`; `InvalidImage` outcome copy key), `src/components/feedback/FeedbackModal.test.tsx` (five-argument matchers), `src/translation/*.json` for that one key. Approach C. Role sensitive.
PROOF COMMAND: `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml feedback`, `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml infra::net`, `pnpm bindings:check`, `pnpm exec tsgo --noEmit`, `pnpm i18n:extract && pnpm i18n:check`, `pnpm exec vitest run src/components/feedback`.

### Phase 3 — Studio dialog UI
Files: `package.json`, `pnpm-lock.yaml` (`html-to-image` 1.11.13 exact), `src/components/feedback/FeedbackModal.tsx`, `FeedbackModal.test.tsx`, `src/translation/*.json`, `DESIGN.md`. Approach D. Role sensitive.
PROOF COMMAND: `pnpm exec tsgo --noEmit && pnpm i18n:extract && pnpm i18n:check && pnpm i18n:jsx && pnpm exec vitest run src/components/feedback && pnpm build-vite && pnpm bundle:check`.

### Phase 4 — Real-product capture proof
Files: `scripts/verify-app.mjs` (new feedback screenshot scenario per F). Role normal.
PROOF COMMAND: `pnpm build && pnpm verify:app` (run by the orchestrator; the leaf writes the scenario and runs `node --check scripts/verify-app.mjs`).

### Phase 5 — Decision records
chessfable and chess-tactics-app `tasks/decisions.md` via `./scripts/findings.py record-decision`, by the orchestrator (Approach E).

## Reviews

### Round 1 (r1, 9 Grok lenses: plan, minimalism, correctness, tests, error-handling, ipc-contract, api-contract, react-lifecycle, security)
Verdicts: plan REVISE, tests REVISE, correctness REVISE (2 findings in bold-prefixed form: I-2, I-1), error-handling APPROVED (4 should-fix), minimalism APPROVED (1 should-fix, 2 nits), api-contract APPROVED (1 should-fix), security APPROVED (1 should-fix), ipc-contract APPROVED, react-lifecycle APPROVE.

| ID | Claim | Witnesses | Disposition | Evidence / correction |
|---|---|---|---|---|
| I-1 | Invalid anonymous image is 400, not 422 | api-contract r1#1, plan r1#4, correctness r1#2 | Fix | `feedback.py:129-130` maps `FeedbackServiceError` to `validation_error` (400). A acceptance now 400. |
| I-2 | 30 s client `read_timeout` cannot be overridden per request; 120 s `RequestBuilder::timeout` is ineffective | error-handling r1#1, correctness r1#1 | Fix | Verified `reqwest-0.12.5/src/async_impl/client.rs:2068-2077,2542-2548`. C: image requests use an upload client via `safe_http_client` with 120 s read/total. |
| I-3 | Timeout proof cannot fail (test client untimed, 8 KiB body cap) | plan r1#3, tests r1#2 | Fix | F/C: proof must fail if the image path uses the 30 s policy. |
| I-4 | No copy for capture failure / file read failure | error-handling r1#2 | Fix | D failure-copy bullet. |
| I-5 | Native image rejection surfaces as message/email advice | error-handling r1#3 | Fix | C: `FeedbackOutcome::InvalidImage` with image-specific copy. |
| I-6 | Send can complete while a file read is in flight | error-handling r1#4 | Fix | D: Send disabled during capture/read; successful send invalidates attachment work. |
| I-7 | JPEG re-encode is a second capture path ChessRiddle lacks | minimalism r1#1 | Fix (partial) | JPEG branch dropped. Kept one PNG retry at pixelRatio 1, same `toPng` path: a 2× capture of a large window can exceed the 5 MiB server limit, which would make the button fail every time on HiDPI screens. Reviewer to close. |
| I-8 | Extra "sent with the message" hint duplicates the label | minimalism r1#2 (nit) | Fix | D uses web's "Attach image (optional)" label only. |
| I-9 | Camera already in DESIGN.md | minimalism r1#3 (nit) | Fix | D: add rows only for unlisted icons. |
| I-10 | OpenAPI artefacts embed the docstring; not regenerated | plan r1#1 | Fix | A + Phase 1 regenerate and run `api-types`/`mobile-api-types` gates. |
| I-11 | Phase 2 breaks type-check until Phase 3 | plan r1#2 | Fix | Phase 2 includes the call site passing `null`. |
| I-12 | WebKitGTK capture proof not owned by any phase | plan r1#5, tests r1#1 | Fix | Phase 4: `scripts/verify-app.mjs` scenario asserting a decodable, multi-colour PNG preview. |
| I-13 | Anonymous callers can mail arbitrary bytes as screenshot.png | security r1#1 | Fix | A2: magic-byte signature check matching declared MIME, all callers; native mirrors it (C). |
| I-14 | `i18n:jsx` missing from Phase 3 proof | tests r1#3 | Fix | Added. |
| I-15 | 503-with-image not tested | tests r1#4 | Fix | A acceptance + F. |

### Round 2 (r2, 8 Grok lenses: plan, correctness, tests, error-handling, minimalism, api-contract, security, ipc-contract)
Verdicts: plan REVISE; all others APPROVED. I-1..I-15 CLOSED by their witnesses (minimalism closed I-7 with the PNG-retry reason). New:

| ID | Claim | Witnesses | Disposition | Evidence / correction |
|---|---|---|---|---|
| I-16 | Phase 2 omits `FeedbackModal.test.tsx`, whose four-argument matchers go red | plan r2#1 | Fix | Phase 2 files and C name it. |
| I-17 | `b"different image"` idempotency payload fails A2 before the digest check | plan r2#2 | Fix | A2 names it. |
| I-18 | Loopback probe cannot use `safe_http_client` (SafeResolver refuses loopback) | plan r2#3 | Fix | C: direct policy-selection test. Verified `net.rs` `is_public_ip` / `SafeResolver`. |
| I-19 | F tests Send-disabled only for file read, not capture | error-handling r2#1 | Fix | F covers both. |
| I-20 | Threat model omits the native signature check | ipc-contract r2#1 | Fix | Threat model updated; backend 400 for an image stays `DeliveryFailed` by design (checks mirror). |
| I-21 | `tauri.ts` is a Proxy; "passes the argument" invites a hand-written invoke | ipc-contract r2#2 | Fix | C: no facade edit. Verified `src/platform/tauri.ts:386`. |

### Round 3 (r3, 3 Grok lenses: plan, error-handling, ipc-contract)
Verdicts: plan REVISE; error-handling APPROVED; ipc-contract APPROVED. I-16, I-17, I-19 (with new note), I-20, I-21 CLOSED. I-18 NOT CLOSED (plan r3#1, r3#2 same root).

| ID | Claim | Witnesses | Disposition | Evidence / correction |
|---|---|---|---|---|
| I-18 (reopened) | Policy-selection test can pass while the command still posts on the JSON client | plan r3#1, plan r3#2 | Fix | C: selection inside `submit_feedback_request` taking both clients; behavioural loopback test with a short-read-timeout JSON client and delayed headers; constants test for production upload client. `feedback.rs:249-257,623`. |
| I-22 | Disabled button alone does not stop form submit via Enter during in-flight attachment | error-handling r3#1 | Fix | D: `submit()` refuses; F asserts `tauri.submitFeedback` not invoked. `FeedbackModal.tsx:132,167-171`. |

### Round 4 (r4, 2 Grok lenses: plan, error-handling)
Verdicts: plan APPROVED, error-handling APPROVED. I-18 CLOSED (plan r4), I-22 CLOSED (plan r4, error-handling r4). No open issues. Plan-level adoptions: r1=15 r2=6 r3=2 r4=0.


## Cumulative diff review (Studio)

Range origin/master (deb8dbfa) .. HEAD. Round 1: 8 Grok lenses (correctness, root-cause, tests, code-quality, minimalism, error-handling, ipc-contract, tauri-security) plus a records lens; all APPROVED with should-fix/nit findings.

| ID | Finding | Witnesses | Disposition | Closure |
|---|---|---|---|---|
| ST-1 | Rejected file during in-flight capture/read left a stale error over a later attachment | correctness r1#1, error-handling r1#2 | Fix (c173bc31) | CLOSED r2 (correctness, error-handling) |
| ST-2 | Native decode before an encoded-length bound | error-handling r1#1 | Fix | Code CLOSED r2 (error-handling); tests r2 noted the test cannot observe the bound — Skip: the bound only prevents an allocation and changes no return value |
| ST-3 | Image patched into body JSON instead of the typed path | code-quality r1#4, minimalism nit | Fix | CLOSED r2 |
| ST-4 | Names (decodedDataUrlBytes, bumpAttachment), duplicated accept list, literal pixel ratios | code-quality r1#1-3, nit #8 | Fix | CLOSED r2 |
| ST-5 | Two error strings without terminal punctuation | code-quality r1#5 | Fix (16 catalogues) | CLOSED r2 |
| ST-6 | verify-app scenario bypassed its local wait | code-quality r1#6 | Fix | CLOSED r2 |
| ST-7 | net.rs docstring hard-coded values | code-quality nit #7 | Fix | CLOSED r2 |
| ST-8 | Redundant 413 arm | minimalism nit | Fix | CLOSED r2 |
| ST-9 | Duplicate invalidImage test | minimalism nit | Fix | CLOSED r2 |
| ST-10..13 | captureFilter untested; remove-then-resend key; FileReader abort; controls disabled while sending | tests r1#1,#2,#5,#6 | Fix | CLOSED r2 (tests) |
| ST-14 | Over-size rejection race untested (only wrong type) | tests r2 | Fix (c818c008; temporary revert of the size branch turned it red) | CLOSED by arbiter on that revert evidence |
| — | Upload-client wiring test cannot observe timeouts | tests r1#3 | Skip: reqwest::Client exposes no timeout getter and SafeResolver refuses loopback; same shape as native_json_http_client's test | — |
| — | submit_feedback command never executed in tests | tests r1#4 | Skip: two-line forwarder needing tauri State; routing proven in submit_feedback_request (plan I-18) | — |

Verification: pnpm verify:app on release builds of db64a1af and of the final code: "ok Take screenshot attaches a decodable preview with more than one colour", dialog excluded from the capture (inspected screenshot). Final gates (rust, frontend, bindings) all green; pushed deb8dbfa..c818c008.
- Windows CI: run 42374906141 failed rust-windows-test in the new upload-timeout test (WSAECONNRESET: test server closed with unread body); fixed on master by 976258a7 (drain session, same mechanism); this run's equivalent fix 67c15e4e was dropped at rebase.
