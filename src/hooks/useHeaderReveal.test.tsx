import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { useHeaderReveal } from "./useHeaderReveal";

const HEADER_HEIGHT = 42;

let host: HTMLDivElement | null = null;
let root: Root | null = null;
const seen: boolean[] = [];

function Harness({ active }: { active: boolean }) {
  const headerRef = useRef<HTMLElement | null>(null);
  seen.push(useHeaderReveal(active, headerRef));
  return (
    <header
      ref={(node) => {
        headerRef.current = node;
        // jsdom lays nothing out; give the header the row's layout height.
        if (node) Object.defineProperty(node, "offsetHeight", { value: HEADER_HEIGHT });
      }}
    >
      <button type="button">menu</button>
    </header>
  );
}

async function render(active: boolean) {
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  }
  await act(async () => root!.render(<Harness active={active} />));
}

function pointerAt(clientY: number, target: EventTarget = document) {
  act(() => {
    target.dispatchEvent(new MouseEvent("pointermove", { clientY, bubbles: true }));
  });
}

const revealed = () => seen.at(-1);

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  seen.length = 0;
  vi.restoreAllMocks();
});

test("the top edge reveals, the header area keeps it, and below the header hides it", async () => {
  await render(true);
  expect(revealed()).toBe(false);

  pointerAt(2);
  expect(revealed()).toBe(true);
  // Inside the header's layout height, even while its box is still sliding in.
  pointerAt(HEADER_HEIGHT - 2);
  expect(revealed()).toBe(true);
  pointerAt(HEADER_HEIGHT + 1);
  expect(revealed()).toBe(false);
});

test("events from elements along the top edge, such as the resize handles, reveal it too", async () => {
  await render(true);
  const handle = document.createElement("div");
  document.body.append(handle);
  try {
    pointerAt(1, handle);
    expect(revealed()).toBe(true);
  } finally {
    handle.remove();
  }
});

test("an open header menu keeps the header shown until it closes", async () => {
  await render(true);
  pointerAt(2);
  const button = host!.querySelector("button")!;
  button.setAttribute("aria-expanded", "true");
  pointerAt(400);
  expect(revealed()).toBe(true);
  button.removeAttribute("aria-expanded");
  pointerAt(400);
  expect(revealed()).toBe(false);
});

test("the listener exists only while active and the reveal resets on exit", async () => {
  const add = vi.spyOn(document, "addEventListener");
  const remove = vi.spyOn(document, "removeEventListener");
  await render(false);
  pointerAt(2);
  expect(revealed()).toBe(false);
  expect(add.mock.calls.filter(([type]) => type === "pointermove")).toHaveLength(0);

  await render(true);
  const listener = add.mock.calls.find(([type]) => type === "pointermove")?.[1];
  expect(listener).toBeDefined();
  pointerAt(2);
  expect(revealed()).toBe(true);

  await render(false);
  expect(remove).toHaveBeenCalledWith("pointermove", listener);
  expect(revealed()).toBe(false);
  await render(true);
  expect(revealed()).toBe(false);
});
