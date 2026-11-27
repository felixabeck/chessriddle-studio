import { MantineProvider } from "@mantine/core";
import { atom, createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ConnectionSummary, TurnUpdate } from "@/bindings";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { defaultTree } from "@/utils/treeReducer";

const mocks = vi.hoisted(() => ({
  coachConnections: vi.fn(),
  coachModels: vi.fn(),
  prepareAnalysis: vi.fn(),
  coachTurn: vi.fn(),
  cancelAnalysis: vi.fn(),
  coachOpenUsage: vi.fn(),
  showPageTab: vi.fn(),
  engines: [] as unknown[] | undefined,
  refreshRepertoireIndex: vi.fn(),
  repertoireContext: vi.fn(),
  currency: { key: null, collection: null, pending: false } as Record<string, unknown>,
}));
vi.mock("@/platform/tauri", () => ({ tauri: mocks }));
vi.mock("@/state/repertoireIndex", () => ({
  refreshRepertoireIndex: mocks.refreshRepertoireIndex,
  repertoireContext: mocks.repertoireContext,
}));
vi.mock("@/state/linkedCollections", async (original) => ({
  ...(await original<typeof import("@/state/linkedCollections")>()),
  useCollectionCurrency: () => mocks.currency,
}));
vi.mock("@/platform/native", () => ({
  platform: vi.fn(() => "linux"),
  warn: vi.fn(() => Promise.resolve()),
  error: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));
vi.mock("@/components/tabs/TabCommands", () => ({
  useTabCommands: () => ({ showPageTab: mocks.showPageTab }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && ("line" in options || "provider" in options)
        ? `${key}:${String(options.line ?? options.provider)}`
        : key,
  }),
}));
vi.mock("@/chessground/Chessground", () => ({
  Chessground: ({ fen }: { fen: string }) => <div data-preview-fen={fen} />,
}));
vi.mock("@/state/atoms", async (original) => ({
  ...(await original<typeof import("@/state/atoms")>()),
  enginesAtom: atom<unknown[] | undefined>([]),
}));

const {
  COACH_EXPLAIN_REQUEST_MAX_AGE_MS,
  coachExplainRequestFamily,
  coachTurnFamily,
  enginesAtom,
  fileWorkspaceAtom,
  referenceDbAtom,
} = await import("@/state/atoms");
const { coachConnectionsAtom, coachNoticeAcceptedAtom, coachSelectionAtom } =
  await import("@/state/coach");
const { applyCoachTurnEvent } = await import("@/state/coachTurns");
const { closeTreeStore, createTreeStore } = await import("@/state/store/tree");
const { settingsNavigationRequestAtom } = await import("@/state/settingsNavigation");
const { WorkspaceTabScope } = await import("@/state/tabScope");
const { default: CoachPanel } = await import("./CoachPanel");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

const connection: ConnectionSummary = {
  handle: "conn-1",
  kind: "api",
  label: "Ollama",
  address: "http://localhost:11434/v1",
  hasKey: false,
  account: null,
  status: "ready",
};
const engine = {
  type: "local",
  id: "engine-1",
  name: "Engine",
  handle: { id: { id: "engine-ref" }, kind: "engine" },
  loaded: true,
  settings: [],
};
const answer: TurnUpdate = {
  type: "completed",
  segments: [
    { type: "text", text: "Develop with " },
    { type: "line", san: ["Nf3", "Nc6"], uci: ["g1f3", "b8c6"] },
    { type: "text", text: " and **castle**." },
  ],
  failedLines: 0,
};

const TAB = "coach-panel-tab";
let host: HTMLDivElement;
let root: Root;
let atoms: ReturnType<typeof createStore>;
let tree: ReturnType<typeof createTreeStore>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  mocks.engines = [engine];
  mocks.coachConnections.mockResolvedValue([connection]);
  mocks.coachModels.mockResolvedValue({
    models: [
      { id: "plain", name: "Plain", effortLevels: [], defaultEffort: null, supportsTools: null },
    ],
    truncated: false,
  });
  mocks.prepareAnalysis.mockResolvedValue("ticket-1");
  mocks.cancelAnalysis.mockResolvedValue(undefined);
  mocks.coachOpenUsage.mockResolvedValue(null);
  mocks.refreshRepertoireIndex.mockResolvedValue(undefined);
  mocks.repertoireContext.mockResolvedValue({ text: null, partial: false });
  mocks.currency = { key: null, collection: null, pending: false };
  Element.prototype.scrollTo = vi.fn();
  atoms = createStore();
  atoms.set(enginesAtom, mocks.engines as never);
  tree = createTreeStore(TAB);
  tree.getState().setState(defaultTree());
  tree.getState().makeMoves({ payload: ["e4", "e5"] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
  closeTreeStore(TAB);
  coachTurnFamily.remove(TAB);
  coachExplainRequestFamily.remove(TAB);
});

