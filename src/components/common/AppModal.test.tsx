import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { dispatchEscape } from "@/tests/keyboard";
import AppModal from "./AppModal";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (value: string) => value }) }));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installMatchMediaStub();
  installResizeObserverStub();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

test("pending work hides the close button regardless of the caller default", async () => {
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened pending onClose={vi.fn()} title="Pending" />
      </MantineProvider>,
    );
  });

  expect(host.querySelector('button[aria-label="Common.Close"]')).toBeNull();

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened onClose={vi.fn()} title="Ready" />
      </MantineProvider>,
    );
  });
  expect(host.querySelector('button[aria-label="Common.Close"]')).not.toBeNull();
});

test("pending work refuses Escape and outside-click dismissal", async () => {
  const onClose = vi.fn();

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened pending onClose={onClose} title="Pending">
          <button type="button">Inside</button>
        </AppModal>
      </MantineProvider>,
    );
  });

  const pendingOverlay = host.querySelector<HTMLElement>(".mantine-Modal-overlay");
  expect(pendingOverlay).not.toBeNull();
  await act(async () => {
    pendingOverlay?.click();
  });
  dispatchEscape(host.querySelector("button") ?? document.body);
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened onClose={onClose} title="Ready">
          <button type="button">Inside</button>
        </AppModal>
      </MantineProvider>,
    );
  });

  const readyOverlay = host.querySelector<HTMLElement>(".mantine-Modal-overlay");
  await act(async () => {
    readyOverlay?.click();
  });
  expect(onClose).toHaveBeenCalledTimes(1);

  dispatchEscape(host.querySelector("button") ?? document.body);
  expect(onClose).toHaveBeenCalledTimes(2);
});

test("plain Escape closes while defaultPrevented, stopped, composing, and marked targets do not", async () => {
  const onClose = vi.fn();

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened onClose={onClose} title="Dialog">
          <button
            type="button"
            data-testid="prevent"
            onKeyDown={(event) => {
              event.preventDefault();
            }}
          >
            Prevent
          </button>
          <button
            type="button"
            data-testid="stop"
            onKeyDown={(event) => {
              event.stopPropagation();
            }}
          >
            Stop
          </button>
          <input data-testid="marked" data-mantine-stop-propagation="true" />
          <button type="button" data-testid="plain">
            Plain
          </button>
        </AppModal>
      </MantineProvider>,
    );
  });

  const preventBtn = host.querySelector<HTMLButtonElement>('[data-testid="prevent"]')!;
  const stopBtn = host.querySelector<HTMLButtonElement>('[data-testid="stop"]')!;
  const markedInput = host.querySelector<HTMLInputElement>('[data-testid="marked"]')!;
  const plainBtn = host.querySelector<HTMLButtonElement>('[data-testid="plain"]')!;

  dispatchEscape(preventBtn);
  dispatchEscape(stopBtn);
  dispatchEscape(markedInput);
  dispatchEscape(plainBtn, { isComposing: true });
  dispatchEscape(plainBtn, { keyCode: 229 });
  expect(onClose).not.toHaveBeenCalled();

  dispatchEscape(plainBtn);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("non-Escape keydown on window or body does not call onClose", async () => {
  const onClose = vi.fn();

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened onClose={onClose} title="Dialog">
          <div>Body</div>
        </AppModal>
      </MantineProvider>,
    );
  });

  dispatchEscape(window, { key: "Enter" });
  dispatchEscape(document.body, { key: "Enter" });
  expect(onClose).not.toHaveBeenCalled();
});

test("a mounted dialog with opened={false} does not call onClose on Escape", async () => {
  const onClose = vi.fn();

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened={false} onClose={onClose} title="Closed">
          <div>Body</div>
        </AppModal>
      </MantineProvider>,
    );
  });

  dispatchEscape(document.body);
  expect(onClose).not.toHaveBeenCalled();
});

test("updates and cleans up the window Escape listener across onClose and unmount", async () => {
  const firstClose = vi.fn();
  const secondClose = vi.fn();

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened onClose={firstClose} title="Dialog">
          <button type="button">Action</button>
        </AppModal>
      </MantineProvider>,
    );
  });

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened onClose={secondClose} title="Dialog">
          <button type="button">Action</button>
        </AppModal>
      </MantineProvider>,
    );
  });

  dispatchEscape(host.querySelector("button") ?? document.body);
  expect(firstClose).not.toHaveBeenCalled();
  expect(secondClose).toHaveBeenCalledTimes(1);

  await act(async () => {
    root.unmount();
  });
  dispatchEscape(document.body);
  expect(secondClose).toHaveBeenCalledTimes(1);
});

