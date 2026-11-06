import { MantineProvider } from "@mantine/core";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import type { TablebaseCategory } from "@/utils/lichess/api";
import TablebaseInfo, { compareTablebaseMoves } from "./TablebaseInfo";

const mocks = vi.hoisted(() => ({
  makeMove: vi.fn(),
  error: undefined as unknown,
  swrOptions: undefined as unknown,
  data: {
    category: "win",
    moves: [{ category: "win", uci: "e2e4", san: "e4", dtz: 1, dtm: null }],
  } as { category: string; moves: Record<string, unknown>[] },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("swr/immutable", () => ({
  default: (_key: unknown, _fetcher: unknown, options?: unknown) => {
    mocks.swrOptions = options;
    return { data: mocks.data, error: mocks.error, isLoading: false };
  },
}));
vi.mock("@/utils/lichess/api", () => ({ getTablebaseInfo: vi.fn() }));
vi.mock("@/components/common/TreeStateContext", async () => {
  const { createContext } = await import("react");
  return { TreeStateContext: createContext(null) };
});
vi.mock("zustand", () => ({
  useStore: (_store: unknown, select: (state: { makeMove: typeof mocks.makeMove }) => unknown) =>
    select({ makeMove: mocks.makeMove }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
installMatchMediaStub();
installResizeObserverStub();

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  mocks.error = undefined;
  mocks.swrOptions = undefined;
  mocks.data = {
    category: "win",
    moves: [{ category: "win", uci: "e2e4", san: "e4", dtz: 1, dtm: null }],
  };
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  mocks.makeMove.mockClear();
});

async function render(children: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<MantineProvider>{children}</MantineProvider>));
}

test.each<[TablebaseCategory, TablebaseCategory]>([
  ["loss", "draw"],
  ["draw", "win"],
  ["loss", "blessed-loss"],
  ["blessed-loss", "draw"],
  ["draw", "cursed-win"],
  ["cursed-win", "win"],
  ["win", "maybe-win"],
  ["maybe-win", "maybe-loss"],
  ["maybe-loss", "unknown"],
])("ranks child %s before %s regardless of SAN", (better, worse) => {
  const a = { category: better, san: "Kh8" };
  const b = { category: worse, san: "Ka1" };
  expect(compareTablebaseMoves(a, b)).toBeLessThan(0);
  expect(compareTablebaseMoves(b, a)).toBeGreaterThan(0);
});

test.each<TablebaseCategory>(["loss", "blessed-loss", "draw", "cursed-win", "win", "unknown"])(
  "breaks equal child %s ties by SAN",
  (category) => {
    const a = { category, san: "h8=Q+" };
    const b = { category, san: "h8=R+" };
    expect(compareTablebaseMoves(a, b)).toBeLessThan(0);
    expect(compareTablebaseMoves(b, a)).toBeGreaterThan(0);
    expect(compareTablebaseMoves(a, { ...a })).toBe(0);
  },
);

test("renders child losses first, fifty-move outcomes around draws and SAN ties without changing SWR data", async () => {
  mocks.data.moves = [
    { category: "win", san: "Kf6" },
    { category: "unknown", san: "Ka1" },
    { category: "cursed-win", san: "Kb2" },
    { category: "loss", san: "h8=R+" },
    { category: "maybe-loss", san: "Kc3" },
    { category: "draw", san: "Kg8" },
    { category: "maybe-win", san: "Kd4" },
    { category: "blessed-loss", san: "Ke5" },
    { category: "loss", san: "h8=Q+" },
  ].map((move) => ({ ...move, uci: "e2e4", dtz: 1, dtm: null }));
  const cachedMoves = mocks.data.moves;
  const originalData = structuredClone(mocks.data);
  Object.freeze(cachedMoves);
  for (const move of cachedMoves) Object.freeze(move);

  await render(<TablebaseInfo fen="4k3/6KP/8/8/8/8/7p/8 w - - 0 1" turn="white" />);
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".mantine-Accordion-control")!.click(),
  );

  const moves = [...host.querySelectorAll(".mantine-SimpleGrid-root > .mantine-Paper-root")].map(
    (card) => card.querySelector(".mantine-Text-root")!.textContent,
  );
  expect(moves).toEqual(["h8=Q+", "h8=R+", "Ke5", "Kg8", "Kb2", "Kf6", "Kd4", "Kc3", "Ka1"]);
  expect(mocks.data).toEqual(originalData);
  expect(mocks.data.moves).toBe(cachedMoves);
});

test.each([
  ["white", "WhiteWins", "var(--cf-eval-bar-light)", "var(--cf-eval-bar-dark)"],
  ["black", "BlackWins", "var(--cf-eval-bar-dark)", "var(--cf-eval-bar-light)"],
] as const)(
  "keeps %s as a chess side and inverts it for child outcomes",
  async (turn, winner, parentFill, childFill) => {
    await render(<TablebaseInfo fen="8/8/8/8/8/8/4P3/8 w - - 0 1" turn={turn} />);
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".mantine-Accordion-control")!.click(),
    );
    const badges = [...host.querySelectorAll<HTMLElement>(".mantine-Badge-root")];
    const parent = badges.find((badge) => badge.textContent?.endsWith(winner))!;
    const child = badges.find((badge) => badge.textContent === "DTZ 1")!;
    expect(parent.style.getPropertyValue("--badge-bg")).toBe(parentFill);
    expect(child.style.getPropertyValue("--badge-bg")).toBe(childFill);

    await act(async () => child.closest<HTMLElement>(".mantine-Paper-root")!.click());
    expect(mocks.makeMove).toHaveBeenCalledExactlyOnceWith({ payload: { from: 12, to: 28 } });
  },
);

test("renders a rejected response's message instead of throwing on the Error object", async () => {
  mocks.error = new Error("Lichess returned an invalid response");
  mocks.data = undefined as never;

  await render(<TablebaseInfo fen="8/8/8/8/8/8/4P3/8 w - - 0 1" turn="white" />);

  expect(host.textContent).toContain("Common.Error: Lichess returned an invalid response");
});

test("bounds SWR error retries so a deterministic rejection does not retry forever", async () => {
  await render(<TablebaseInfo fen="8/8/8/8/8/8/4P3/8 w - - 0 1" turn="white" />);

  expect(mocks.swrOptions).toEqual({ errorRetryCount: 3 });
});

test("labels a child with null dtz and dtm as unknown instead of a DTZ number", async () => {
  mocks.data.moves = [{ category: "maybe-win", uci: "e2e4", san: "e4", dtz: null, dtm: null }];

  await render(<TablebaseInfo fen="8/8/8/8/8/8/4P3/8 w - - 0 1" turn="white" />);
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".mantine-Accordion-control")!.click(),
  );

  const labels = [...host.querySelectorAll(".mantine-Badge-root")].map((b) => b.textContent);
  expect(labels).toContain("Common.Unknown");
  expect(labels.some((label) => label?.includes("DTZ"))).toBe(false);
});