async function render({ selected = true, accepted = true } = {}) {
  atoms.set(enginesAtom, mocks.engines as never);
  if (selected)
    atoms.set(coachSelectionAtom, { connection: "conn-1", model: "plain", effort: null });
  if (accepted) atoms.set(coachNoticeAcceptedAtom, ["conn-1"]);
  await act(async () =>
    root.render(
      <Provider store={atoms}>
        <MantineProvider env="test">
          <WorkspaceTabScope tabId={TAB}>
            <TreeStateContext.Provider value={tree}>
              <CoachPanel />
            </TreeStateContext.Provider>
          </WorkspaceTabScope>
        </MantineProvider>
      </Provider>,
    ),
  );
  // The connection list and then the model list arrive.
  await act(async () => {});
}

function button(name: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === name || node.getAttribute("aria-label") === name,
  )!;
}

/** Opens the model button's popover; its selectors are labelled fields. */
async function openModelMenu() {
  await act(async () => button("Coach.ModelSettings", host).click());
}

function field(label: string) {
  const node = [...document.querySelectorAll("label")].find((item) => item.textContent === label)!;
  return document.getElementById(node.htmlFor) as HTMLInputElement;
}

async function ask(text: string) {
  const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Coach.Ask"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Coach.Send").click());
}

test("without a connection or an engine the panel says what is needed and where", async () => {
  mocks.coachConnections.mockResolvedValue([{ ...connection, status: "needsRepair" }]);
  await render();
  expect(host.textContent).toContain("Coach.NoConnection");
  await act(async () => button("Coach.OpenSettings").click());
  expect(atoms.get(settingsNavigationRequestAtom)?.target).toEqual({
    kind: "category",
    category: "coach",
  });
  expect(mocks.showPageTab).toHaveBeenLastCalledWith("settings");
  expect(host.querySelector("textarea")).toBeNull();
});

test("without a local engine there is no composer, only the way to the engines", async () => {
  mocks.engines = [{ ...engine, loaded: false }];
  await render();
  expect(host.textContent).toContain("Coach.NoEngine");
  await act(async () => button("Coach.OpenEngines").click());
  expect(mocks.showPageTab).toHaveBeenLastCalledWith("engines");
  expect(host.querySelector("textarea")).toBeNull();
});

test("nothing is sent for a connection before its notice was accepted", async () => {
  mocks.coachTurn.mockResolvedValue(answer);
  await render({ accepted: false });
  await ask("What is the plan?");
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Coach.Notice.Body:Ollama");
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();

  await act(async () => button("Common.Cancel", dialog).click());
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(atoms.get(coachNoticeAcceptedAtom)).toEqual([]);

  await act(async () => button("Coach.Send").click());
  const again = document.querySelector<HTMLElement>('[role="dialog"]')!;
  await act(async () => button("Coach.Notice.Accept", again).click());
  await act(async () => {});
  expect(atoms.get(coachNoticeAcceptedAtom)).toEqual(["conn-1"]);
  expect(mocks.coachTurn).toHaveBeenCalledOnce();
  expect(mocks.coachTurn.mock.calls[0][2]).toMatchObject({
    connection: "conn-1",
    model: "plain",
    message: "What is the plan?",
  });

  // The next question for the same connection goes straight out.
  mocks.prepareAnalysis.mockResolvedValue("ticket-2");
  await ask("And then?");
  await act(async () => {});
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(mocks.coachTurn).toHaveBeenCalledTimes(2);
});

test("a question needs a chosen model, and a model without reported levels sends no effort", async () => {
  await render({ selected: false });
  atoms.set(coachSelectionAtom, { connection: "conn-1", model: null, effort: null });
  await act(async () => {});
  expect(mocks.coachModels).toHaveBeenLastCalledWith("conn-1");
  await ask("Plan?");
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(button("Coach.Send").disabled).toBe(true);
  expect(host.textContent).toContain("Coach.Hint.ChooseModel");

  await act(async () =>
    atoms.set(coachSelectionAtom, { connection: "conn-1", model: "plain", effort: null }),
  );
  // The model button names the model; its popover holds the effort.
  expect(button("Coach.ModelSettings", host).textContent).toBe("Plain");
  await openModelMenu();
  expect(field("Coach.Effort").value).toBe("Coach.Effort.Default");
  mocks.coachTurn.mockResolvedValue(answer);
  await act(async () => button("Coach.Send").click());
  await act(async () => {});
  expect(mocks.coachTurn.mock.calls[0][2].effort).toBeUndefined();
});

