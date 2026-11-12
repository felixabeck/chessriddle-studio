import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MantineProvider } from "@mantine/core";
import { installMatchMediaStub } from "@/tests/matchMedia";
import "./FideInfo";
import "swr";

const mocks = vi.hoisted(() => ({
  getFidePlayer: vi.fn(),
}));

type FideInfoProps = {
  opened: boolean;
  setOpened: (opened: boolean) => void;
  name: string;
};

type FideInfoComponent = (props: FideInfoProps) => ReactNode;
type SwrConfigComponent = (typeof import("swr"))["SWRConfig"];
type SwrConfigValue = Parameters<SwrConfigComponent>[0]["value"];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver;

// `react-i18next` and the FIDE API are mocked statically for the whole file. They were per-case
// `vi.doMock`s until the retry case stopped using fake timers, at which point the changed ordering
// exposed the leak the plan review had predicted: `vi.resetModules()` does not clear the mock
// registry, and a `vi.doUnmock` in `afterEach` left a later case rendering against the real
// `react-i18next` ("useTranslation is not a function"). Only `mantine-flagpack` varies per case,
// so only it is registered dynamically.
// `AppModal` is replaced by a plain dialog element. The real one is a Mantine `Modal`: it portals
// out of the container and runs a Transition, which produced unactioned state updates and a
// five-second timeout in the cases that re-render. Nothing here asserts modal chrome — the cases
// cover flag-loader behavior and player-error rendering — so the shell is mocked and
// `@mantine/core` itself is left real, because the flag components rendered by the real
// `mantine-flagpack` need it.
vi.mock("../common/AppModal", () => ({
  default: ({
    children,
    opened,
    title,
  }: {
    children?: ReactNode;
    opened: boolean;
    title?: ReactNode;
  }) =>
    opened ? (
      <div role="dialog">
        <div>{title}</div>
        {children}
      </div>
    ) : null,
}));

vi.mock("@/utils/lichess/api", () => ({ getFidePlayer: mocks.getFidePlayer }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { year?: number }) =>
      key === "Databases.FIDE.Born" ? `Born ${options?.year}` : key,
  }),
}));

// Exactly one mock action for `mantine-flagpack` is queued per case — never a second one from a
// hook. Vitest 4.1.0 resolves the queued actions concurrently and applies them in *resolution*
// order rather than queue order (`BareModuleMocker.resolveMocks` maps them through one
// `Promise.all`), so two actions queued for the same specifier before the next import are applied
// in an arbitrary order. The `vi.doUnmock("mantine-flagpack")` that used to sit in `afterEach` was
// exactly that second action, and under load it landed after this one often enough to redden CI:
// the rejection case then rendered a real flag, and a later case waited out its timeout on a flag
// pack that was still mocked. Measured on this tree: 50 iterations of unmock-then-mock-then-import
// produced one iteration in which the unmock won.
function mockFideInfoDependencies({ rejectFlagpack }: { rejectFlagpack: boolean }) {
  if (rejectFlagpack) {
    vi.doMock("mantine-flagpack", () => {
      throw new Error("flag pack unavailable");
    });
  } else {
    vi.doUnmock("mantine-flagpack");
  }
}

async function importFideInfo({ rejectFlagpack = false } = {}) {
  vi.resetModules();
  mockFideInfoDependencies({ rejectFlagpack });
  const flagpack = await import("./flagpack");
  const loadFlagpack = vi.spyOn(flagpack, "loadFlagpack");
  const [{ default: FideInfo }, { SWRConfig }] = await Promise.all([
    import("./FideInfo"),
    import("swr"),
  ]);
  return {
    FideInfo,
    SWRConfig,
    loadFlagpack,
  };
}

