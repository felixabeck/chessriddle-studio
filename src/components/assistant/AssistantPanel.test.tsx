import { MantineProvider } from "@mantine/core";
import { atom, createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AssistantTurnUpdate, CoachError, ConnectionSummary } from "@/bindings";
import { setHelpTopicsLoaderForTests } from "@/components/assistant/topics";
import {
  useAssistantErrorMessages,
  useCoachErrorMessages,
} from "@/components/settings/coach/useCoachErrorMessages";
import { settingsNavigationRequestAtom } from "@/state/settingsNavigation";
import enUS from "@/translation/en-US.json";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";

const mocks = vi.hoisted(() => ({
  coachConnections: vi.fn(),
  coachModels: vi.fn(),
  coachHasConnection: vi.fn(),
  prepareNativeRead: vi.fn(),
  cancelNativeRead: vi.fn(),
  assistantTurn: vi.fn(),
  coachOpenUsage: vi.fn(),
  navigate: vi.fn(),
  newTab: vi.fn(),
  openAccounts: vi.fn(),
  openEngines: vi.fn(),
  openSettings: vi.fn(),
  openFeedback: vi.fn(),
  logError: vi.fn(() => Promise.resolve()),
  engines: undefined as unknown[] | undefined,
  currentTab: { value: "t1", name: "Game", type: "analysis" } as Record<string, unknown> | null,
  pathname: "/",
  t: (key: string, options?: Record<string, unknown>) =>
    options && "provider" in options ? `${key}:${String(options.provider)}` : key,
}));

vi.mock("@/platform/tauri", () => ({ tauri: mocks }));
vi.mock("@/platform/native", () => ({
  platform: vi.fn(() => "linux"),
  warn: vi.fn(() => Promise.resolve()),
  error: mocks.logError,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: mocks.pathname } }),
}));
vi.mock("@/components/feedback/openFeedbackContext", () => ({
  useOpenFeedback: () => mocks.openFeedback,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => mocks.t(key, options),
    i18n: { language: "en-US" },
  }),
}));
vi.mock("@/state/atoms", async (original) => ({
  ...(await original<typeof import("@/state/atoms")>()),
  enginesAtom: atom(() => mocks.engines),
  currentTabAtom: atom(() => mocks.currentTab),
}));
vi.mock("@/state/coach", async (original) => ({
  ...(await original<typeof import("@/state/coach")>()),
  coachEnabledAtom: atom(true),
}));

const {
  assistantConversationAtom,
  assistantNoticeAcceptedAtom,
  assistantRunningTurnAtom,
  newAssistantConversation,
} = await import("@/state/assistant");
const { applyAssistantTurnEvent, resetAssistantTurnForTests } =
  await import("@/state/assistantTurns");
const { coachNoticeAcceptedAtom, coachSelectionAtom } = await import("@/state/coach");
const { default: AssistantPanel, sanitizeInstalledEngines } = await import("./AssistantPanel");
const { AssistantPanelHost } = await import("./AssistantPanelHost");

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

let host: HTMLDivElement;
let root: Root;
let atoms: ReturnType<typeof createStore>;

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
  resetAssistantTurnForTests();
  setHelpTopicsLoaderForTests(async () => [
    {
      id: "ai-connections",
      title: "AI",
      summary: "Connections",
      body: "Open {{label:Settings.AI}}",
    },
  ]);
  mocks.t = (key, options) =>
    options && "provider" in options ? `${key}:${String(options.provider)}` : key;
  mocks.engines = [{ type: "local", id: "e1", name: "Stockfish", loaded: true }];
  mocks.currentTab = { value: "t1", name: "Game", type: "analysis" };
  mocks.pathname = "/";
  mocks.logError.mockResolvedValue(undefined);
  mocks.coachConnections.mockResolvedValue([connection]);
  mocks.coachHasConnection.mockResolvedValue(true);
  mocks.coachModels.mockResolvedValue({
    models: [
      { id: "gpt-4o", name: "GPT-4o", effortLevels: [], defaultEffort: null, supportsTools: true },
    ],
    truncated: false,
  });
  mocks.prepareNativeRead.mockResolvedValue("ticket-1");
  mocks.cancelNativeRead.mockResolvedValue(undefined);
  Element.prototype.scrollTo = vi.fn();
  atoms = createStore();
  atoms.set(assistantConversationAtom, newAssistantConversation());
  atoms.set(assistantRunningTurnAtom, null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  resetAssistantTurnForTests();
  setHelpTopicsLoaderForTests(null);
});