test("the model button names a reported effort, and the effort chosen in its popover is sent", async () => {
  mocks.coachModels.mockResolvedValue({
    models: [
      {
        id: "deep",
        name: "Deep",
        effortLevels: ["low", "medium", "high"],
        defaultEffort: null,
        supportsTools: null,
      },
    ],
    truncated: false,
  });
  atoms.set(coachSelectionAtom, { connection: "conn-1", model: "deep", effort: null });
  await render({ selected: false });
  // No stored effort: the model's default level applies and is named on the button.
  expect(button("Coach.ModelSettings", host).textContent).toBe("Deep · Coach.Effort.Medium");
  await openModelMenu();
  expect(field("Coach.Effort").value).toBe("Coach.Effort.Medium");

  await act(async () =>
    atoms.set(coachSelectionAtom, { connection: "conn-1", model: "deep", effort: "high" }),
  );
  expect(button("Coach.ModelSettings", host).textContent).toBe("Deep · Coach.Effort.High");
  mocks.coachTurn.mockResolvedValue(answer);
  await ask("Plan?");
  await act(async () => {});
  expect(mocks.coachTurn.mock.calls[0][2].effort).toBe("high");
});

test("a sole connection is chosen without a click, and the hint names what is still missing", async () => {
  await render({ selected: false });
  // Nothing stored: the only connection is used and its models are read.
  expect(mocks.coachModels).toHaveBeenLastCalledWith("conn-1");
  expect(button("Coach.ModelSettings", host).textContent).toBe("Coach.ChooseModel");
  await openModelMenu();
  expect(field("Coach.Connection").value).toBe("Ollama");
  expect(host.textContent).toContain("Coach.Hint.ChooseModel");
  expect(host.textContent).not.toContain("Coach.Hint.ChooseConnection");

  // A model chosen for the connection ends the hint. (That the model selector stores the
  // connection with the model is proven by e2e/coach.spec.ts, which never picks the connection.)
  await act(async () =>
    atoms.set(coachSelectionAtom, { connection: "conn-1", model: "plain", effort: null }),
  );
  expect(host.textContent).not.toContain("Coach.Hint.");
});

test("with several connections and none chosen, the hint asks for a connection", async () => {
  mocks.coachConnections.mockResolvedValue([
    connection,
    { ...connection, handle: "conn-2", label: "LM Studio" },
  ]);
  await render({ selected: false });
  expect(mocks.coachModels).not.toHaveBeenCalledWith("conn-1");
  expect(host.textContent).toContain("Coach.Hint.ChooseConnection");
  expect(button("Coach.Send").disabled).toBe(true);
});

test("the panel keeps the repertoire index current and asks with the reference database of now", async () => {
  const workspace = { id: { id: "workspace" }, kind: "fileWorkspace" };
  const chosen = { id: { id: "chosen" }, kind: "database" };
  const published = { id: { id: "published" }, kind: "database" };
  atoms.set(fileWorkspaceAtom, workspace as never);
  atoms.set(referenceDbAtom, chosen as never);
  mocks.coachTurn.mockResolvedValue(answer);
  mocks.repertoireContext.mockResolvedValue({ text: "2. Nf3 Nc6", partial: false });
  await render();
  // Opening the panel starts the index for the workspace.
  expect(mocks.refreshRepertoireIndex).toHaveBeenLastCalledWith(workspace);
  const refreshes = mocks.refreshRepertoireIndex.mock.calls.length;

  await ask("Plan?");
  await act(async () => {});
  expect(mocks.coachTurn.mock.calls[0][2]).toMatchObject({
    referenceDb: chosen,
    repertoire: "2. Nf3 Nc6",
    repertoirePartial: false,
  });
  // Each question brings the index up to date for the next one.
  expect(mocks.refreshRepertoireIndex).toHaveBeenCalledTimes(refreshes + 1);
  expect(mocks.refreshRepertoireIndex).toHaveBeenLastCalledWith(workspace);

  // A linked collection that published a new database is asked through that one...
  mocks.currency = {
    key: "chosen",
    pending: false,
    collection: { status: "ready", database: published },
  };
  mocks.prepareAnalysis.mockResolvedValue("ticket-2");
  await ask("And now?");
  await act(async () => {});
  expect(mocks.coachTurn.mock.calls[1][2].referenceDb).toEqual(published);

  // ...and while it cannot be used, no database is sent at all.
  mocks.currency = { key: "chosen", pending: false, collection: { status: "stale" } };
  mocks.prepareAnalysis.mockResolvedValue("ticket-3");
  await ask("And then?");
  await act(async () => {});
  expect(mocks.coachTurn.mock.calls[2][2].referenceDb).toBeUndefined();
});

