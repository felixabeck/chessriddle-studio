import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { useExplanationOpen } from "./ExplanationTooltip";

function Probe() {
  const { opened, onMouseEnter, onMouseLeave, onFocus, onBlur, onKeyDown } = useExplanationOpen();
  return (
    <button
      type="button"
      data-opened={String(opened)}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      Trigger
    </button>
  );
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

async function renderProbe(): Promise<HTMLButtonElement> {
  await act(async () => {
    root.render(<Probe />);
  });
  return host.querySelector("button")!;
}

async function hoverEnter(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  });
}

async function hoverLeave(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
  });
}

async function pressEscapeOn(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

test("hover+focus, Escape on button, mouseleave while focused keeps data-opened false", async () => {
  const button = await renderProbe();
  expect(button.getAttribute("data-opened")).toBe("false");

  await hoverEnter(button);
  await act(async () => button.focus());
  expect(button.getAttribute("data-opened")).toBe("true");

  await pressEscapeOn(button);
  expect(button.getAttribute("data-opened")).toBe("false");

  await hoverLeave(button);
  expect(button.getAttribute("data-opened")).toBe("false");
});

test("hover+focus, Escape on button, blur while hovered keeps data-opened false", async () => {
  const button = await renderProbe();

  await hoverEnter(button);
  await act(async () => button.focus());
  expect(button.getAttribute("data-opened")).toBe("true");

  await pressEscapeOn(button);
  expect(button.getAttribute("data-opened")).toBe("false");

  await act(async () => button.blur());
  expect(button.getAttribute("data-opened")).toBe("false");
});

test("Escape then mouseenter re-opens data-opened", async () => {
  const button = await renderProbe();

  await hoverEnter(button);
  expect(button.getAttribute("data-opened")).toBe("true");

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(button.getAttribute("data-opened")).toBe("false");

  await hoverLeave(button);
  await hoverEnter(button);
  expect(button.getAttribute("data-opened")).toBe("true");
});

test("Escape then focus re-opens data-opened", async () => {
  const button = await renderProbe();

  await act(async () => button.focus());
  expect(button.getAttribute("data-opened")).toBe("true");

  await pressEscapeOn(button);
  expect(button.getAttribute("data-opened")).toBe("false");

  await act(async () => button.blur());
  await act(async () => button.focus());
  expect(button.getAttribute("data-opened")).toBe("true");
});

test("mouseleave without Escape while focused keeps data-opened true", async () => {
  const button = await renderProbe();

  await hoverEnter(button);
  await act(async () => button.focus());
  expect(button.getAttribute("data-opened")).toBe("true");

  await hoverLeave(button);
  expect(button.getAttribute("data-opened")).toBe("true");
});

test("blur without Escape while hovered keeps data-opened true", async () => {
  const button = await renderProbe();

  await hoverEnter(button);
  await act(async () => button.focus());
  expect(button.getAttribute("data-opened")).toBe("true");

  await act(async () => button.blur());
  expect(button.getAttribute("data-opened")).toBe("true");
});

test("window Escape does not dismiss while focused (listener attached only when opened && !focused)", async () => {
  const button = await renderProbe();

  await act(async () => button.focus());
  expect(button.getAttribute("data-opened")).toBe("true");

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(button.getAttribute("data-opened")).toBe("true");
});
