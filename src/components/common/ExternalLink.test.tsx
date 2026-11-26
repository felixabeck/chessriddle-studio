import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openExternalUrl: vi.fn<(url: string) => Promise<null>>(),
  warnSafely: vi.fn<(message: string) => void>(),
}));

vi.mock("@mantine/core", () => ({
  Anchor: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("@/platform/tauri", () => ({
  tauri: {
    openExternalUrl: mocks.openExternalUrl,
  },
}));

vi.mock("@/platform/errors", async () => {
  const actual = await vi.importActual<typeof import("@/platform/errors")>("@/platform/errors");
  return {
    ...actual,
    warnSafely: mocks.warnSafely,
  };
});

import { ExternalLink, externalLinkProps } from "./ExternalLink";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.openExternalUrl.mockReset();
  mocks.openExternalUrl.mockResolvedValue(null);
  mocks.warnSafely.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("renders href, target=_blank and rel=noreferrer and preserves event propagation", async () => {
  const parentClick = vi.fn();
  await act(async () => {
    root.render(
      <div onClick={parentClick}>
        <ExternalLink href="https://example.com/docs" style={{ overflowWrap: "anywhere" }}>
          Docs
        </ExternalLink>
      </div>,
    );
  });

  const anchor = container.querySelector("a")!;
  expect(anchor.getAttribute("href")).toBe("https://example.com/docs");
  expect(anchor.getAttribute("target")).toBe("_blank");
  expect(anchor.getAttribute("rel")).toBe("noreferrer");
  expect(anchor.style.overflowWrap).toBe("anywhere");

  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  await act(async () => {
    anchor.dispatchEvent(event);
  });

  expect(event.defaultPrevented).toBe(true);
  expect(parentClick).toHaveBeenCalledOnce();
  expect(mocks.openExternalUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
});

test.each([
  ["plain primary click", {}],
  ["Ctrl+click", { ctrlKey: true }],
  ["Shift+click", { shiftKey: true }],
  ["Meta+click", { metaKey: true }],
  ["Alt+click", { altKey: true }],
])("routes %s through openExternalUrl and prevents default", async (_label, modifiers) => {
  await act(async () => {
    root.render(<ExternalLink href="https://example.com/repo">Repo</ExternalLink>);
  });

  const anchor = container.querySelector("a")!;
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...modifiers,
  });
  await act(async () => {
    anchor.dispatchEvent(event);
  });

  expect(event.defaultPrevented).toBe(true);
  expect(mocks.openExternalUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/repo");
});

test("routes middle click (auxclick button 1) through openExternalUrl and ignores right click", async () => {
  await act(async () => {
    root.render(<a {...externalLinkProps("mailto:user@example.com")}>Mail</a>);
  });

  const anchor = container.querySelector("a")!;
  const rightClick = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 });
  await act(async () => {
    anchor.dispatchEvent(rightClick);
  });
  expect(rightClick.defaultPrevented).toBe(false);
  expect(mocks.openExternalUrl).not.toHaveBeenCalled();

  const middleClick = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
  await act(async () => {
    anchor.dispatchEvent(middleClick);
  });
  expect(middleClick.defaultPrevented).toBe(true);
  expect(mocks.openExternalUrl).toHaveBeenCalledExactlyOnceWith("mailto:user@example.com");
});

test("logs a rejected openExternalUrl through warnSafely without throwing", async () => {
  mocks.openExternalUrl.mockRejectedValueOnce(new Error("opener unavailable"));
  await act(async () => {
    root.render(<ExternalLink href="https://example.com/fail">Fail</ExternalLink>);
  });

  const anchor = container.querySelector("a")!;
  await act(async () => {
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await Promise.resolve();
  });

  expect(mocks.warnSafely).toHaveBeenCalledExactlyOnceWith(
    "Failed to open external link: opener unavailable",
  );
});

test("ignores non-primary button click events", async () => {
  await act(async () => {
    root.render(<ExternalLink href="https://example.com/docs">Docs</ExternalLink>);
  });

  const anchor = container.querySelector("a")!;
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 2 });
  await act(async () => {
    anchor.dispatchEvent(event);
  });

  expect(event.defaultPrevented).toBe(false);
  expect(mocks.openExternalUrl).not.toHaveBeenCalled();
});

test("forwards caller onClick and skips openExternalUrl when prevented", async () => {
  const onClick = vi.fn((event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
  });
  await act(async () => {
    root.render(
      <ExternalLink href="https://example.com/blocked" onClick={onClick}>
        Blocked
      </ExternalLink>,
    );
  });

  const anchor = container.querySelector("a")!;
  const blockedEvent = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  await act(async () => {
    anchor.dispatchEvent(blockedEvent);
  });

  expect(onClick).toHaveBeenCalledOnce();
  expect(blockedEvent.defaultPrevented).toBe(true);
  expect(mocks.openExternalUrl).not.toHaveBeenCalled();

  const passiveClick = vi.fn();
  await act(async () => {
    root.render(
      <ExternalLink href="https://example.com/allowed" onClick={passiveClick}>
        Allowed
      </ExternalLink>,
    );
  });

  const allowedEvent = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  await act(async () => {
    container.querySelector("a")!.dispatchEvent(allowedEvent);
  });

  expect(passiveClick).toHaveBeenCalledOnce();
  expect(allowedEvent.defaultPrevented).toBe(true);
  expect(mocks.openExternalUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/allowed");
});

test("forwards caller onAuxClick and skips openExternalUrl when prevented", async () => {
  const onAuxClick = vi.fn((event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
  });
  await act(async () => {
    root.render(
      <ExternalLink href="https://example.com/aux-blocked" onAuxClick={onAuxClick}>
        Blocked
      </ExternalLink>,
    );
  });

  const blockedEvent = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
  await act(async () => {
    container.querySelector("a")!.dispatchEvent(blockedEvent);
  });

  expect(onAuxClick).toHaveBeenCalledOnce();
  expect(blockedEvent.defaultPrevented).toBe(true);
  expect(mocks.openExternalUrl).not.toHaveBeenCalled();

  const passiveAuxClick = vi.fn();
  await act(async () => {
    root.render(
      <ExternalLink href="https://example.com/aux-allowed" onAuxClick={passiveAuxClick}>
        Allowed
      </ExternalLink>,
    );
  });

  const allowedEvent = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
  await act(async () => {
    container.querySelector("a")!.dispatchEvent(allowedEvent);
  });

  expect(passiveAuxClick).toHaveBeenCalledOnce();
  expect(allowedEvent.defaultPrevented).toBe(true);
  expect(mocks.openExternalUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/aux-allowed");
});