test("a ChatGPT connection says whose plan is used and where its usage is managed", async () => {
  await render();
  // An address connection uses no plan and shows no such line.
  await openModelMenu();
  expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain("Coach.Plan.Using");
  await act(async () => root.unmount());
  root = createRoot(host);

  mocks.coachConnections.mockResolvedValue([
    { ...connection, kind: "chatGpt", label: "ChatGPT", address: null, account: "p@example.com" },
  ]);
  atoms = createStore();
  await render();
  // The plan line is part of the model popover, not of the panel.
  expect(host.textContent).not.toContain("Coach.Plan.Using");
  await openModelMenu();
  const popover = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(popover.textContent).toContain("Coach.Plan.Using");
  await act(async () => button("Coach.Plan.ManageUsage", popover).click());
  expect(mocks.coachOpenUsage).toHaveBeenCalledOnce();
});

test("at the plan's limit the answer leads to the usage page, and an ended sign-in re-reads the connections", async () => {
  mocks.coachTurn.mockResolvedValue({ type: "failed", error: "usageLimitReached", text: "" });
  await render();
  await ask("Plan?");
  await act(async () => {});
  const limited = host.querySelector<HTMLElement>('[data-testid="coach-answer"]')!;
  expect(limited.textContent).toContain("Coach.Error.UsageLimitReached");
  await act(async () => button("Coach.Plan.ManageUsage", limited).click());
  expect(mocks.coachOpenUsage).toHaveBeenCalledOnce();

  const reads = mocks.coachConnections.mock.calls.length;
  mocks.prepareAnalysis.mockResolvedValue("ticket-2");
  mocks.coachTurn.mockResolvedValue({ type: "failed", error: "signInAgain", text: "" });
  await ask("And now?");
  await act(async () => {});
  const answers = host.querySelectorAll<HTMLElement>('[data-testid="coach-answer"]');
  expect(answers[1].textContent).toContain("Coach.Error.SignInAgain");
  // Only the limit offers the usage page.
  expect(button("Coach.Plan.ManageUsage", answers[1])).toBeUndefined();
  expect(mocks.coachConnections.mock.calls.length).toBe(reads + 1);
});

test("a failed model list is named under the composer and at the model selector", async () => {
  const { CoachCommandError } = await import("@/platform/coach");
  mocks.coachModels.mockRejectedValue(new CoachCommandError("keyRejected"));
  await render();
  // The selectors are behind the model button, so the composer's hint names the failure.
  const hint = host.querySelector<HTMLElement>("form")!;
  expect(hint.textContent).toContain("Coach.Error.KeyRejected");
  expect(host.textContent).not.toContain("Coach.Hint.");
  expect(button("Coach.Send").disabled).toBe(true);
  await openModelMenu();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Coach.Error.KeyRejected");
  expect(field("Coach.Model").disabled).toBe(true);
});

test("a failed model list offers Retry under the composer, which reads the list again", async () => {
  const { CoachCommandError } = await import("@/platform/coach");
  mocks.coachModels.mockRejectedValueOnce(new CoachCommandError("storage"));
  await render();
  const form = host.querySelector<HTMLElement>("form")!;
  expect(form.textContent).toContain("Coach.Error.Storage");
  const reads = mocks.coachModels.mock.calls.length;
  await act(async () => button("Common.Retry").click());
  expect(mocks.coachModels.mock.calls.length).toBe(reads + 1);
  expect(mocks.coachModels).toHaveBeenLastCalledWith("conn-1");
  // The second read succeeded: the failure and its Retry are gone.
  expect(form.textContent).not.toContain("Coach.Error.Storage");
  expect([...form.querySelectorAll("button")].some((b) => b.textContent === "Common.Retry")).toBe(
    false,
  );
});

test("a hint that only asks for a choice offers no Retry", async () => {
  await render({ selected: false });
  const form = host.querySelector<HTMLElement>("form")!;
  expect(form.textContent).toContain("Coach.Hint.");
  expect([...form.querySelectorAll("button")].some((b) => b.textContent === "Common.Retry")).toBe(
    false,
  );
});