function player(name: string) {
  return {
    id: 1,
    name,
    title: "GM",
    federation: "NOR",
    year: 1990,
    standard: 1500,
    rapid: 1600,
    blitz: 1700,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function renderFideInfo(
  FideInfo: FideInfoComponent,
  SWRConfig: SwrConfigComponent,
  props: FideInfoProps,
  swrValue: SwrConfigValue = { provider: () => new Map() },
) {
  await act(async () => {
    root.render(
      <MantineProvider>
        <SWRConfig value={swrValue}>
          <FideInfo {...props} />
        </SWRConfig>
      </MantineProvider>,
    );
  });
}

// Both queries are scoped to this test's own root, never to `document`. The mutation gate's dry
// run executes every test file in one process, and a document-wide `svg[viewBox="0 0 32 24"]`
// count picked up flags rendered by another file: the two-instance case asserted zero flags and
// found two.
function modalText() {
  return container.querySelector('[role="dialog"]')?.textContent || "";
}

// Below the 5 s default test timeout on purpose. The previous 15 s could never be reached, so a
// flag that never arrived surfaced as a bare "Test timed out in 5000ms" instead of naming the
// count that was wrong. The slowest real `mantine-flagpack` import measured on this tree was
// 206 ms, and every later one under 2 ms.
const FLAG_WAIT_MS = 4_000;

// The retry window the no-retry case waits out: SWR's own error-retry interval, and a pause long
// enough to cover several of them. Both are named for the same reason as `FLAG_WAIT_MS` — the
// relation between them is the point, and a bare `200` beside a bare `10` hides it.
const RETRY_INTERVAL_MS = 10;
const RETRY_WINDOW_MS = 200;

function flagSvgs() {
  return container.querySelectorAll('svg[viewBox="0 0 32 24"]');
}

test("an open modal renders the real federation flag", async () => {
  const { FideInfo, SWRConfig, loadFlagpack } = await importFideInfo();
  mocks.getFidePlayer.mockResolvedValue(player("Magnus"));

  await renderFideInfo(FideInfo, SWRConfig, {
    opened: true,
    setOpened: vi.fn(),
    name: "Magnus",
  });

  await vi.waitFor(() => expect(flagSvgs()).toHaveLength(1), { timeout: FLAG_WAIT_MS });
  expect(loadFlagpack).toHaveBeenCalledOnce();
  expect(modalText()).toContain("Magnus");
});

test("a pending player response renders the loader and loading text", async () => {
  const { FideInfo, SWRConfig } = await importFideInfo();
  let resolvePlayer!: (value: ReturnType<typeof player>) => void;
  mocks.getFidePlayer.mockReturnValue(
    new Promise((resolve) => {
      resolvePlayer = resolve;
    }),
  );

  await renderFideInfo(FideInfo, SWRConfig, {
    opened: true,
    setOpened: vi.fn(),
    name: "Pending Player",
  });

  expect(mocks.getFidePlayer).toHaveBeenCalledWith("Pending Player");
  expect(container.querySelector(".mantine-Loader-root")).not.toBeNull();
  expect(modalText()).toContain("Common.Loading");

  await act(async () => resolvePlayer(player("Pending Player")));
  expect(container.querySelector(".mantine-Loader-root")).toBeNull();
  expect(modalText()).not.toContain("Common.Loading");
});

test("a rejected player response renders translated search error copy without its raw message", async () => {
  const { FideInfo, SWRConfig } = await importFideInfo();
  const rawMessage = "C:\\secret\\path diag";
  mocks.getFidePlayer.mockRejectedValue(new Error(rawMessage));

  await renderFideInfo(FideInfo, SWRConfig, {
    opened: true,
    setOpened: vi.fn(),
    name: "Test Player",
  });

  await vi.waitFor(() => {
    expect(modalText()).toContain("Databases.FIDE.SearchError");
    expect(modalText()).not.toContain(rawMessage);
  });
});

test("a rejected flag import is silent and does not retry", async () => {
  const { FideInfo, SWRConfig, loadFlagpack } = await importFideInfo({ rejectFlagpack: true });
  mocks.getFidePlayer.mockResolvedValue(player("Test Player"));

  // Real timers with a short retry interval, not fake timers: this file mocks modules and
  // imports the component dynamically, and freezing the clock across that made the case
  // order-dependent under Stryker's full-suite dry run. `errorRetryInterval` shortens the
  // window the assertion below waits out; it deliberately does NOT set `shouldRetryOnError`,
  // which is the property under test — delete it from `FideInfo` and this case goes red.
  await renderFideInfo(
    FideInfo,
    SWRConfig,
    { opened: true, setOpened: vi.fn(), name: "Test Player" },
    { provider: () => new Map(), errorRetryInterval: RETRY_INTERVAL_MS },
  );
  await vi.waitFor(() => expect(loadFlagpack).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(modalText()).toContain("Test Player"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, RETRY_WINDOW_MS));
  });

  expect(loadFlagpack).toHaveBeenCalledOnce();
  expect(modalText()).toContain("GM");
  expect(modalText()).toContain("1500");
  expect(modalText()).toContain("1600");
  expect(modalText()).toContain("1700");
  expect(modalText()).not.toMatch(/error/i);
  expect(flagSvgs()).toHaveLength(0);
});

