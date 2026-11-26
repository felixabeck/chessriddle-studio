import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { rootFontPx, useRootFontPx } from "./useRootFontPx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  document.documentElement.style.fontSize = "16px";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.documentElement.style.fontSize = "";
});

test("root font uses computed pixels and the existing percentage fallback", () => {
  expect(rootFontPx("24px", 200)).toBe(24);
  expect(rootFontPx("", 200)).toBe(32);
  expect(rootFontPx("0px", 100)).toBe(16);
});

test("useRootFontPx updates when the root element font-size style changes after mount", async () => {
  const store = createStore();
  let observed = 0;

  function Probe() {
    observed = useRootFontPx();
    return <span data-testid="font-px">{observed}</span>;
  }

  await act(async () =>
    root.render(
      <Provider store={store}>
        <Probe />
      </Provider>,
    ),
  );
  expect(observed).toBe(16);

  await act(async () => {
    document.documentElement.style.fontSize = "20px";
    await Promise.resolve();
  });
  expect(observed).toBe(20);
  expect(host.querySelector('[data-testid="font-px"]')?.textContent).toBe("20");
});