test("while the model list loads, no hint asks for a model yet", async () => {
  mocks.coachModels.mockReturnValue(new Promise(() => {}));
  await render({ selected: false });
  expect(mocks.coachModels).toHaveBeenLastCalledWith("conn-1");
  expect(host.textContent).not.toContain("Coach.Hint.");
  expect(button("Coach.Send").disabled).toBe(true);
});

test("an answer streams, can be stopped, and ends as the saved exchange", async () => {
  const command = deferred<TurnUpdate>();
  mocks.coachTurn.mockReturnValue(command.promise);
  await render();
  await ask("What is the plan?");
  await act(async () => {});
  expect(host.querySelector('[data-testid="coach-running"]')?.textContent).toContain(
    "Coach.Thinking",
  );
  await act(async () =>
    applyCoachTurnEvent(atoms, {
      tab: TAB,
      turn: "ticket-1",
      update: { type: "tool", source: "engine", line: ["Nf3"] },
    }),
  );
  expect(host.textContent).toContain("Coach.CheckingLine:Nf3");
  for (const [source, line, shown] of [
    ["engine", [], "Coach.CheckingPosition"],
    ["database", ["Nf3"], "Coach.LookingUpLine:Nf3"],
    ["database", [], "Coach.LookingUpPosition"],
  ] as const) {
    await act(async () =>
      applyCoachTurnEvent(atoms, {
        tab: TAB,
        turn: "ticket-1",
        update: { type: "tool", source, line: [...line] },
      }),
    );
    expect(host.querySelector('[data-testid="coach-running"]')?.textContent).toContain(shown);
  }
  await act(async () =>
    applyCoachTurnEvent(atoms, {
      tab: TAB,
      turn: "ticket-1",
      update: { type: "text", delta: "Develop" },
    }),
  );
  expect(host.querySelector('[data-testid="coach-running"]')?.textContent).toContain("Develop");

  await act(async () => button("Coach.Stop").click());
  expect(mocks.cancelAnalysis).toHaveBeenCalledExactlyOnceWith("ticket-1");
  expect(button("Coach.Stop").disabled).toBe(true);
  await act(async () => command.resolve({ type: "cancelled", text: "Develop" }));
  expect(host.querySelector('[data-testid="coach-running"]')).toBeNull();
  expect(host.querySelector('[data-testid="coach-answer"]')?.textContent).toContain("Develop");
  expect(host.textContent).toContain("Coach.Stopped");
  expect(host.querySelector('[data-testid="coach-question"]')?.textContent).toBe(
    "What is the plan?",
  );
});

test("a Coach line only previews; the insert button is the one way into the game", async () => {
  mocks.coachTurn.mockResolvedValue(answer);
  await render();
  await ask("What is the plan?");
  await act(async () => {});
  const shown = host.querySelector<HTMLElement>('[data-testid="coach-answer"]')!;
  expect(shown.textContent).toContain("Develop with ");
  expect(shown.querySelector("strong")?.textContent).toBe("castle");
  const line = shown.querySelector<HTMLElement>('[data-testid="coach-line"]')!;
  // Numbered from the position the question was asked about: White's second move.
  expect(line.textContent).toContain("2.");

  const before = tree.getState();
  // The innermost element that shows the move (its piece letter may be drawn as a symbol): a
  // click there bubbles to the move itself.
  const move = [...line.querySelectorAll<HTMLElement>("*")]
    .filter((node) => /^.c6$/u.test(node.textContent ?? ""))
    .at(-1)!;
  await act(async () => move.click());
  expect(tree.getState().root).toBe(before.root);
  expect(tree.getState().position).toEqual([0, 0]);
  // The click pinned the preview on the position after the clicked move.
  expect(document.querySelector('[data-testid="engine-line-preview"]')).not.toBeNull();

  // The board has moved on since the question; the line still goes where it belongs.
  await act(async () => tree.getState().goToMove([0]));
  await act(async () => button("Coach.InsertLine", line).click());
  const state = tree.getState();
  expect(state.position).toEqual([0, 0, 0, 0]);
  expect(state.root.children[0].children[0].children[0].san).toBe("Nf3");
  expect(state.currentNode().san).toBe("Nc6");
});