async function renderPanel({ accepted = true } = {}) {
  atoms.set(coachSelectionAtom, { connection: "conn-1", model: "gpt-4o", effort: null });
  if (accepted) atoms.set(assistantNoticeAcceptedAtom, ["conn-1"]);
  await act(async () =>
    root.render(
      <Provider store={atoms}>
        <MantineProvider env="test">
          <AssistantPanel
            createNewTab={mocks.newTab}
            openAccounts={mocks.openAccounts}
            openEngines={mocks.openEngines}
            openSettings={mocks.openSettings}
          />
        </MantineProvider>
      </Provider>,
    ),
  );
  await act(async () => {});
}

function button(name: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === name || node.getAttribute("aria-label") === name,
  )!;
}

async function ask(text: string) {
  const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Assistant.Ask"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Coach.Send").click());
}

test("first question shows the Assistant notice even if Coach notice was accepted, and sends only after acceptance", async () => {
  atoms.set(coachNoticeAcceptedAtom, ["conn-1"]);
  mocks.assistantTurn.mockResolvedValue({
    type: "completed",
    segments: [{ type: "text", text: "Hello" }],
    feedbackDraft: null,
  });
  await renderPanel({ accepted: false });

  await ask("Where are settings?");
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Assistant.Notice.Body:Ollama");
  expect(mocks.prepareNativeRead).not.toHaveBeenCalled();

  await act(async () => button("Coach.Notice.Accept", dialog).click());
  await act(async () => {});
  expect(atoms.get(assistantNoticeAcceptedAtom)).toEqual(["conn-1"]);
  expect(mocks.assistantTurn).toHaveBeenCalledOnce();
});

test("streamed text renders, finished links use registry labels, and clicking links opens targets and prefilled feedback", async () => {
  const command = deferred<AssistantTurnUpdate>();
  mocks.assistantTurn.mockReturnValue(command.promise);
  await renderPanel();

  await ask("How do I report a bug?");
  await vi.waitFor(() => expect(mocks.assistantTurn).toHaveBeenCalledOnce());
  const [turnId] = mocks.assistantTurn.mock.calls[0];

  await act(async () =>
    applyAssistantTurnEvent(atoms, {
      turn: turnId,
      update: { type: "text", delta: "Streaming..." },
    }),
  );
  expect(host.querySelector('[data-testid="assistant-running"]')?.textContent).toContain(
    "Streaming...",
  );

  await act(async () =>
    command.resolve({
      type: "completed",
      segments: [
        { type: "text", text: "Check " },
        { type: "link", target: "setting:coach-engine" },
        { type: "text", text: " or " },
        { type: "link", target: "feedback" },
      ],
      feedbackDraft: { feedbackType: "bug", message: "Engine list did not refresh." },
    }),
  );

  const links = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="assistant-link"]')];
  expect(links).toHaveLength(2);
  expect(links[0].textContent).toBe("Settings.Coach.Engine");
  expect(links[1].textContent).toBe("Menu.Help.SendFeedback");

  await act(async () => links[0].click());
  expect(atoms.get(settingsNavigationRequestAtom)?.target).toEqual({
    kind: "setting",
    settingId: "coach-engine",
  });
  expect(mocks.openSettings).toHaveBeenCalledOnce();

  await act(async () => links[1].click());
  expect(mocks.openFeedback).toHaveBeenCalledExactlyOnceWith({
    type: "bug",
    message: "Engine list did not refresh.",
  });
});

test("panel load failure shows retry in place, keeps shell mounted, and retry loads the panel", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let attempts = 0;
  const loadPanel = vi.fn(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("chunk load failed");
    return {
      default: () => <div data-testid="loaded-assistant">Ready</div>,
    };
  });

  try {
    await act(async () =>
      root.render(
        <MantineProvider env="test">
          <div data-testid="shell-content">Shell stays mounted</div>
          <AssistantPanelHost
            opened
            onClose={() => undefined}
            createNewTab={mocks.newTab}
            openAccounts={mocks.openAccounts}
            openEngines={mocks.openEngines}
            openSettings={mocks.openSettings}
            loadPanel={loadPanel}
          />
        </MantineProvider>,
      ),
    );
    await vi.waitFor(() => expect(host.textContent).toContain("Assistant.LoadFailed"));
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining("Assistant panel failed to load"),
    );
    expect(host.querySelector('[data-testid="shell-content"]')?.textContent).toBe(
      "Shell stays mounted",
    );

    await act(async () => button("Common.Retry", host).click());
    await act(async () => {});
    expect(loadPanel).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[data-testid="loaded-assistant"]')?.textContent).toBe("Ready");
  } finally {
    errorSpy.mockRestore();
  }
});

