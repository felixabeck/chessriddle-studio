import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openExternalUrl: vi.fn<(url: string) => Promise<null>>(),
}));

vi.mock("@mantine/core", () => ({
  ActionIcon: ({
    children,
    component: Element = "button",
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { component?: "a" | "button" }) =>
    // createElement: the mock's props are button-typed, which JSX would not accept on an anchor.
    createElement(Element, props, children),
  Loader: () => <span>Loading</span>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/platform/tauri", () => ({
  tauri: {
    openExternalUrl: mocks.openExternalUrl,
  },
}));

import { IconAction } from "./IconAction";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.openExternalUrl.mockReset();
  mocks.openExternalUrl.mockResolvedValue(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("exposes a named semantic button and pressed state", async () => {
  await act(async () => {
    root.render(
      <IconAction label="Toggle annotations" pressed>
        <span aria-hidden>Icon</span>
      </IconAction>,
    );
  });

  const button = container.querySelector("button")!;
  expect(button.getAttribute("aria-label")).toBe("Toggle annotations");
  expect(button.getAttribute("aria-pressed")).toBe("true");
});

test("disables and marks a pending action busy", async () => {
  await act(async () => {
    root.render(
      <IconAction label="Save" pending>
        <span aria-hidden>Icon</span>
      </IconAction>,
    );
  });

  const button = container.querySelector("button")!;
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
});

test("an href action is one named link that opens in a new window", async () => {
  await act(async () => {
    root.render(
      <IconAction label="Open profile" href="https://example.com/profile/1">
        <span aria-hidden>Icon</span>
      </IconAction>,
    );
  });

  const links = container.querySelectorAll("a");
  expect(links).toHaveLength(1);
  expect(container.querySelector("button")).toBeNull();
  expect(links[0].getAttribute("aria-label")).toBe("Open profile");
  expect(links[0].getAttribute("href")).toBe("https://example.com/profile/1");
  expect(links[0].getAttribute("target")).toBe("_blank");
  expect(links[0].getAttribute("rel")).toBe("noreferrer");

  const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  await act(async () => {
    links[0].dispatchEvent(clickEvent);
  });
  expect(clickEvent.defaultPrevented).toBe(true);
  expect(mocks.openExternalUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/profile/1");
});

test("a disabled href action renders as the disabled button, not a clickable link", async () => {
  await act(async () => {
    root.render(
      <IconAction label="Open profile" href="https://example.com/profile/1" disabled>
        <span aria-hidden>Icon</span>
      </IconAction>,
    );
  });

  expect(container.querySelector("a")).toBeNull();
  expect(container.querySelector("button")!.disabled).toBe(true);
});

test("an href action forwards caller onClick and suppresses open when prevented", async () => {
  const onClick = vi.fn((event: React.MouseEvent) => {
    event.preventDefault();
  });
  await act(async () => {
    root.render(
      <IconAction label="Open profile" href="https://example.com/profile/1" onClick={onClick}>
        <span aria-hidden>Icon</span>
      </IconAction>,
    );
  });

  const link = container.querySelector("a")!;
  const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  await act(async () => {
    link.dispatchEvent(clickEvent);
  });

  expect(onClick).toHaveBeenCalledOnce();
  expect(clickEvent.defaultPrevented).toBe(true);
  expect(mocks.openExternalUrl).not.toHaveBeenCalled();
});