test("a pinned line preview stays through hovering and leaves by its own ways only", async () => {
  // The hover preference is off: a click still pins, because a Coach line has no other way to
  // show its position.
  const { previewBoardOnHoverAtom } = await import("@/state/atoms");
  atoms.set(previewBoardOnHoverAtom, false);
  mocks.coachTurn.mockResolvedValue(answer);
  await render();
  await ask("What is the plan?");
  await act(async () => {});
  const line = host.querySelector<HTMLElement>('[data-testid="coach-line"]')!;
  const moveNamed = (pattern: RegExp) =>
    [...line.querySelectorAll<HTMLElement>("*")]
      .filter((node) => pattern.test(node.textContent ?? ""))
      .at(-1)!;
  const preview = () => document.querySelector<HTMLElement>('[data-testid="engine-line-preview"]');
  const hover = (node: HTMLElement) =>
    act(async () => node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));

  // Hovering alone shows nothing while the preference is off.
  await hover(moveNamed(/^.c6$/u));
  expect(preview()).toBeNull();

  await act(async () => moveNamed(/^.c6$/u).click());
  const pinnedBoard = preview()!.innerHTML;
  expect(pinnedBoard).not.toBe("");
  // Another move under the pointer does not replace the pinned position, and leaving the line
  // does not close it.
  await hover(moveNamed(/^.f3$/u));
  expect(preview()!.innerHTML).toBe(pinnedBoard);
  await act(async () => line.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
  expect(preview()).not.toBeNull();
  // A pointer press on the line itself keeps it; one anywhere else dismisses it.
  await act(async () => line.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(preview()).not.toBeNull();
  await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(preview()).toBeNull();

  // Clicking another move pins that one; clicking the pinned move again unpins it.
  await act(async () => moveNamed(/^.c6$/u).click());
  await act(async () => moveNamed(/^.f3$/u).click());
  expect(preview()).not.toBeNull();
  expect(preview()!.innerHTML).not.toBe(pinnedBoard);
  await act(async () => moveNamed(/^.f3$/u).click());
  expect(preview()).toBeNull();
  // None of it touched the game.
  expect(tree.getState().position).toEqual([0, 0]);
});

test("connections that only the keyring hides are not reported as no connection", async () => {
  mocks.coachConnections.mockResolvedValue([{ ...connection, status: "storageUnavailable" }]);
  await render();
  expect(host.textContent).toContain("Coach.Error.Storage");
  expect(host.textContent).not.toContain("Coach.NoConnection");
  expect(host.querySelector("textarea")).toBeNull();
  // Reading again brings the connection back.
  mocks.coachConnections.mockResolvedValue([connection]);
  await act(async () => button("Common.Retry").click());
  expect(host.textContent).not.toContain("Coach.Error.Storage");
  expect(host.querySelector("textarea")).not.toBeNull();
});

test("a line whose position left the game cannot be inserted, and a new conversation clears", async () => {
  mocks.coachTurn.mockResolvedValue(answer);
  await render();
  await ask("What is the plan?");
  await act(async () => {});
  await act(async () => tree.getState().deleteMove([0, 0]));
  const line = host.querySelector<HTMLElement>('[data-testid="coach-line"]')!;
  const insert = button("Coach.InsertUnavailable", line);
  expect(insert.disabled).toBe(true);

  await act(async () => button("Coach.NewConversation").click());
  expect(tree.getState().coachSession).toBeUndefined();
  expect(host.textContent).toContain("Coach.Empty");
});

function makeExplainRequest(
  overrides: Partial<{
    id: string;
    documentId: number;
    fen: string;
    clickedAt: number;
    question: string;
  }> = {},
) {
  const state = tree.getState();
  return {
    id: "req-1",
    documentId: state.documentId,
    fen: state.currentNode().fen,
    clickedAt: Date.now(),
    question: "Explain why 2. Qh5?! is worse than Nf3.",
    ...overrides,
  };
}

test("O7 CoachPanel holds a pending explain request while connections and models load, then sends once when ready", async () => {
  const conns = deferred<ConnectionSummary[]>();
  const models = deferred<{
    models: {
      id: string;
      name: string;
      effortLevels: string[];
      defaultEffort: null;
      supportsTools: null;
    }[];
    truncated: boolean;
  }>();
  mocks.coachConnections.mockReturnValue(conns.promise);
  mocks.coachModels.mockReturnValue(models.promise);
  mocks.coachTurn.mockResolvedValue(answer);

  const req = makeExplainRequest();
  atoms.set(coachExplainRequestFamily(TAB), req);
  await render();

  // Still loading connections: request stays pending, nothing sent, no draft.
  expect(atoms.get(coachExplainRequestFamily(TAB))).toEqual(req);
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(mocks.coachTurn).not.toHaveBeenCalled();

  // Connections resolve, models still loading: request stays pending, draft empty.
  await act(async () => conns.resolve([connection]));
  await act(async () => {});
  expect(atoms.get(coachExplainRequestFamily(TAB))).toEqual(req);
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Coach.Ask"]')?.value).toBe(
    "",
  );

  // Models resolve: request is taken once, cleared, and sent through the typed-question path.
  await act(async () =>
    models.resolve({
      models: [
        { id: "plain", name: "Plain", effortLevels: [], defaultEffort: null, supportsTools: null },
      ],
      truncated: false,
    }),
  );
  await act(async () => {});
  expect(atoms.get(coachExplainRequestFamily(TAB))).toBeNull();
  expect(mocks.coachTurn).toHaveBeenCalledOnce();
  expect(mocks.coachTurn.mock.calls[0][2].message).toBe(req.question);

  // Re-rendering does not send the request a second time.
  await act(async () => {});
  expect(mocks.coachTurn).toHaveBeenCalledOnce();
});