test("every CoachError code has an Assistant text in en-US and the six named codes differ from Coach", async () => {
  const catalogue = enUS.translation as Record<string, string>;
  mocks.t = (key) => catalogue[key] ?? "";

  let coachMap!: Record<CoachError, string>;
  let assistantMap!: Record<CoachError, string>;
  function Probe() {
    coachMap = useCoachErrorMessages();
    assistantMap = useAssistantErrorMessages();
    return null;
  }

  await act(async () => root.render(<Probe />));

  const allCodes = Object.keys(coachMap) as CoachError[];
  expect(allCodes.length).toBeGreaterThan(0);
  for (const code of allCodes) {
    expect(assistantMap[code]).toBeTruthy();
  }

  const assistantSpecific: CoachError[] = [
    "busy",
    "limitExceeded",
    "unavailable",
    "invalidInput",
    "noFunctionCalling",
    "engineFailed",
  ];
  for (const code of assistantSpecific) {
    expect(assistantMap[code]).not.toBe(coachMap[code]);
  }
});

test("sanitizeInstalledEngines strips control chars, trims, truncates by code points, drops empties, and caps count", () => {
  expect(sanitizeInstalledEngines(undefined)).toBeUndefined();

  const astral = "🚀".repeat(130);
  const raw = [
    { name: "  Stock\nfish\t17\u0000\u007f  " },
    { name: " \r\n\t " },
    { name: astral },
    ...Array.from({ length: 70 }, (_, i) => ({ name: `Engine ${i}` })),
  ];
  const result = sanitizeInstalledEngines(raw)!;
  expect(result).toHaveLength(64);
  expect(result[0]).toBe("Stockfish17");
  expect(Array.from(result[1])).toHaveLength(128);
  expect(result[1]).toBe("🚀".repeat(128));
  expect(result[2]).toBe("Engine 0");
});

test("turn context passes undefined installedEngines when unread, page kind, and boardTabKind", async () => {
  mocks.engines = undefined;
  mocks.pathname = "/";
  mocks.currentTab = { value: "t1", name: "Game", type: "analysis" };
  mocks.assistantTurn.mockResolvedValue({
    type: "completed",
    segments: [{ type: "text", text: "Done" }],
    feedbackDraft: null,
  });
  await renderPanel();

  await ask("Where am I?");
  await vi.waitFor(() => expect(mocks.assistantTurn).toHaveBeenCalledOnce());
  expect(mocks.assistantTurn.mock.calls[0][2].context).toEqual({
    page: "board",
    boardTabKind: "analysis",
    language: "en-US",
    installedEngines: undefined,
    referenceDatabase: false,
  });

  // On a non-board page, boardTabKind is null.
  mocks.pathname = "/settings";
  mocks.prepareNativeRead.mockResolvedValue("ticket-2");
  await renderPanel();
  await ask("And now?");
  await vi.waitFor(() => expect(mocks.assistantTurn).toHaveBeenCalledTimes(2));
  expect(mocks.assistantTurn.mock.calls[1][2].context).toEqual({
    page: "settings",
    boardTabKind: null,
    language: "en-US",
    installedEngines: undefined,
    referenceDatabase: false,
  });

  // On the Guide page, page kind is "guide".
  mocks.pathname = "/guide";
  mocks.prepareNativeRead.mockResolvedValue("ticket-3");
  await renderPanel();
  await ask("What is on this page?");
  await vi.waitFor(() => expect(mocks.assistantTurn).toHaveBeenCalledTimes(3));
  expect(mocks.assistantTurn.mock.calls[2][2].context).toEqual({
    page: "guide",
    boardTabKind: null,
    language: "en-US",
    installedEngines: undefined,
    referenceDatabase: false,
  });
});

test("transcript renders Assistant.Error.TopicsLoadFailed when help topics fail to load", async () => {
  setHelpTopicsLoaderForTests(async () => {
    throw new Error("chunk failed");
  });
  await renderPanel();

  await ask("Help?");
  await vi.waitFor(() =>
    expect(host.querySelector('[data-testid="assistant-answer"]')?.textContent).toContain(
      "Assistant.Error.TopicsLoadFailed",
    ),
  );
  expect(mocks.assistantTurn).not.toHaveBeenCalled();
});
