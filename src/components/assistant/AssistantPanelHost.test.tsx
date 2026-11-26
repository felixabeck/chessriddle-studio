import { MantineProvider } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ASSISTANT_DOCK_WIDTH_KEY } from "@/state/assistantWidth";
import { press } from "@/tests/keyboard";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { withKeyboardOwnership } from "@/utils/keyboardOwnership";
import { AssistantPanelHost } from "./AssistantPanelHost";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@/platform/native", () => ({
  warn: vi.fn(() => Promise.resolve()),
  error: vi.fn(() => Promise.resolve()),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

const stubPanelLoader = async () => ({
  default: () => <div data-testid="stub-assistant">Loaded</div>,
});

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function dispatchPointer(
  target: HTMLElement,
  type: string,
  init: { pointerId?: number; button?: number; clientX?: number } = {},
) {
  const EventCtor = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
  const event = new EventCtor(type, {
    bubbles: true,
    cancelable: true,
    button: init.button ?? 0,
    clientX: init.clientX ?? 0,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  localStorage.clear();
  setViewportWidth(1440);
  document.documentElement.style.fontSize = "16px";
  installMatchMediaStub({ matches: () => false });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

async function renderHost({
  extra,
}: {
  extra?: React.ReactNode;
} = {}) {
  const store = createStore();
  await act(async () =>
    root.render(
      <Provider store={store}>
        <MantineProvider env="test">
          {extra}
          <AssistantPanelHost
            opened
            onClose={() => undefined}
            createNewTab={() => undefined}
            openAccounts={() => undefined}
            openEngines={() => undefined}
            openSettings={() => undefined}
            loadPanel={stubPanelLoader}
          />
        </MantineProvider>
      </Provider>,
    ),
  );
  return {
    store,
    panel: host.querySelector<HTMLElement>('[data-testid="assistant-panel"]')!,
    handle: host.querySelector<HTMLElement>('[role="separator"]'),
  };
}

test("absent and invalid stored widths fall back to 24rem", async () => {
  const first = await renderHost();
  expect(first.panel.style.width).toBe("24rem");
  expect(first.handle?.getAttribute("aria-label")).toBe("Assistant.Resize");
  expect(first.handle?.getAttribute("aria-valuenow")).toBe("24");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBeNull();

  localStorage.setItem(ASSISTANT_DOCK_WIDTH_KEY, '"not-a-number"');
  const second = await renderHost();
  expect(second.panel.style.width).toBe("24rem");
});

test("stored values below 20rem or above 42vw are clamped when used and left as stored", async () => {
  localStorage.setItem(ASSISTANT_DOCK_WIDTH_KEY, "12");
  const narrowStored = await renderHost();
  expect(narrowStored.panel.style.width).toBe("20rem");
  expect(narrowStored.handle?.getAttribute("aria-valuenow")).toBe("20");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("12");

  // 1440px * 0.42 / 16px = 37.8rem
  localStorage.setItem(ASSISTANT_DOCK_WIDTH_KEY, "80");
  const wideStored = await renderHost();
  expect(wideStored.panel.style.width).toBe("37.8rem");
  expect(wideStored.handle?.getAttribute("aria-valuenow")).toBe("37.8");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("80");
});

test("pointer drag updates live and writes to storage once at the end", async () => {
  const { panel, handle } = await renderHost();
  expect(handle).not.toBeNull();
  const setCapture = vi.fn();
  const releaseCapture = vi.fn();
  handle!.setPointerCapture = setCapture;
  handle!.hasPointerCapture = vi.fn(() => true);
  handle!.releasePointerCapture = releaseCapture;

  const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

  // Press without movement stores nothing.
  await act(async () => {
    dispatchPointer(handle!, "pointerdown", { clientX: 1000 });
    dispatchPointer(handle!, "pointerup", { clientX: 1000 });
  });
  expect(setItemSpy).not.toHaveBeenCalled();

  // Drag left by 128px (8rem) -> 24rem + 8rem = 32rem.
  await act(async () => {
    dispatchPointer(handle!, "pointerdown", { clientX: 1000 });
  });
  expect(setCapture).toHaveBeenCalledWith(1);
  await act(async () => {
    dispatchPointer(handle!, "pointermove", { clientX: 936 });
  });
  expect(panel.style.width).toBe("28rem");
  expect(setItemSpy).not.toHaveBeenCalled();

  await act(async () => {
    dispatchPointer(handle!, "pointermove", { clientX: 872 });
  });
  expect(panel.style.width).toBe("32rem");
  expect(setItemSpy).not.toHaveBeenCalled();

  await act(async () => {
    dispatchPointer(handle!, "pointerup", { clientX: 872 });
    dispatchPointer(handle!, "lostpointercapture", { clientX: 0 });
  });
  expect(releaseCapture).toHaveBeenCalledWith(1);
  expect(setItemSpy).toHaveBeenCalledTimes(1);
  expect(setItemSpy).toHaveBeenCalledWith(ASSISTANT_DOCK_WIDTH_KEY, "32");
  expect(panel.style.width).toBe("32rem");
});

test("arrow keys resize the dock and do not trigger board move hotkeys", async () => {
  const movePrev = vi.fn();
  const moveNext = vi.fn();
  function BoardMoveHotkeys() {
    useHotkeys(
      withKeyboardOwnership([
        ["arrowleft", movePrev],
        ["arrowright", moveNext],
      ]),
    );
    return null;
  }

  const { panel, handle } = await renderHost({ extra: <BoardMoveHotkeys /> });
  expect(handle).not.toBeNull();
  act(() => handle!.focus());

  await act(async () => {
    press("ArrowLeft", { target: handle! });
  });
  expect(panel.style.width).toBe("25.5rem");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("25.5");

  await act(async () => {
    press("ArrowRight", { target: handle! });
  });
  expect(panel.style.width).toBe("24rem");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("24");
  expect(movePrev).not.toHaveBeenCalled();
  expect(moveNext).not.toHaveBeenCalled();
});

test("double-click resets the dock width to 24rem", async () => {
  localStorage.setItem(ASSISTANT_DOCK_WIDTH_KEY, "33");
  const { panel, handle } = await renderHost();
  expect(panel.style.width).toBe("33rem");

  await act(async () => {
    handle!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(panel.style.width).toBe("24rem");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("24");
});

test("overlay form omits the handle and neither applies nor changes the stored width", async () => {
  localStorage.setItem(ASSISTANT_DOCK_WIDTH_KEY, "34");
  installMatchMediaStub({ matches: () => true });

  const { panel, handle } = await renderHost();
  expect(panel.getAttribute("data-overlay")).toBe("true");
  expect(handle).toBeNull();
  expect(panel.style.width).toBe("");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("34");
});

test("changing the root font size after mount updates the dock clamp and keyboard resize math", async () => {
  localStorage.setItem(ASSISTANT_DOCK_WIDTH_KEY, "36");
  const { panel, handle } = await renderHost();
  // At 16px root font on 1440px viewport: 42vw = 37.8rem, so 36rem is unclamped.
  expect(handle?.getAttribute("aria-valuemax")).toBe("37.8");
  expect(panel.style.width).toBe("36rem");

  await act(async () => {
    document.documentElement.style.fontSize = "20px";
    await Promise.resolve();
  });
  // At 20px root font on 1440px viewport: 42vw = 604.8px = 30.24rem.
  expect(handle?.getAttribute("aria-valuemax")).toBe("30.24");
  expect(panel.style.width).toBe("30.24rem");

  // Pressing ArrowRight narrows from 30.24rem by 1.5rem -> 28.74rem (not stale 16px math).
  act(() => handle!.focus());
  await act(async () => {
    press("ArrowRight", { target: handle! });
  });
  expect(panel.style.width).toBe("28.74rem");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("28.74");
});

test("pointerup back at startX after moving away stores the release position, not stale lastWidthRem", async () => {
  const { panel, handle } = await renderHost();
  handle!.setPointerCapture = vi.fn();
  handle!.hasPointerCapture = vi.fn(() => true);
  handle!.releasePointerCapture = vi.fn();

  await act(async () => {
    dispatchPointer(handle!, "pointerdown", { clientX: 1000 });
    dispatchPointer(handle!, "pointermove", { clientX: 900 });
  });
  expect(panel.style.width).toBe("30.25rem");

  await act(async () => {
    dispatchPointer(handle!, "pointerup", { clientX: 1000 });
  });
  expect(panel.style.width).toBe("24rem");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("24");
});

test("pointercancel and lostpointercapture during an active drag commit lastWidthRem and clear drag state", async () => {
  const { panel, handle } = await renderHost();
  const releaseCapture = vi.fn();
  handle!.setPointerCapture = vi.fn();
  handle!.hasPointerCapture = vi.fn(() => true);
  handle!.releasePointerCapture = releaseCapture;

  // pointercancel without a preceding pointerup
  await act(async () => {
    dispatchPointer(handle!, "pointerdown", { clientX: 1000 });
    dispatchPointer(handle!, "pointermove", { clientX: 920 });
  });
  expect(handle!.getAttribute("data-dragging")).toBe("true");
  expect(panel.style.width).toBe("29rem");

  await act(async () => {
    dispatchPointer(handle!, "pointercancel", { clientX: 0 });
  });
  expect(handle!.getAttribute("data-dragging")).toBeNull();
  expect(releaseCapture).toHaveBeenCalledWith(1);
  expect(panel.style.width).toBe("29rem");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("29");

  // lostpointercapture without a preceding pointerup
  await act(async () => {
    dispatchPointer(handle!, "pointerdown", { clientX: 1000 });
    dispatchPointer(handle!, "pointermove", { clientX: 968 });
  });
  expect(handle!.getAttribute("data-dragging")).toBe("true");
  expect(panel.style.width).toBe("31rem");

  await act(async () => {
    dispatchPointer(handle!, "lostpointercapture", { clientX: 0 });
  });
  expect(handle!.getAttribute("data-dragging")).toBeNull();
  expect(panel.style.width).toBe("31rem");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("31");
});

test("throwing setPointerCapture fails closed and throwing releasePointerCapture still commits and clears drag", async () => {
  const { panel, handle } = await renderHost();

  // Failing setPointerCapture does not start a drag.
  handle!.setPointerCapture = vi.fn(() => {
    throw new DOMException("invalid pointer", "NotFoundError");
  });
  await act(async () => {
    dispatchPointer(handle!, "pointerdown", { clientX: 1000 });
    dispatchPointer(handle!, "pointermove", { clientX: 880 });
  });
  expect(handle!.getAttribute("data-dragging")).toBeNull();
  expect(panel.style.width).toBe("24rem");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBeNull();

  // Failing releasePointerCapture still commits width and clears drag state.
  handle!.setPointerCapture = vi.fn();
  handle!.hasPointerCapture = vi.fn(() => true);
  handle!.releasePointerCapture = vi.fn(() => {
    throw new DOMException("already released", "NotFoundError");
  });
  await act(async () => {
    dispatchPointer(handle!, "pointerdown", { clientX: 1000 });
    dispatchPointer(handle!, "pointermove", { clientX: 920 });
    dispatchPointer(handle!, "pointerup", { clientX: 920 });
  });
  expect(handle!.getAttribute("data-dragging")).toBeNull();
  expect(panel.style.width).toBe("29rem");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("29");

  // Subsequent keyboard resize is not shadowed by stale dragWidthRem.
  act(() => handle!.focus());
  await act(async () => {
    press("ArrowRight", { target: handle! });
  });
  expect(panel.style.width).toBe("27.5rem");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("27.5");
});

test("stored width is clamped at both limits during pointer drag and arrow-key resize", async () => {
  const { panel, handle } = await renderHost();
  handle!.setPointerCapture = vi.fn();
  handle!.hasPointerCapture = vi.fn(() => false);

  // Drag far left past 42vw (37.8rem).
  await act(async () => {
    dispatchPointer(handle!, "pointerdown", { clientX: 1000 });
    dispatchPointer(handle!, "pointermove", { clientX: 100 });
    dispatchPointer(handle!, "pointerup", { clientX: 100 });
  });
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("37.8");
  expect(panel.style.width).toBe("37.8rem");

  // ArrowLeft at the cap stays clamped to 37.8 in storage.
  act(() => handle!.focus());
  await act(async () => {
    press("ArrowLeft", { target: handle! });
  });
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("37.8");

  // Drag far right past 20rem floor.
  await act(async () => {
    dispatchPointer(handle!, "pointerdown", { clientX: 500 });
    dispatchPointer(handle!, "pointermove", { clientX: 1400 });
    dispatchPointer(handle!, "pointerup", { clientX: 1400 });
  });
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("20");
  expect(panel.style.width).toBe("20rem");

  // ArrowRight at the floor stays clamped to 20 in storage.
  await act(async () => {
    press("ArrowRight", { target: handle! });
  });
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("20");
});

test("window resize updates max clamp and narrowing mid-drag clears drag state", async () => {
  let narrow = false;
  const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      get matches() {
        return query.includes("max-width") ? narrow : false;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) => {
        if (query.includes("max-width")) mediaListeners.add(cb);
      },
      removeEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) => {
        mediaListeners.delete(cb);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });

  localStorage.setItem(ASSISTANT_DOCK_WIDTH_KEY, "35");
  const { panel, handle } = await renderHost();
  expect(handle?.getAttribute("aria-valuemax")).toBe("37.8");
  expect(panel.style.width).toBe("35rem");

  // Shrinking the window to 1000px lowers 42vw to 26.25rem.
  await act(async () => {
    setViewportWidth(1000);
    window.dispatchEvent(new Event("resize"));
  });
  expect(handle?.getAttribute("aria-valuemax")).toBe("26.25");
  expect(panel.style.width).toBe("26.25rem");

  // Start a drag, then switch into narrow overlay mode mid-drag.
  handle!.setPointerCapture = vi.fn();
  await act(async () => {
    dispatchPointer(handle!, "pointerdown", { clientX: 700 });
    dispatchPointer(handle!, "pointermove", { clientX: 764 });
  });
  expect(handle!.getAttribute("data-dragging")).toBe("true");
  expect(panel.style.width).toBe("22.25rem");

  await act(async () => {
    narrow = true;
    for (const cb of mediaListeners) cb({ matches: true } as MediaQueryListEvent);
  });
  expect(host.querySelector('[role="separator"]')).toBeNull();
  expect(panel.getAttribute("data-overlay")).toBe("true");

  // Returning to wide mode does not restore stale drag state or dragWidthRem.
  await act(async () => {
    narrow = false;
    for (const cb of mediaListeners) cb({ matches: false } as MediaQueryListEvent);
  });
  const restoredHandle = host.querySelector<HTMLElement>('[role="separator"]')!;
  expect(restoredHandle.getAttribute("data-dragging")).toBeNull();
  expect(panel.style.width).toBe("26.25rem");
});

test("right-click does not start a drag and mismatched pointerId events are ignored", async () => {
  const { panel, handle } = await renderHost();
  const setCapture = vi.fn();
  handle!.setPointerCapture = setCapture;
  handle!.hasPointerCapture = vi.fn(() => true);
  handle!.releasePointerCapture = vi.fn();

  // Right-click (button 2) is ignored.
  await act(async () => {
    dispatchPointer(handle!, "pointerdown", { button: 2, clientX: 1000 });
    dispatchPointer(handle!, "pointermove", { clientX: 880 });
  });
  expect(setCapture).not.toHaveBeenCalled();
  expect(handle!.getAttribute("data-dragging")).toBeNull();
  expect(panel.style.width).toBe("24rem");

  // Mismatched pointerId during an active drag is ignored.
  await act(async () => {
    dispatchPointer(handle!, "pointerdown", { pointerId: 1, clientX: 1000 });
    dispatchPointer(handle!, "pointermove", { pointerId: 2, clientX: 840 });
    dispatchPointer(handle!, "pointerup", { pointerId: 2, clientX: 840 });
  });
  expect(handle!.getAttribute("data-dragging")).toBe("true");
  expect(panel.style.width).toBe("24rem");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBeNull();

  await act(async () => {
    dispatchPointer(handle!, "pointermove", { pointerId: 1, clientX: 936 });
    dispatchPointer(handle!, "pointerup", { pointerId: 1, clientX: 936 });
  });
  expect(handle!.getAttribute("data-dragging")).toBeNull();
  expect(panel.style.width).toBe("28rem");
  expect(localStorage.getItem(ASSISTANT_DOCK_WIDTH_KEY)).toBe("28");
});
