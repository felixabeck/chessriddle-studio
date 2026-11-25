import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Emoji, EmojiLabel } from "./Emoji";
import classes from "./Emoji.module.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("renders a decorative aria-hidden span with the emoji class and an optional rem size", async () => {
  await act(async () =>
    root.render(
      <>
        <Emoji glyph="🐛" />
        <Emoji glyph="🔍" size="1.125rem" />
      </>,
    ),
  );
  const spans = [...host.querySelectorAll("span")];
  expect(spans).toHaveLength(2);
  for (const span of spans) {
    expect(span.getAttribute("aria-hidden")).toBe("true");
    expect(span.classList.contains(classes.emoji)).toBe(true);
  }
  expect(spans[0].textContent).toBe("🐛");
  expect(spans[0].style.fontSize).toBe("");
  expect(spans[1].textContent).toBe("🔍");
  expect(spans[1].style.fontSize).toBe("1.125rem");
});

test("EmojiLabel marks the glyph aria-hidden while keeping the label text separate", async () => {
  await act(async () =>
    root.render(
      <button type="button">
        <EmojiLabel glyph="🐛" label="Bug" />
      </button>,
    ),
  );
  const button = host.querySelector("button")!;
  const hidden = button.querySelector<HTMLElement>('[aria-hidden="true"]')!;
  expect(hidden.textContent).toBe("🐛");
  const visible = [...button.querySelectorAll("span")].find(
    (node) => !node.hasAttribute("aria-hidden") && node.childElementCount === 0,
  )!;
  expect(visible.textContent).toBe("Bug");
});
