import { MantineProvider } from "@mantine/core";
import { createStore } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { buildAssistantTargets, type AssistantTargetActions } from "./targets";

const mocks = vi.hoisted(() => ({
  notificationsShow: vi.fn(),
  t: (key: string) => key,
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: mocks.notificationsShow },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => mocks.t(key),
  }),
}));

const { AssistantTargetLink } = await import("./AssistantTargetLink");
const { AssistantTranscript } = await import("./AssistantTranscript");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

let host: HTMLDivElement;
let root: Root;

function createActions(overrides: Partial<AssistantTargetActions> = {}): AssistantTargetActions {
  return {
    createNewTab: vi.fn(),
    openLibrary: vi.fn(),
    openEngines: vi.fn(),
    openAccounts: vi.fn(),
    openSettings: vi.fn(),
    openFeedback: vi.fn(),
    store: createStore(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("AssistantTargetLink reports rejected open via notifyUnlessCancelled with no unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled.push(event.reason);
  };
  window.addEventListener("unhandledrejection", onUnhandled);

  try {
    const targets = buildAssistantTargets(mocks.t, { platform: "linux", coachEnabled: true });
    const entry = targets.get("page:settings")!;
    const actions = createActions({
      openSettings: vi.fn().mockRejectedValue(new Error("navigation failed")),
    });

    await act(async () =>
      root.render(
        <MantineProvider env="test">
          <AssistantTargetLink entry={entry} actions={actions} />
        </MantineProvider>,
      ),
    );

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="assistant-link"]')!.click();
    });
    await act(async () => {});

    expect(mocks.notificationsShow).toHaveBeenCalledWith(
      expect.objectContaining({
        color: "danger",
        title: "Common.Error",
        message: "navigation failed",
      }),
    );
    expect(unhandled).toEqual([]);
  } finally {
    window.removeEventListener("unhandledrejection", onUnhandled);
  }
});

test("AssistantTranscript link ignores Cancellation and reports non-cancellation rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    unhandled.push(event.reason);
  };
  window.addEventListener("unhandledrejection", onUnhandled);

  try {
    const targets = buildAssistantTargets(mocks.t, { platform: "linux", coachEnabled: true });
    const openEngines = vi
      .fn()
      .mockRejectedValueOnce(new Error("Cancellation"))
      .mockRejectedValueOnce(new Error("engines unreachable"));
    const actions = createActions({ openEngines });

    await act(async () =>
      root.render(
        <MantineProvider env="test">
          <AssistantTranscript
            messages={[
              {
                id: "m1",
                role: "assistant",
                state: "completed",
                segments: [
                  { type: "text", text: "Open " },
                  { type: "link", target: "page:engines" },
                ],
                feedbackDraft: null,
              },
            ]}
            running={null}
            targets={targets}
            targetActions={actions}
          />
        </MantineProvider>,
      ),
    );

    const button = host.querySelector<HTMLButtonElement>('[data-testid="assistant-link"]')!;
    await act(async () => {
      button.click();
    });
    await act(async () => {});
    expect(mocks.notificationsShow).not.toHaveBeenCalled();

    await act(async () => {
      button.click();
    });
    await act(async () => {});
    expect(mocks.notificationsShow).toHaveBeenCalledWith(
      expect.objectContaining({
        color: "danger",
        title: "Common.Error",
        message: "engines unreachable",
      }),
    );
    expect(unhandled).toEqual([]);
  } finally {
    window.removeEventListener("unhandledrejection", onUnhandled);
  }
});

test("AssistantTargetLink reports synchronous throws from open via notifyUnlessCancelled", async () => {
  const targets = buildAssistantTargets(mocks.t, { platform: "linux", coachEnabled: true });
  const entry = targets.get("page:settings")!;
  const actions = createActions({
    openSettings: vi.fn(() => {
      throw new Error("sync failure");
    }),
  });

  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <AssistantTargetLink entry={entry} actions={actions} />
      </MantineProvider>,
    ),
  );

  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="assistant-link"]')!.click();
  });

  expect(mocks.notificationsShow).toHaveBeenCalledWith(
    expect.objectContaining({
      color: "danger",
      title: "Common.Error",
      message: "sync failure",
    }),
  );
});
