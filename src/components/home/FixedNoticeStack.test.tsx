import { Alert, getDefaultZIndex, MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { FIXED_NOTICE_STACK_OFFSET, FixedNoticeStack } from "./FixedNoticeStack";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let observed: { callback: () => void; target?: Element; disconnected: boolean }[];
let height: number;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  installMatchMediaStub();
  observed = [];
  height = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly entry: (typeof observed)[number];
      constructor(callback: () => void) {
        this.entry = { callback, disconnected: false };
        observed.push(this.entry);
      }
      observe(target: Element) {
        this.entry.target = target;
      }
      unobserve() {}
      disconnect() {
        this.entry.disconnected = true;
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-fixed-notice-stack") ? height : 0;
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function offset() {
  return document.documentElement.style.getPropertyValue(FIXED_NOTICE_STACK_OFFSET);
}

test("stacks both notices in one fixed container below dialogs", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <FixedNoticeStack>
          <Alert role="alert">persistence</Alert>
          <Alert role="status">stockfish</Alert>
        </FixedNoticeStack>
      </MantineProvider>,
    ),
  );
  const stack = host.querySelector<HTMLElement>("[data-fixed-notice-stack]")!;
  expect(stack.querySelector('[role="alert"]')).not.toBeNull();
  expect(stack.querySelector('[role="status"]')).not.toBeNull();
  expect(host.querySelectorAll("[data-fixed-notice-stack]")).toHaveLength(1);
  expect(stack.style.zIndex).toBe(String(getDefaultZIndex("modal") - 1));
});

test("publishes the toast offset from the observed height and clears it on unmount", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <FixedNoticeStack>{null}</FixedNoticeStack>
      </MantineProvider>,
    ),
  );
  expect(offset()).toBe("0px");
  const [observer] = observed;
  expect(observer.target).toBe(host.querySelector("[data-fixed-notice-stack]"));

  height = 120;
  act(() => observer.callback());
  expect(offset()).toBe("calc(120px + var(--mantine-spacing-xs))");

  height = 0;
  act(() => observer.callback());
  expect(offset()).toBe("0px");

  await act(async () => root.unmount());
  expect(observer.disconnected).toBe(true);
  expect(offset()).toBe("");
  root = createRoot(host);
});