test("O7 CoachPanel drops a pending explain request when the user moves to another position", async () => {
  const conns = deferred<ConnectionSummary[]>();
  mocks.coachConnections.mockReturnValue(conns.promise);
  mocks.coachTurn.mockResolvedValue(answer);

  atoms.set(coachExplainRequestFamily(TAB), makeExplainRequest());
  await render();
  expect(atoms.get(coachExplainRequestFamily(TAB))).not.toBeNull();

  // User navigates to another position before connections settle.
  await act(async () => tree.getState().goToMove([0]));
  expect(atoms.get(coachExplainRequestFamily(TAB))).toBeNull();

  await act(async () => conns.resolve([connection]));
  await act(async () => {});
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(mocks.coachTurn).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Coach.Ask"]')?.value).toBe(
    "",
  );
});

test("O7 CoachPanel drops a pending explain request when the tab switches to another document", async () => {
  const conns = deferred<ConnectionSummary[]>();
  mocks.coachConnections.mockReturnValue(conns.promise);
  mocks.coachTurn.mockResolvedValue(answer);

  atoms.set(coachExplainRequestFamily(TAB), makeExplainRequest());
  await render();
  expect(atoms.get(coachExplainRequestFamily(TAB))).not.toBeNull();

  // Replace the game with a new document at the exact same position FEN.
  await act(async () => {
    tree.getState().setState(defaultTree());
    tree.getState().makeMoves({ payload: ["e4", "e5"] });
  });
  expect(atoms.get(coachExplainRequestFamily(TAB))).toBeNull();

  await act(async () => conns.resolve([connection]));
  await act(async () => {});
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(mocks.coachTurn).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Coach.Ask"]')?.value).toBe(
    "",
  );
});

test("O7 CoachPanel drops a pending explain request once it is older than 30 seconds", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-27T10:00:00Z"));
  const conns = deferred<ConnectionSummary[]>();
  mocks.coachConnections.mockReturnValue(conns.promise);
  mocks.coachTurn.mockResolvedValue(answer);

  atoms.set(coachExplainRequestFamily(TAB), makeExplainRequest());
  await render();
  expect(atoms.get(coachExplainRequestFamily(TAB))).not.toBeNull();

  // At exactly 30s it is not yet above 30s; at 30s + 1ms it is dropped.
  await act(async () => {
    vi.advanceTimersByTime(COACH_EXPLAIN_REQUEST_MAX_AGE_MS);
  });
  expect(atoms.get(coachExplainRequestFamily(TAB))).not.toBeNull();

  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(atoms.get(coachExplainRequestFamily(TAB))).toBeNull();

  await act(async () => conns.resolve([connection]));
  await act(async () => {});
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(mocks.coachTurn).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Coach.Ask"]')?.value).toBe(
    "",
  );
});

test("O7 CoachPanel puts the explain request into the draft when engines are not loaded", async () => {
  mocks.engines = undefined;
  atoms.set(enginesAtom, undefined as never);
  const req = makeExplainRequest({ id: "req-undef-engine" });
  atoms.set(coachExplainRequestFamily(TAB), req);
  await render();

  expect(atoms.get(coachExplainRequestFamily(TAB))).toBeNull();
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(mocks.coachTurn).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Coach.Ask"]')?.value).toBe(
    req.question,
  );
});

