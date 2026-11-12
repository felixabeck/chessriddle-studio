import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { BoardBar } from "./BoardBar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  installMatchMediaStub();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("a title without onNameClick renders plain bold text without a button", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <BoardBar name="Italian Game" height="1.9rem" />
      </MantineProvider>,
    ),
  );
  expect(host.querySelector("[data-board-bar]")?.textContent).toBe("Italian Game");
  expect(host.querySelector("button")).toBeNull();
  expect(host.querySelector("[tabindex]")).toBeNull();
  const name = host.querySelector("p");
  expect(name?.style.fontWeight).toBe("bold");
});

test("a player with onNameClick renders a button that invokes it", async () => {
  const onNameClick = vi.fn();
  await act(async () =>
    root.render(
      <MantineProvider>
        <BoardBar name="White Player" height="1.9rem" onNameClick={onNameClick} />
      </MantineProvider>,
    ),
  );
  const button = host.querySelector("button");
  expect(button?.textContent).toBe("White Player");
  await act(async () => button?.click());
  expect(onNameClick).toHaveBeenCalledOnce();
});
