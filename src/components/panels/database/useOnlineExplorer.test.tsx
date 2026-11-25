import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, type Cache } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExplorerOnlineSource } from "@/state/atoms";
import type { LichessGamesOptions, MasterGamesOptions } from "@/utils/lichess/explorer";
import { DEFAULT_LICHESS_OPTIONS, DEFAULT_MASTER_OPTIONS } from "@/state/atoms";
import { useOnlineExplorer } from "./useOnlineExplorer";

const mocks = vi.hoisted(() => ({
  getLichessGames: vi.fn(),
  getMasterGames: vi.fn(),
  convertToNormalized: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  default: { t: (key: string) => key },
}));
vi.mock("@/utils/lichess/api", () => ({
  getLichessGames: mocks.getLichessGames,
  getMasterGames: mocks.getMasterGames,
  convertToNormalized: mocks.convertToNormalized,
}));

const position = {
  white: 100,
  black: 80,
  draws: 20,
  moves: [{ uci: "e2e4", san: "e4", averageRating: 2000, white: 50, black: 40, draws: 10 }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function Consumer({
  source = "lch_all",
  fen = "start",
  handle = "token",
  enabled = true,
  options = DEFAULT_LICHESS_OPTIONS as LichessGamesOptions | MasterGamesOptions,
}: {
  source?: ExplorerOnlineSource;
  fen?: string;
  handle?: string | undefined;
  enabled?: boolean;
  options?: LichessGamesOptions | MasterGamesOptions;
}) {
  const result = useOnlineExplorer(source, fen, options, handle, enabled);
  return <span data-source={source}>{JSON.stringify(result)}</span>;
}

let root: Root;
let container: HTMLDivElement;
let cache: Cache;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  mocks.getLichessGames.mockReset().mockResolvedValue(position);
  mocks.getMasterGames.mockReset().mockResolvedValue(position);
  mocks.convertToNormalized.mockReset().mockResolvedValue({ games: [], failures: [] });
  cache = new Map();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(nodes: { key: string; props?: React.ComponentProps<typeof Consumer> }[]) {
  await act(async () =>
    root.render(
      <SWRConfig
        value={{
          provider: () => cache,
          dedupingInterval: 0,
          shouldRetryOnError: true,
          errorRetryInterval: 20,
          errorRetryCount: 3,
        }}
      >
        {nodes.map(({ key, props }) => (
          <Consumer key={key} {...props} />
        ))}
      </SWRConfig>,
    ),
  );
}

function resultOf(source: ExplorerOnlineSource = "lch_all") {
  const node = container.querySelector(`[data-source="${source}"]`);
  return JSON.parse(node!.textContent!);
}

test("there is no request without an account", async () => {
  await render([{ key: "one", props: { handle: "" } }]);
  expect(mocks.getLichessGames).not.toHaveBeenCalled();
  expect(resultOf()).toMatchObject({ loading: false, openings: [] });
  expect(resultOf().error).toBeUndefined();
});

test("a new position supersedes the previous request and its late answer is not shown", async () => {
  const old = deferred<typeof position>();
  const fresh = deferred<typeof position>();
  mocks.getLichessGames.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  await render([{ key: "one" }]);
  await render([{ key: "one", props: { fen: "next" } }]);
  expect(mocks.getLichessGames.mock.calls[0][0]).toBe("start");
  expect(mocks.getLichessGames.mock.calls[1][0]).toBe("next");
  await act(async () =>
    fresh.resolve({
      ...position,
      moves: [{ ...position.moves[0], san: "fresh" }],
    }),
  );
  await act(async () =>
    old.resolve({
      ...position,
      moves: [{ ...position.moves[0], san: "stale" }],
    }),
  );
  expect(container.textContent).toContain("fresh");
  expect(container.textContent).not.toContain("stale");
});

test("unmounting aborts the in-flight request", async () => {
  const pending = deferred<{ games: []; failures: [] }>();
  let signal: AbortSignal | undefined;
  mocks.convertToNormalized.mockImplementation((_games, opts?: { signal?: AbortSignal }) => {
    signal = opts?.signal;
    return pending.promise;
  });
  await render([{ key: "one" }]);
  await act(async () => {});
  expect(mocks.getLichessGames).toHaveBeenCalledOnce();
  expect(signal).toBeDefined();
  expect(signal!.aborted).toBe(false);
  await render([]);
  await act(async () => {
    await Promise.resolve();
  });
  expect(signal!.aborted).toBe(true);
  expect(container.textContent).toBe("");
});

test("changing options starts a new request and a late answer for the old options is not shown", async () => {
  const old = deferred<typeof position>();
  const fresh = deferred<typeof position>();
  mocks.getLichessGames.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  await render([{ key: "one" }]);
  const nextOptions = { ...DEFAULT_LICHESS_OPTIONS, ratings: [2000] as const };
  await render([{ key: "one", props: { options: nextOptions } }]);
  expect(mocks.getLichessGames).toHaveBeenCalledTimes(2);
  expect(mocks.getLichessGames.mock.calls[0][1]).toEqual(DEFAULT_LICHESS_OPTIONS);
  expect(mocks.getLichessGames.mock.calls[1][1]).toEqual(nextOptions);
  await act(async () =>
    fresh.resolve({
      ...position,
      moves: [{ ...position.moves[0], san: "fresh" }],
    }),
  );
  await act(async () =>
    old.resolve({
      ...position,
      moves: [{ ...position.moves[0], san: "stale" }],
    }),
  );
  expect(container.textContent).toContain("fresh");
  expect(container.textContent).not.toContain("stale");
});

test("changing handle starts a new request and a late answer for the old handle is not shown", async () => {
  const old = deferred<typeof position>();
  const fresh = deferred<typeof position>();
  mocks.getLichessGames.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  await render([{ key: "one" }]);
  await render([{ key: "one", props: { handle: "other" } }]);
  expect(mocks.getLichessGames).toHaveBeenCalledTimes(2);
  expect(mocks.getLichessGames.mock.calls[0][2]).toBe("token");
  expect(mocks.getLichessGames.mock.calls[1][2]).toBe("other");
  await act(async () =>
    fresh.resolve({
      ...position,
      moves: [{ ...position.moves[0], san: "fresh" }],
    }),
  );
  await act(async () =>
    old.resolve({
      ...position,
      moves: [{ ...position.moves[0], san: "stale" }],
    }),
  );
  expect(container.textContent).toContain("fresh");
  expect(container.textContent).not.toContain("stale");
});

test("enabled false with a handle sends no request", async () => {
  await render([{ key: "one", props: { enabled: false, handle: "token" } }]);
  expect(mocks.getLichessGames).not.toHaveBeenCalled();
  expect(resultOf()).toMatchObject({ loading: false, openings: [] });
  expect(resultOf().error).toBeUndefined();
});

test("two Lichess columns produce two independent requests", async () => {
  await render([
    { key: "all", props: { source: "lch_all" } },
    {
      key: "master",
      props: { source: "lch_master", options: DEFAULT_MASTER_OPTIONS },
    },
  ]);
  await act(async () => {});
  expect(mocks.getLichessGames).toHaveBeenCalledOnce();
  expect(mocks.getMasterGames).toHaveBeenCalledOnce();
  expect(resultOf("lch_all").openings[0].move).toBe("e4");
  expect(resultOf("lch_master").openings[0].move).toBe("e4");
  expect(resultOf("lch_all").total).toEqual({ move: "", white: 100, black: 80, draw: 20 });
});

test("a failed request is not asked again by itself, and a changed or returned position each asks again", async () => {
  mocks.getLichessGames.mockRejectedValue(new Error("rate limited"));
  await render([{ key: "one" }]);
  await act(async () => {});
  const failed = mocks.getLichessGames.mock.calls.length;
  expect(failed).toBeGreaterThanOrEqual(1);
  expect(resultOf().error).toBe("Board.Database.ExplorerLoadError");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  expect(mocks.getLichessGames).toHaveBeenCalledTimes(failed);

  mocks.getLichessGames.mockResolvedValue(position);
  await render([{ key: "one", props: { fen: "next" } }]);
  await act(async () => {});
  expect(mocks.getLichessGames).toHaveBeenCalledTimes(failed + 1);

  mocks.getLichessGames.mockRejectedValueOnce(new Error("again"));
  await render([{ key: "one" }]);
  await act(async () => {});
  expect(mocks.getLichessGames).toHaveBeenCalledTimes(failed + 2);
});

test("a successful answer is reused on return; a failed answer is asked again", async () => {
  await render([{ key: "one" }]);
  await act(async () => {});
  expect(mocks.getLichessGames).toHaveBeenCalledTimes(1);
  expect(resultOf().openings[0].move).toBe("e4");

  await render([{ key: "one", props: { fen: "next" } }]);
  await act(async () => {});
  expect(mocks.getLichessGames).toHaveBeenCalledTimes(2);

  await render([{ key: "one" }]);
  await act(async () => {});
  expect(mocks.getLichessGames).toHaveBeenCalledTimes(2);

  mocks.getLichessGames.mockRejectedValue(new Error("rate limited"));
  await render([{ key: "one", props: { fen: "fail" } }]);
  await act(async () => {});
  const failed = mocks.getLichessGames.mock.calls.length;
  expect(resultOf().error).toBe("Board.Database.ExplorerLoadError");

  await render([{ key: "one", props: { fen: "other" } }]);
  await act(async () => {});
  expect(mocks.getLichessGames).toHaveBeenCalledTimes(failed + 1);

  await render([{ key: "one", props: { fen: "fail" } }]);
  await act(async () => {});
  expect(mocks.getLichessGames).toHaveBeenCalledTimes(failed + 2);
});
