import { MantineProvider } from "@mantine/core";
import { atom, createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildAssistantTargets } from "@/components/assistant/targets";
import {
  HELP_TOPIC_GROUPS,
  HELP_TOPIC_ORDER,
  setHelpTopicsLoaderForTests,
  type TopicBundleLoader,
} from "@/components/assistant/topics";
import { rawHelpTopics } from "@/components/assistant/topics/bundle";
import { settingsNavigationRequestAtom } from "@/state/settingsNavigation";
import enUS from "@/translation/en-US.json";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";

const enCatalogue = enUS.translation as Record<string, string>;

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  newTab: vi.fn(),
  showPageTab: vi.fn(),
  openFeedback: vi.fn(),
  notificationsShow: vi.fn(),
  logError: vi.fn(() => Promise.resolve()),
  logFailureSafely: vi.fn(),
  coachEnabled: true,
  language: "en-US",
  t: (key: string, _options?: Record<string, string>) => key,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/components/tabs/TabCommands", () => ({
  useTabCommands: () => ({ newTab: mocks.newTab, showPageTab: mocks.showPageTab }),
}));
vi.mock("@/components/feedback/openFeedbackContext", () => ({
  useOpenFeedback: () => mocks.openFeedback,
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notificationsShow },
}));
vi.mock("@/platform/native", () => ({
  platform: vi.fn(() => "linux"),
  warn: vi.fn(() => Promise.resolve()),
  error: mocks.logError,
}));
vi.mock("@/platform/errors", async (original) => {
  const actual = await original<typeof import("@/platform/errors")>();
  return {
    ...actual,
    logFailureSafely: (...args: Parameters<typeof actual.logFailureSafely>) => {
      mocks.logFailureSafely(...args);
      return actual.logFailureSafely(...args);
    },
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => mocks.t(key, options),
    i18n: {
      language: mocks.language,
      resolvedLanguage: mocks.language,
    },
  }),
}));
vi.mock("@/state/coach", async (original) => ({
  ...(await original<typeof import("@/state/coach")>()),
  coachEnabledAtom: atom(() => mocks.coachEnabled),
}));

const { default: GuidePage } = await import("./GuidePage");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

let host: HTMLDivElement;
let root: Root;
let atoms: ReturnType<typeof createStore>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderGuide() {
  await act(async () =>
    root.render(
      <Provider store={atoms}>
        <MantineProvider env="test">
          <GuidePage />
        </MantineProvider>
      </Provider>,
    ),
  );
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  setHelpTopicsLoaderForTests(null);
  mocks.coachEnabled = true;
  mocks.language = "en-US";
  mocks.t = (key: string, options?: Record<string, string>) => {
    const template = enCatalogue[key] ?? key;
    if (!options) return template;
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options[name] ?? "");
  };
  mocks.navigate.mockResolvedValue(undefined);
  mocks.showPageTab.mockResolvedValue(undefined);
  mocks.logError.mockResolvedValue(undefined);
  atoms = createStore();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setHelpTopicsLoaderForTests(null);
});

test("reading order covers every shipped topic once and topic switching changes the visible panel", async () => {
  expect(new Set(HELP_TOPIC_ORDER).size).toBe(HELP_TOPIC_ORDER.length);
  expect([...HELP_TOPIC_ORDER].sort()).toEqual(rawHelpTopics.map((t) => t.id).sort());

  await renderGuide();

  const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"][data-topic-id]')];
  expect(tabs.map((tab) => tab.dataset.topicId)).toEqual([...HELP_TOPIC_ORDER]);

  const activePanel = () =>
    host.querySelector<HTMLElement>('[role="tabpanel"]:not([style*="display: none"])');
  expect(activePanel()?.dataset.topicPanel).toBe(HELP_TOPIC_ORDER[0]);
  expect(activePanel()?.textContent).toContain("Tabs and the New tab page");

  const feedbackTab = host.querySelector<HTMLButtonElement>(
    '[role="tab"][data-topic-id="feedback"]',
  )!;
  await act(async () => {
    feedbackTab.click();
  });
  expect(activePanel()?.dataset.topicPanel).toBe("feedback");
  expect(activePanel()?.textContent).toContain("Feedback, logs, clearing saved data, and updates");
});