test("O7 CoachPanel puts the explain request into the draft when a turn is already running", async () => {
  mocks.coachTurn.mockResolvedValue(answer);
  await render();
  await act(async () => {
    atoms.set(coachTurnFamily(TAB), {
      question: "Earlier question",
      text: "Thinking...",
      checking: null,
      stopping: false,
      orphaned: false,
    });
  });
  const req = makeExplainRequest({ id: "req-running", question: "Second explain question." });
  await act(async () => {
    atoms.set(coachExplainRequestFamily(TAB), req);
  });

  expect(atoms.get(coachExplainRequestFamily(TAB))).toBeNull();
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(mocks.coachTurn).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Coach.Ask"]')?.value).toBe(
    req.question,
  );
});

test("O7 CoachPanel puts the explain request into the draft when connections fail to load", async () => {
  const { CoachCommandError } = await import("@/platform/coach");
  mocks.coachConnections.mockRejectedValueOnce(new CoachCommandError("storage"));
  const req = makeExplainRequest({ id: "req-conn-failed" });
  atoms.set(coachExplainRequestFamily(TAB), req);
  await render();

  expect(atoms.get(coachExplainRequestFamily(TAB))).toBeNull();
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(mocks.coachTurn).not.toHaveBeenCalled();

  // Recovering connections mounts the composer with the preserved draft and does not auto-send.
  mocks.coachConnections.mockResolvedValue([connection]);
  await act(async () => {
    await atoms.set(coachConnectionsAtom);
  });
  await act(async () => {});
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Coach.Ask"]')?.value).toBe(
    req.question,
  );
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(mocks.coachTurn).not.toHaveBeenCalled();
});

test("O7 CoachPanel puts the explain request into the draft when models fail to load", async () => {
  const { CoachCommandError } = await import("@/platform/coach");
  mocks.coachModels.mockRejectedValue(new CoachCommandError("keyRejected"));
  const req = makeExplainRequest({ id: "req-models-failed" });
  atoms.set(coachExplainRequestFamily(TAB), req);
  await render();

  expect(atoms.get(coachExplainRequestFamily(TAB))).toBeNull();
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(mocks.coachTurn).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Coach.Ask"]')?.value).toBe(
    req.question,
  );
});

test("O7 CoachPanel puts the explain request into the draft when no effective connection is chosen", async () => {
  mocks.coachConnections.mockResolvedValue([
    connection,
    { ...connection, handle: "conn-2", label: "LM Studio" },
  ]);
  const req = makeExplainRequest({ id: "req-no-connection" });
  atoms.set(coachExplainRequestFamily(TAB), req);
  await render({ selected: false });

  expect(atoms.get(coachExplainRequestFamily(TAB))).toBeNull();
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(mocks.coachTurn).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Coach.Ask"]')?.value).toBe(
    req.question,
  );
});

test("O7 CoachPanel puts the explain request into the draft when no model is chosen", async () => {
  atoms.set(coachSelectionAtom, { connection: "conn-1", model: null, effort: null });
  const req = makeExplainRequest({ id: "req-no-model" });
  atoms.set(coachExplainRequestFamily(TAB), req);
  await render({ selected: false });

  expect(atoms.get(coachExplainRequestFamily(TAB))).toBeNull();
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(mocks.coachTurn).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Coach.Ask"]')?.value).toBe(
    req.question,
  );
});

test("O7 CoachPanel drops an already-expired explain request synchronously when settled", async () => {
  mocks.coachTurn.mockResolvedValue(answer);
  await render();

  const expired = makeExplainRequest({
    id: "req-expired-sync",
    clickedAt: Date.now() - COACH_EXPLAIN_REQUEST_MAX_AGE_MS - 1,
  });
  await act(async () => {
    atoms.set(coachExplainRequestFamily(TAB), expired);
  });

  expect(atoms.get(coachExplainRequestFamily(TAB))).toBeNull();
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  expect(mocks.coachTurn).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Coach.Ask"]')?.value).toBe(
    "",
  );
});

test("O7 CoachPanel opens the first-use notice when not yet accepted for the chosen connection", async () => {
  mocks.coachTurn.mockResolvedValue(answer);
  const req = makeExplainRequest();
  atoms.set(coachExplainRequestFamily(TAB), req);
  await render({ accepted: false });

  expect(atoms.get(coachExplainRequestFamily(TAB))).toBeNull();
  expect(mocks.prepareAnalysis).not.toHaveBeenCalled();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.textContent).toContain("Coach.Notice.Body:Ollama");

  // Accepting the notice sends the exact explain question once.
  await act(async () => button("Coach.Notice.Accept", dialog).click());
  await act(async () => {});
  expect(mocks.coachTurn).toHaveBeenCalledOnce();
  expect(mocks.coachTurn.mock.calls[0][2].message).toBe(req.question);
});
