import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@mantine/core", () => ({
  ActionIcon: ({
    children,
    component: Element = "button",
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { component?: "a" | "button" }) => (
    <Element {...props}>{children}</Element>
  ),
  Loader: () => <span>Loading</span>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { IconAction } from "./IconAction";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
});