test("sidebar renders group headings in order, each tab has an emoji, and Next navigates sequentially", async () => {
  await renderGuide();

  const groupHeadings = [...host.querySelectorAll<HTMLElement>("[data-guide-group]")];
  expect(groupHeadings.map((heading) => heading.dataset.guideGroup)).toEqual(
    HELP_TOPIC_GROUPS.map((group) => group.id),
  );
  expect(groupHeadings.map((heading) => heading.textContent)).toEqual([
    enCatalogue["Guide.Group.Basics"],
    enCatalogue["Guide.Group.Databases"],
    enCatalogue["Guide.Group.Training"],
    enCatalogue["Guide.Group.Accounts"],
    enCatalogue["Guide.Group.App"],
  ]);

  // Headings and tabs interleave: each group heading is followed by exactly its own topics.
  const sidebarSequence = [
    ...host.querySelectorAll<HTMLElement>('[data-guide-group], [role="tab"][data-topic-id]'),
  ].map((node) => node.dataset.guideGroup ?? node.dataset.topicId);
  expect(sidebarSequence).toEqual(
    HELP_TOPIC_GROUPS.flatMap((group) => [group.id, ...group.topics.map(({ id }) => id)]),
  );

  const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"][data-topic-id]')];
  expect(tabs).toHaveLength(HELP_TOPIC_ORDER.length);
  const tabsMissingEmoji = tabs
    .filter((tab) => {
      const emojiText = tab.querySelector("[aria-hidden='true']")?.textContent?.trim() ?? "";
      return emojiText.length === 0;
    })
    .map((tab) => tab.dataset.topicId);
  expect(tabsMissingEmoji).toEqual([]);

  const activePanel = () =>
    host.querySelector<HTMLElement>('[role="tabpanel"]:not([style*="display: none"])');

  // Verify the Next button on every topic except the last, and click through sequentially.
  for (let index = 0; index < HELP_TOPIC_ORDER.length - 1; index++) {
    const currentId = HELP_TOPIC_ORDER[index];
    expect(activePanel()?.dataset.topicPanel).toBe(currentId);
    const panel = activePanel()!;
    const nextTabId = HELP_TOPIC_ORDER[index + 1];
    const nextButton = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((btn) =>
      btn.textContent?.startsWith("Next:"),
    );

    const nextTabTitle = host.querySelector<HTMLElement>(
      `[role="tab"][data-topic-id="${nextTabId}"] .mantine-Tabs-tabLabel`,
    )!.textContent!;
    expect(nextButton?.textContent).toBe(`Next: ${nextTabTitle}`);

    await act(async () => {
      nextButton!.click();
    });
    expect(activePanel()?.dataset.topicPanel).toBe(nextTabId);
    expect(activePanel()?.querySelector("h2")?.textContent).toBe(nextTabTitle);
  }

  // Last topic has no Next button.
  const lastPanel = activePanel()!;
  expect(lastPanel.dataset.topicPanel).toBe(HELP_TOPIC_ORDER[HELP_TOPIC_ORDER.length - 1]);
  const lastNextButton = [...lastPanel.querySelectorAll<HTMLButtonElement>("button")].find((btn) =>
    btn.textContent?.startsWith("Next:"),
  );
  expect(lastNextButton).toBeUndefined();
});

