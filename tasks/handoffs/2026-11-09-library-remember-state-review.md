# Review record: Library remembers its view while the app is open

## Mandate

Felix, 2026-11-09: "Currently when I open one library, let's say Black Karo Khan, then I see it on the right side. When I then double click on a file there to open it and then go back to library, I again see the blank page on the right side. should it be remembered what I selected last? For example when I want to open different files from one folder it would be easier if it would be remembered. So then I can just click on library again and then open the next one without having to click on black Karo Khan first again to open the right side and then click again."

Felix, 2026-11-09, answering the proposal that named the selected item with its details, the position in the game list, and the search text and type filter, and the question whether this lasts only while the app is open or also after a restart: "Yes, only while it's open. Then let's build this now. Make a plan, review it with codex and then decide if you want to build it inline or with executor codex. Full auto on a separate work tree."

## Plan review

### Round 1 (Codex, plan-r1)
Verdicts: plan REVISE, minimalism APPROVED, correctness REVISE, tests APPROVED, error-handling APPROVED, persisted-state APPROVED.

- **I1** (plan r1 #1 blocker, tests r1 #2 should-fix): the phase proof never runs the promised Playwright flow, and component tests mock the virtualizer. Verified: `vite.config.ts` excludes e2e, `GameSelector.test.tsx` mocks the virtualizer, project `files-preview` exists in `playwright.config.ts:145`. Fix: browser proof added to the phase, and the flow must cover visibility after section headings load. Obligation: Reveal the remembered row. Open for closure.
- **I2** (plan r1 #2 should-fix): the second `GameSelector` host is `InfoPanel.tsx:665`, not `FileInfo`. Verified by `git grep`. Fix: reference corrected at all three places, semantics unchanged. Open for closure.
- **I3** (correctness r1 #1 blocker): a remembered file deleted externally is restored from the cached listing and exposes actions until revalidation. Skip. Evidence: `LibraryPage.tsx:323-326` renders every left-list row and its Trash and Move actions from that same cached listing, and `useFileWorkspace.tsx:210` revalidates on mount, so this is the existing window of every Library row and not created by remembering. A validate-before-expose mechanism has no MANDATE authority. The plan's over-broad threat-model sentence that prompted the finding is corrected and the window is recorded under Risks.
- **I4** (tests r1 #1 should-fix): no assertion pins the only-while-open lifetime. Fix: a fresh store with web storage retained must start with defaults. Obligation: View memory, Verification. Open for closure.
- **I5** (error-handling r1 #1 should-fix): failure behaviour of row reads during a reveal is unspecified. Fix: failed reads behave as today, leave the position unchanged, and the reveal adds no read. Obligation: Reveal the remembered row. Open for closure.

Plan-level adoptions r1=5 (plan 2, tests 2, error-handling 1).

### Round 2 (Codex, plan-r2)
Verdicts: plan APPROVED, tests APPROVED, error-handling APPROVED, correctness APPROVED.
I1, I2, I4 and I5 CLOSED by their witnesses and review-plan against plan-r2. No new findings. Plan-level adoptions r2=0.

Executor decision: Codex write leaf, role normal. Felix left inline versus Codex to the orchestrator. The phase needs repeated browser runs, and a separate writer keeps the orchestrator's diff inspection independent.

## Diff review

Executor Codex wrote the code, and the Codex lenses that reviewed it are the same model family. The Claude Code orchestrator wrote the plan and arbitrated, which is the only family separation in this run.

### Round d1 (Codex, reviewed through b16db962)
Verdicts: correctness APPROVED, root-cause APPROVED, tests APPROVED, code-quality APPROVED, minimalism REVISE, persisted-state APPROVED, records APPROVED.

- **D1** (tests should-fix, confidence 99): the opt-in test passed `false` explicitly, so the omitted-prop default used by InfoPanel was untested. Fix.
- **D2** (minimalism should-fix, confidence 98): the new Playwright flow duplicated the viewport check of `expectCurrentNotationCellVisible`. Fix, shared helper.
- **D3** (correctness limitation, confidence 60, adopted by the orchestrator): only a fixed key list ended the reveal, so a row scrolled by Tab could be pulled back. Fix, any key or focus entering the list ends it.
- **D4** (orchestrator): the folder case of the remount test matched text that the left tree also renders. Fix, assert the folder entry count.

### Round d2 closure (Codex, reviewed through 0c58f70d)
Verdicts: correctness APPROVED, tests APPROVED, minimalism APPROVED. D1, D2, D3 and D4 CLOSED by those lenses.

diff_adopted_per_round: r1=4 r2=0.

## Verification evidence
- Removing `revealActivePage` from FileCard turns the new Playwright test red.
- Setting the prop default to true fails the omitted-prop test, and removing `onFocusCapture` fails the focusin case.
- WebKit probe with Playwright's installed WebKit: the file and game 40 were selected after returning and the row was inside the list. This was a scratch spec, not a committed test. The committed spec's parent-element hover does not settle in that WebKit, so the probe scrolled the real viewport.
- The native WebKitGTK window of the release app was not driven for this flow.