test("a fresh mount after a rejection makes one new flag-pack attempt", async () => {
  const { FideInfo, SWRConfig, loadFlagpack } = await importFideInfo({ rejectFlagpack: true });
  mocks.getFidePlayer.mockResolvedValue(player("Reopened Player"));
  const swrValue = { provider: () => new Map() };
  const props = { setOpened: vi.fn(), name: "Reopened Player" };

  await renderFideInfo(FideInfo, SWRConfig, { ...props, opened: true }, swrValue);
  await vi.waitFor(() => expect(loadFlagpack).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(modalText()).toContain("Reopened Player"));

  // The component is unmounted between the two opens, not merely closed. Closing it leaves a
  // mounted hook whose key goes null, and whether its revalidator is deregistered before the
  // reopen re-registers one is a React scheduling detail, not a contract: under Stryker's
  // full-suite run this case saw one call, under a single-file run two. What SWR does guarantee
  // is the pair this file pins at both ends — a fresh mount with no live revalidator on the key
  // revalidates once (here), and a mount while another revalidator on that key already holds the
  // error does not revalidate at all (the next case).
  await act(async () => root.render(null));
  await renderFideInfo(FideInfo, SWRConfig, { ...props, opened: true }, swrValue);
  await vi.waitFor(() => expect(loadFlagpack).toHaveBeenCalledTimes(2));

  expect(modalText()).toContain("Reopened Player");
  expect(flagSvgs()).toHaveLength(0);
});

test("a closed modal does not start either lookup", async () => {
  const { FideInfo, SWRConfig, loadFlagpack } = await importFideInfo();

  await renderFideInfo(FideInfo, SWRConfig, {
    opened: false,
    setOpened: vi.fn(),
    name: "Closed Player",
  });

  expect(mocks.getFidePlayer).not.toHaveBeenCalled();
  expect(loadFlagpack).not.toHaveBeenCalled();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(flagSvgs()).toHaveLength(0);
});

test("a second mounted instance suppresses a retry after a shared failure", async () => {
  const { FideInfo, SWRConfig, loadFlagpack } = await importFideInfo({ rejectFlagpack: true });
  mocks.getFidePlayer.mockImplementation(async (name: string) => player(name));
  const swrValue = { provider: () => new Map() };

  async function renderPair(whiteOpened: boolean) {
    await act(async () => {
      root.render(
        <MantineProvider>
          <SWRConfig value={swrValue}>
            <FideInfo opened={whiteOpened} setOpened={vi.fn()} name="White Player" />
            <FideInfo opened={true} setOpened={vi.fn()} name="Black Player" />
          </SWRConfig>
        </MantineProvider>,
      );
    });
  }

  await renderPair(true);
  await vi.waitFor(() => expect(loadFlagpack).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(container.textContent).toContain("Black Player"));

  await renderPair(false);
  await renderPair(true);

  expect(loadFlagpack).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("Common.Loading");
  expect(flagSvgs()).toHaveLength(0);
});

test("a player named fide-flagpack keeps the player and flag SWR entries separate", async () => {
  const { FideInfo, SWRConfig, loadFlagpack } = await importFideInfo();
  mocks.getFidePlayer.mockResolvedValue(player("fide-flagpack"));

  await renderFideInfo(FideInfo, SWRConfig, {
    opened: true,
    setOpened: vi.fn(),
    name: "fide-flagpack",
  });

  await vi.waitFor(() => expect(flagSvgs()).toHaveLength(1), { timeout: FLAG_WAIT_MS });
  expect(loadFlagpack).toHaveBeenCalledOnce();
  expect(mocks.getFidePlayer).toHaveBeenCalledWith("fide-flagpack");
  expect(modalText()).toContain("fide-flagpack");
});