test.each([true, false])(
  "every topic renders with no raw tokens or target ids when coachEnabled is %s",
  async (coachEnabled) => {
    mocks.coachEnabled = coachEnabled;
    await renderGuide();

    const fullRegistry = buildAssistantTargets(mocks.t, {
      platform: import.meta.env.VITE_PLATFORM as string | undefined,
      coachEnabled: true,
    });
    const prefixedTargetIds = [...fullRegistry.keys()].filter((id) => id.includes(":"));

    const leaks: string[] = [];
    for (const topicId of HELP_TOPIC_ORDER) {
      const tab = host.querySelector<HTMLButtonElement>(
        `[role="tab"][data-topic-id="${topicId}"]`,
      )!;
      await act(async () => {
        tab.click();
      });
      const panel = host.querySelector<HTMLElement>(
        `[role="tabpanel"][data-topic-panel="${topicId}"]`,
      )!;
      const text = panel.textContent ?? "";
      if (text.includes("[[")) leaks.push(`${topicId}: [[`);
      if (text.includes("{{label:")) leaks.push(`${topicId}: {{label:`);
      for (const targetId of prefixedTargetIds) {
        if (text.includes(targetId)) leaks.push(`${topicId}: ${targetId}`);
      }
    }
    expect(leaks).toEqual([]);
  },
);

test("unavailable target renders as plain label text and duplicate parenthetical is suppressed", async () => {
  mocks.coachEnabled = false;
  await renderGuide();

  const aiTab = host.querySelector<HTMLButtonElement>(
    '[role="tab"][data-topic-id="ai-connections"]',
  )!;
  await act(async () => {
    aiTab.click();
  });

  const panel = host.querySelector<HTMLElement>(
    '[role="tabpanel"][data-topic-panel="ai-connections"]',
  )!;
  const links = [...panel.querySelectorAll<HTMLButtonElement>('[data-testid="assistant-link"]')];
  const linkTargets = links.map((link) => link.dataset.targetId);

  expect(linkTargets).not.toContain("settings-category:coach");
  expect(linkTargets).not.toContain("setting:coach-engine");
  expect(linkTargets).toContain("page:engines");

  const aiLabel = enCatalogue["Settings.AI"];
  expect(panel.textContent).toContain(`Manage your connections in ${aiLabel}.`);
  expect(panel.textContent).not.toContain(`${aiLabel} (${aiLabel})`);

  // Non-duplicate parentheticals like `Repertoire (Practice Grading, New cards per session)` remain.
  const repertoiresTab = host.querySelector<HTMLButtonElement>(
    '[role="tab"][data-topic-id="repertoires"]',
  )!;
  await act(async () => {
    repertoiresTab.click();
  });
  const repertoiresPanel = host.querySelector<HTMLElement>(
    '[role="tabpanel"][data-topic-panel="repertoires"]',
  )!;
  expect(repertoiresPanel.textContent).toContain(
    `(${enCatalogue["Settings.Repertoire.Grading"]}, ${enCatalogue["Settings.Repertoire.NewPerSession"]})`,
  );
});