test("nested open modals close one at a time on Escape, topmost first", async () => {
  const outerClose = vi.fn();
  const innerClose = vi.fn();

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened onClose={outerClose} title="Outer">
          <AppModal opened onClose={innerClose} title="Inner">
            <div>Inner body</div>
          </AppModal>
        </AppModal>
      </MantineProvider>,
    );
  });

  const firstEvent = dispatchEscape(document.body);
  expect(firstEvent.defaultPrevented).toBe(true);
  expect(innerClose).toHaveBeenCalledTimes(1);
  expect(outerClose).not.toHaveBeenCalled();

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened onClose={outerClose} title="Outer">
          <div>Outer body</div>
        </AppModal>
      </MantineProvider>,
    );
  });

  const secondEvent = dispatchEscape(document.body);
  expect(secondEvent.defaultPrevented).toBe(true);
  expect(outerClose).toHaveBeenCalledTimes(1);
});

test("pending modal on top of an open modal blocks Escape from dismissing the modal underneath", async () => {
  const underClose = vi.fn();
  const topClose = vi.fn();

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened onClose={underClose} title="Under">
          <div>Under</div>
        </AppModal>
        <AppModal opened={false} pending onClose={topClose} title="Top">
          <div>Top</div>
        </AppModal>
      </MantineProvider>,
    );
  });

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened onClose={underClose} title="Under">
          <div>Under</div>
        </AppModal>
        <AppModal opened pending onClose={topClose} title="Top">
          <div>Top</div>
        </AppModal>
      </MantineProvider>,
    );
  });

  const event = dispatchEscape(document.body);
  expect(event.defaultPrevented).toBe(true);
  expect(topClose).not.toHaveBeenCalled();
  expect(underClose).not.toHaveBeenCalled();
});

test("a root-level modal opened after a nested pair closes before the nested pair on Escape", async () => {
  const outerClose = vi.fn();
  const innerClose = vi.fn();
  const rootClose = vi.fn();

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened onClose={outerClose} title="Outer">
          <AppModal opened onClose={innerClose} title="Inner">
            <div>Inner</div>
          </AppModal>
        </AppModal>
        <AppModal opened={false} onClose={rootClose} title="Root">
          <div>Root</div>
        </AppModal>
      </MantineProvider>,
    );
  });

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened onClose={outerClose} title="Outer">
          <AppModal opened onClose={innerClose} title="Inner">
            <div>Inner</div>
          </AppModal>
        </AppModal>
        <AppModal opened onClose={rootClose} title="Root">
          <div>Root</div>
        </AppModal>
      </MantineProvider>,
    );
  });

  dispatchEscape(document.body);
  expect(rootClose).toHaveBeenCalledTimes(1);
  expect(innerClose).not.toHaveBeenCalled();
  expect(outerClose).not.toHaveBeenCalled();
});

test("two sibling modals opened in sequence close the later one first on Escape", async () => {
  const firstClose = vi.fn();
  const secondClose = vi.fn();

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened onClose={firstClose} title="First">
          <div>First</div>
        </AppModal>
        <AppModal opened={false} onClose={secondClose} title="Second">
          <div>Second</div>
        </AppModal>
      </MantineProvider>,
    );
  });

  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <AppModal opened onClose={firstClose} title="First">
          <div>First</div>
        </AppModal>
        <AppModal opened onClose={secondClose} title="Second">
          <div>Second</div>
        </AppModal>
      </MantineProvider>,
    );
  });

  dispatchEscape(document.body);
  expect(secondClose).toHaveBeenCalledTimes(1);
  expect(firstClose).not.toHaveBeenCalled();
});

test("re-opening a mounted modal after another modal opens puts it on top for Escape", async () => {
  const xClose = vi.fn();
  const yClose = vi.fn();

  const renderPair = async (xOpened: boolean, yOpened: boolean) => {
    await act(async () => {
      root.render(
        <MantineProvider env="test">
          <AppModal opened={xOpened} onClose={xClose} title="Modal X">
            <div>X</div>
          </AppModal>
          <AppModal opened={yOpened} onClose={yClose} title="Modal Y">
            <div>Y</div>
          </AppModal>
        </MantineProvider>,
      );
    });
  };

  // X opens, closes, Y opens, then X re-opens while Y stays open -> X is now topmost.
  await renderPair(true, false);
  await renderPair(false, false);
  await renderPair(false, true);
  await renderPair(true, true);

  dispatchEscape(document.body);
  expect(xClose).toHaveBeenCalledTimes(1);
  expect(yClose).not.toHaveBeenCalled();
});
