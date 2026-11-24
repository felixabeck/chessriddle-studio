import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useCollectionCurrency } from "./linkedCollections";

// Same unstable-mutate mock NewTabHome.database.test.tsx uses: a new `mutate`
// function every useSWRConfig() call. The currency hook must not put that
// identity in an effect that setStates, or New Tab (which now mounts
// useReferenceResolution) loops until the worker heap dies.
vi.mock("swr", () => ({
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const RENDER_LOOP_BOUND = 50;

let host: HTMLDivElement;
let root: Root;
let renders = 0;

function Probe() {
  renders++;
  if (renders > RENDER_LOOP_BOUND) {
    throw new Error(`useCollectionCurrency render loop (${renders} renders)`);
  }
  const state = useCollectionCurrency(null);
  return <output>{state.pending ? "pending" : "idle"}</output>;
}

beforeEach(() => {
  renders = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("an unstable SWR mutate identity does not loop when no reference is selected", async () => {
  await act(async () => root.render(<Probe />));
  expect(host.textContent).toBe("idle");
  expect(renders).toBeLessThan(RENDER_LOOP_BOUND);
  const afterMount = renders;
  await act(async () => root.render(<Probe />));
  expect(renders - afterMount).toBeLessThan(5);
});