test("clicking links runs through the shared target actions hook and reports link rejections safely", async () => {
  await renderGuide();

  const tabsPanel = host.querySelector<HTMLElement>(
    '[role="tabpanel"][data-topic-panel="tabs-and-new-tab"]',
  )!;
  const newTabLink = tabsPanel.querySelector<HTMLButtonElement>(
    '[data-testid="assistant-link"][data-target-id="page:new-tab"]',
  )!;
  const libraryLink = tabsPanel.querySelector<HTMLButtonElement>(
    '[data-testid="assistant-link"][data-target-id="page:library"]',
  )!;
  const accountsLink = tabsPanel.querySelector<HTMLButtonElement>(
    '[data-testid="assistant-link"][data-target-id="page:accounts"]',
  )!;
  const enginesLink = tabsPanel.querySelector<HTMLButtonElement>(
    '[data-testid="assistant-link"][data-target-id="page:engines"]',
  )!;
  const settingsLink = tabsPanel.querySelector<HTMLButtonElement>(
    '[data-testid="assistant-link"][data-target-id="page:settings"]',
  )!;

  await act(async () => {
    newTabLink.click();
    libraryLink.click();
    accountsLink.click();
    enginesLink.click();
    settingsLink.click();
  });

  expect(mocks.newTab).toHaveBeenCalledOnce();
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/library" });
  expect(mocks.showPageTab).toHaveBeenCalledWith("accounts");
  expect(mocks.showPageTab).toHaveBeenCalledWith("engines");
  expect(mocks.showPageTab).toHaveBeenCalledWith("settings");

  // Setting link sets the navigation request atom and opens Settings.
  const aiTab = host.querySelector<HTMLButtonElement>(
    '[role="tab"][data-topic-id="ai-connections"]',
  )!;
  await act(async () => {
    aiTab.click();
  });
  const aiPanel = host.querySelector<HTMLElement>(
    '[role="tabpanel"][data-topic-panel="ai-connections"]',
  )!;
  const coachEngineLink = aiPanel.querySelector<HTMLButtonElement>(
    '[data-testid="assistant-link"][data-target-id="setting:coach-engine"]',
  )!;
  await act(async () => {
    coachEngineLink.click();
  });
  expect(atoms.get(settingsNavigationRequestAtom)?.target).toEqual({
    kind: "setting",
    settingId: "coach-engine",
  });

  // Rejected open reports through notifyUnlessCancelled with no unhandled rejection.
  const unhandled: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled.push(event.reason);
  };
  window.addEventListener("unhandledrejection", onUnhandled);
  try {
    mocks.showPageTab.mockRejectedValueOnce(new Error("route failed"));
    await act(async () => {
      settingsLink.click();
    });
    await act(async () => {});

    expect(mocks.notificationsShow).toHaveBeenCalledWith(
      expect.objectContaining({
        color: "danger",
        message: "route failed",
      }),
    );
    expect(unhandled).toEqual([]);
  } finally {
    window.removeEventListener("unhandledrejection", onUnhandled);
  }
});

test("locale load failure logs once with resolved locale, shows retry, and retry succeeds", async () => {
  mocks.t = (key: string) => key;
  mocks.language = "de";
  let attempts = 0;
  const loader: TopicBundleLoader = vi.fn(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("chunk unavailable");
    }
    return [
      {
        id: "tabs-and-new-tab",
        title: "Tabs DE",
        summary: "Summary DE",
        body: "Body DE",
      },
    ];
  });
  setHelpTopicsLoaderForTests(loader);

  await renderGuide();

  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("Guide.LoadFailed");
  expect(mocks.logFailureSafely).toHaveBeenCalledTimes(1);
  expect(mocks.logFailureSafely).toHaveBeenCalledWith(
    expect.stringContaining("de-DE"),
    expect.objectContaining({
      operation: "guide-topics-load",
      item: "de-DE",
    }),
    "guide-topics-load",
  );
  expect(mocks.logError).toHaveBeenCalledTimes(1);
  expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining("de-DE"));

  const retryButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (btn) => btn.textContent === "Common.Retry",
  )!;
  await act(async () => {
    retryButton.click();
  });
  await act(async () => {});

  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("Tabs DE");
  expect(mocks.logFailureSafely).toHaveBeenCalledTimes(1);
});

test("stale resolutions and stale rejections are discarded without state change or log", async () => {
  mocks.t = (key: string) => key;
  const firstRequest =
    deferred<readonly { id: string; title: string; summary: string; body: string }[]>();
  const secondRequest =
    deferred<readonly { id: string; title: string; summary: string; body: string }[]>();
  const thirdRequest =
    deferred<readonly { id: string; title: string; summary: string; body: string }[]>();

  mocks.language = "de-DE";
  setHelpTopicsLoaderForTests((locale) => {
    if (locale === "de-DE") return firstRequest.promise;
    if (locale === "fr-FR") return secondRequest.promise;
    return thirdRequest.promise;
  });

  await renderGuide();

  // Locale changes to fr-FR while de-DE is still pending.
  mocks.language = "fr-FR";
  await renderGuide();

  // Resolve fr-FR first, then resolve stale de-DE: stale de-DE must not overwrite fr-FR.
  await act(async () => {
    secondRequest.resolve([
      { id: "tabs-and-new-tab", title: "Fresh FR", summary: "Sum FR", body: "Body FR" },
    ]);
  });
  await act(async () => {
    firstRequest.resolve([
      { id: "tabs-and-new-tab", title: "Stale DE", summary: "Sum DE", body: "Body DE" },
    ]);
  });
  expect(host.textContent).toContain("Fresh FR");
  expect(host.textContent).not.toContain("Stale DE");

  // Switch to es-ES (pending), then switch to it-IT (resolved), then reject stale es-ES:
  // stale rejection must not show error or log.
  const fourthRequest =
    deferred<readonly { id: string; title: string; summary: string; body: string }[]>();
  setHelpTopicsLoaderForTests((locale) => {
    if (locale === "es-ES") return thirdRequest.promise;
    return fourthRequest.promise;
  });
  mocks.language = "es-ES";
  await renderGuide();

  mocks.language = "it-IT";
  await renderGuide();

  await act(async () => {
    fourthRequest.resolve([
      { id: "tabs-and-new-tab", title: "Fresh IT", summary: "Sum IT", body: "Body IT" },
    ]);
  });
  await act(async () => {
    thirdRequest.reject(new Error("stale es-ES failure"));
  });

  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("Fresh IT");
  expect(mocks.logFailureSafely).not.toHaveBeenCalled();
  expect(mocks.logError).not.toHaveBeenCalled();

  // Unmount while a request is pending, then reject: must not log.
  const unmountRequest =
    deferred<readonly { id: string; title: string; summary: string; body: string }[]>();
  setHelpTopicsLoaderForTests(() => unmountRequest.promise);
  mocks.language = "pt-PT";
  await renderGuide();

  await act(async () => root.unmount());
  root = createRoot(host);

  await act(async () => {
    unmountRequest.reject(new Error("unmounted failure"));
  });
  expect(mocks.logFailureSafely).not.toHaveBeenCalled();
  expect(mocks.logError).not.toHaveBeenCalled();
});

test("each tab and panel header shows its topic emoji and each tab carries its group accent", async () => {
  await renderGuide();

  const observed = HELP_TOPIC_GROUPS.flatMap((group) =>
    group.topics.map(({ id }) => {
      const tab = host.querySelector<HTMLButtonElement>(`[role="tab"][data-topic-id="${id}"]`)!;
      const tabEmoji = tab.querySelector<HTMLElement>('[aria-hidden="true"]')?.textContent ?? null;
      const tabAccent = tab.style.getPropertyValue("--sidebar-accent");
      const panelHeading = host.querySelector<HTMLElement>(
        `[role="tabpanel"][data-topic-panel="${id}"] h2`,
      );
      const headerEmojiEl = panelHeading?.previousElementSibling;
      const panelEmoji =
        headerEmojiEl?.getAttribute("aria-hidden") === "true" ? headerEmojiEl.textContent : null;
      return {
        id,
        tabEmoji,
        tabAccent,
        panelEmoji,
      };
    }),
  );

  const expected = HELP_TOPIC_GROUPS.flatMap((group) =>
    group.topics.map(({ id, emoji }) => ({
      id,
      tabEmoji: emoji,
      tabAccent: `var(--cf-${group.accent})`,
      panelEmoji: emoji,
    })),
  );

  expect(observed).toEqual(expected);
});

test("switching topics scrolls the content back to the top", async () => {
  await renderGuide();

  const viewport = host.querySelector<HTMLElement>(".mantine-ScrollArea-viewport")!;
  expect(viewport).not.toBeNull();
  let scrollTop = 600;
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });

  const nextButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((btn) =>
    btn.textContent?.startsWith("Next:"),
  )!;
  await act(async () => {
    nextButton.click();
  });
  expect(scrollTop).toBe(0);

  scrollTop = 450;
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[role="tab"][data-topic-id="feedback"]')!.click();
  });
  expect(scrollTop).toBe(0);
});
