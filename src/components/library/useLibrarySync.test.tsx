import type {
  DatabaseHandle,
  FileWorkspaceHandle,
  LibrarySyncChanged,
  LibrarySyncSnapshot,
} from "@/bindings";
import { LibrarySyncCommandError } from "@/platform/chessriddle";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIBRARY_SYNC_RETRY_BACKOFF_MS,
  useLibrarySync,
  type UseLibrarySyncResult,
} from "./useLibrarySync";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({
  librarySyncSnapshot: vi.fn(),
  librarySyncTurnOn: vi.fn(),
  librarySyncTurnOff: vi.fn(),
  librarySyncSetFileSelected: vi.fn(),
  librarySyncNow: vi.fn(),
  librarySyncChanged: vi.fn(),
  warnSafely: vi.fn(),
}));

vi.mock("@/platform/tauri", () => ({
  tauri: {
    librarySyncSnapshot: mocks.librarySyncSnapshot,
    librarySyncTurnOn: mocks.librarySyncTurnOn,
    librarySyncTurnOff: mocks.librarySyncTurnOff,
    librarySyncSetFileSelected: mocks.librarySyncSetFileSelected,
    librarySyncNow: mocks.librarySyncNow,
  },
  tauriSubscriptions: {
    librarySyncChanged: mocks.librarySyncChanged,
  },
}));

vi.mock("@/platform/errors", async () => ({
  ...(await vi.importActual<typeof import("@/platform/errors")>("@/platform/errors")),
  warnSafely: mocks.warnSafely,
}));

function makeWorkspace(id: string): FileWorkspaceHandle {
  return { id: { id }, kind: "fileWorkspace" };
}

function makeSnapshot(
  workspace: FileWorkspaceHandle,
  revision: number,
  state: LibrarySyncSnapshot["state"] = { status: "off" },
  active = state.status !== "off",
): LibrarySyncSnapshot {
  return {
    workspace,
    revision,
    available: true,
    active,
    state,
    files: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let root: Root;
let host: HTMLDivElement;

function Harness({
  workspace,
  onValue,
}: {
  workspace: FileWorkspaceHandle | null;
  onValue: (value: UseLibrarySyncResult) => void;
}) {
  const value = useLibrarySync(workspace);
  onValue(value);
  return null;
}

describe("useLibrarySync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("attaches listener before fetching snapshot and applies updates", async () => {
    const ws = makeWorkspace("ws-1");
    const order: string[] = [];
    const unlisten = vi.fn();
    mocks.librarySyncChanged.mockImplementation(async () => {
      order.push("listen");
      return unlisten;
    });
    mocks.librarySyncSnapshot.mockImplementation(async () => {
      order.push("snapshot");
      return makeSnapshot(ws, 2, { status: "synced" });
    });

    let latest!: UseLibrarySyncResult;
    await act(async () => {
      root.render(
        <Harness
          workspace={ws}
          onValue={(v) => {
            latest = v;
          }}
        />,
      );
    });

    expect(latest.snapshot?.revision).toBe(2);
    expect(order).toEqual(["listen", "snapshot"]);

    await act(async () => root.unmount());
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("resets state on workspace change and ignores stale answers from the previous workspace", async () => {
    const ws1 = makeWorkspace("ws-1");
    const ws2 = makeWorkspace("ws-2");
    const firstFetch = deferred<LibrarySyncSnapshot>();
    const secondFetch = deferred<LibrarySyncSnapshot>();

    mocks.librarySyncChanged.mockResolvedValue(vi.fn());
    mocks.librarySyncSnapshot
      .mockReturnValueOnce(firstFetch.promise)
      .mockReturnValueOnce(secondFetch.promise);

    let latest!: UseLibrarySyncResult;
    await act(async () => {
      root.render(
        <Harness
          workspace={ws1}
          onValue={(v) => {
            latest = v;
          }}
        />,
      );
    });
    expect(mocks.librarySyncSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <Harness
          workspace={ws2}
          onValue={(v) => {
            latest = v;
          }}
        />,
      );
    });
    expect(mocks.librarySyncSnapshot).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondFetch.resolve(makeSnapshot(ws2, 1, { status: "synced" }));
    });
    expect(latest.snapshot?.workspace).toEqual(ws2);

    await act(async () => {
      firstFetch.resolve(makeSnapshot(ws1, 99, { status: "offline" }));
    });
    expect(latest.snapshot?.workspace).toEqual(ws2);
    expect(latest.snapshot?.revision).toBe(1);

    await act(async () => {
      root.render(
        <Harness
          workspace={null}
          onValue={(v) => {
            latest = v;
          }}
        />,
      );
    });
    expect(latest.snapshot).toBeNull();
  });

  it("handles an event arriving before the first snapshot answer and skips stale events", async () => {
    const ws = makeWorkspace("ws-1");
    let listener: ((event: { payload: LibrarySyncChanged }) => void) | null = null;
    const firstFetch = deferred<LibrarySyncSnapshot>();
    const secondFetch = deferred<LibrarySyncSnapshot>();

    mocks.librarySyncChanged.mockImplementation(async (cb) => {
      listener = cb;
      return vi.fn();
    });
    mocks.librarySyncSnapshot
      .mockReturnValueOnce(firstFetch.promise)
      .mockReturnValueOnce(secondFetch.promise);

    let latest!: UseLibrarySyncResult;
    await act(async () => {
      root.render(
        <Harness
          workspace={ws}
          onValue={(v) => {
            latest = v;
          }}
        />,
      );
    });
    expect(listener).not.toBeNull();
    expect(mocks.librarySyncSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      listener?.({ payload: { revision: 5 } });
    });
    expect(mocks.librarySyncSnapshot).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondFetch.resolve(makeSnapshot(ws, 5, { status: "synced" }));
    });
    expect(latest.snapshot?.revision).toBe(5);

    await act(async () => {
      firstFetch.resolve(makeSnapshot(ws, 2, { status: "syncing", done: 1, total: 3 }));
    });
    expect(latest.snapshot?.revision).toBe(5);
    expect(latest.snapshot?.state).toEqual({ status: "synced" });

    // Stale event with revision <= watermark does not trigger a refetch.
    await act(async () => {
      listener?.({ payload: { revision: 5 } });
      listener?.({ payload: { revision: 4 } });
    });
    expect(mocks.librarySyncSnapshot).toHaveBeenCalledTimes(2);
  });

  it("unlistens cleanly when unmounted before the listener promise resolves", async () => {
    const ws = makeWorkspace("ws-1");
    const subscribe = deferred<() => void>();
    const unlisten = vi.fn();
    mocks.librarySyncChanged.mockReturnValue(subscribe.promise);

    await act(async () => {
      root.render(<Harness workspace={ws} onValue={() => {}} />);
    });
    await act(async () => root.unmount());

    await act(async () => {
      subscribe.resolve(unlisten);
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(mocks.librarySyncSnapshot).not.toHaveBeenCalled();
  });

  it("invokes turnOn, turnOff, setFileSelected and syncNow through the platform facade for both PGN and database handles", async () => {
    const ws = makeWorkspace("ws-1");
    const file = makeWorkspace("file-1");
    const db: DatabaseHandle = { id: { id: "db-1" }, kind: "database" };
    mocks.librarySyncChanged.mockResolvedValue(vi.fn());
    mocks.librarySyncSnapshot.mockResolvedValue(makeSnapshot(ws, 1, { status: "off" }, false));
    mocks.librarySyncTurnOn.mockResolvedValue(
      makeSnapshot(ws, 2, { status: "syncing", done: 0, total: 1 }, true),
    );
    mocks.librarySyncSetFileSelected.mockResolvedValue(
      makeSnapshot(ws, 3, { status: "synced" }, true),
    );
    mocks.librarySyncNow.mockResolvedValue(makeSnapshot(ws, 4, { status: "synced" }, true));
    mocks.librarySyncTurnOff.mockResolvedValue(makeSnapshot(ws, 5, { status: "off" }, false));

    let latest!: UseLibrarySyncResult;
    await act(async () => {
      root.render(
        <Harness
          workspace={ws}
          onValue={(v) => {
            latest = v;
          }}
        />,
      );
    });
    expect(latest.snapshot?.revision).toBe(1);

    await act(async () => {
      await latest.turnOn([file, db]);
    });
    expect(mocks.librarySyncTurnOn).toHaveBeenCalledWith(ws, [file, db]);
    expect(latest.snapshot?.revision).toBe(2);

    await act(async () => {
      await latest.setFileSelected(db, true);
    });
    expect(mocks.librarySyncSetFileSelected).toHaveBeenCalledWith(ws, db, true);
    expect(latest.snapshot?.revision).toBe(3);

    await act(async () => {
      await latest.syncNow();
    });
    expect(mocks.librarySyncNow).toHaveBeenCalledWith(ws);
    expect(latest.snapshot?.revision).toBe(4);

    await act(async () => {
      await latest.turnOff("keep");
    });
    expect(mocks.librarySyncTurnOff).toHaveBeenCalledWith(ws, "keep");
    expect(latest.snapshot?.revision).toBe(5);
  });

  it("logs an initial snapshot failure with redacted details and retries with bounded backoff", async () => {
    vi.useFakeTimers();
    const ws = makeWorkspace("ws-1");
    mocks.librarySyncChanged.mockResolvedValue(vi.fn());
    mocks.librarySyncSnapshot.mockRejectedValue(new LibrarySyncCommandError("localStorage"));

    let latest!: UseLibrarySyncResult;
    await act(async () => {
      root.render(
        <Harness
          workspace={ws}
          onValue={(v) => {
            latest = v;
          }}
        />,
      );
    });

    expect(latest.snapshot).toBeNull();
    expect(latest.error).toBe("localStorage");
    expect(mocks.librarySyncSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.warnSafely).toHaveBeenCalledWith(
      expect.stringContaining("Library sync snapshot failed:"),
    );
    expect(mocks.warnSafely).toHaveBeenCalledWith(expect.stringContaining("localStorage"));

    // Advances through all three bounded backoff steps (2s, 10s, 30s) and stops afterwards.
    for (const [index, delayMs] of LIBRARY_SYNC_RETRY_BACKOFF_MS.entries()) {
      expect(vi.getTimerCount()).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delayMs);
      });
      expect(mocks.librarySyncSnapshot).toHaveBeenCalledTimes(index + 2);
    }
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.librarySyncSnapshot).toHaveBeenCalledTimes(4);
  });

  it("clears pending retry timers on workspace change and unmount, and restarts backoff from step 1", async () => {
    vi.useFakeTimers();
    const ws1 = makeWorkspace("ws-1");
    const ws2 = makeWorkspace("ws-2");
    const ws2FirstFetch = deferred<LibrarySyncSnapshot>();

    mocks.librarySyncChanged.mockResolvedValue(vi.fn());
    mocks.librarySyncSnapshot.mockRejectedValue(new Error("ipc channel closed"));

    await act(async () => {
      root.render(<Harness workspace={ws1} onValue={() => {}} />);
    });
    expect(mocks.warnSafely).toHaveBeenCalledWith(
      "Library sync snapshot failed: ipc channel closed",
    );
    expect(vi.getTimerCount()).toBe(1);

    // Advance past the first step (2s) so ws1 is now waiting on the second step (10s).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIBRARY_SYNC_RETRY_BACKOFF_MS[0]);
    });
    expect(mocks.librarySyncSnapshot).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    // Switch workspace while the second-step timer is still pending: pending timer must be cleared.
    mocks.librarySyncChanged.mockRejectedValueOnce(new Error("listener init failed"));
    mocks.librarySyncSnapshot.mockReturnValueOnce(ws2FirstFetch.promise);
    await act(async () => {
      root.render(<Harness workspace={ws2} onValue={() => {}} />);
    });
    expect(mocks.warnSafely).toHaveBeenCalledWith(
      "Library sync listener failed: listener init failed",
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.librarySyncSnapshot).toHaveBeenCalledTimes(3);

    // When ws2's initial snapshot fails, backoff must restart from the first step (2s, not 10s).
    await act(async () => {
      ws2FirstFetch.reject(new LibrarySyncCommandError("unavailable"));
    });
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIBRARY_SYNC_RETRY_BACKOFF_MS[0]);
    });
    expect(mocks.librarySyncSnapshot).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(1);

    // Unmount while ws2 has a pending retry timer: no timer remains.
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mocks.librarySyncSnapshot).toHaveBeenCalledTimes(4);
  });

  it("keeps the last snapshot, sets error, and schedules no retry when a later snapshot fails", async () => {
    vi.useFakeTimers();
    const ws = makeWorkspace("ws-1");
    let listener: ((event: { payload: LibrarySyncChanged }) => void) | null = null;
    mocks.librarySyncChanged.mockImplementation(async (cb) => {
      listener = cb;
      return vi.fn();
    });
    mocks.librarySyncSnapshot
      .mockResolvedValueOnce(makeSnapshot(ws, 1, { status: "synced" }, true))
      .mockRejectedValueOnce(new LibrarySyncCommandError("localStorage"));

    let latest!: UseLibrarySyncResult;
    await act(async () => {
      root.render(<Harness workspace={ws} onValue={(v) => (latest = v)} />);
    });
    expect(latest.snapshot?.revision).toBe(1);
    expect(latest.error).toBeNull();

    await act(async () => {
      listener?.({ payload: { revision: 2 } });
    });
    expect(latest.snapshot?.revision).toBe(1);
    expect(latest.snapshot?.state).toEqual({ status: "synced" });
    expect(latest.error).toBe("localStorage");
    expect(mocks.warnSafely).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports an action's own failure and clears it on a later success", async () => {
    const ws = makeWorkspace("ws-1");
    mocks.librarySyncChanged.mockResolvedValue(vi.fn());
    mocks.librarySyncSnapshot.mockResolvedValue(makeSnapshot(ws, 1, { status: "synced" }, true));
    mocks.librarySyncNow
      .mockRejectedValueOnce(new LibrarySyncCommandError("busy"))
      .mockResolvedValueOnce(makeSnapshot(ws, 2, { status: "synced" }, true));

    let latest!: UseLibrarySyncResult;
    await act(async () => {
      root.render(<Harness workspace={ws} onValue={(v) => (latest = v)} />);
    });
    expect(latest.error).toBeNull();

    await act(async () => {
      await latest.syncNow();
    });
    expect(latest.error).toBe("busy");
    expect(latest.snapshot?.revision).toBe(1);

    await act(async () => {
      await latest.syncNow();
    });
    expect(latest.error).toBeNull();
    expect(latest.snapshot?.revision).toBe(2);
  });

  it("ignores an older snapshot resolving after a newer action failed", async () => {
    const ws = makeWorkspace("ws-1");
    let listener: ((event: { payload: LibrarySyncChanged }) => void) | null = null;
    const olderRefresh = deferred<LibrarySyncSnapshot>();
    const newerAction = deferred<LibrarySyncSnapshot>();

    mocks.librarySyncChanged.mockImplementation(async (cb) => {
      listener = cb;
      return vi.fn();
    });
    mocks.librarySyncSnapshot
      .mockResolvedValueOnce(makeSnapshot(ws, 1, { status: "synced" }, true))
      .mockReturnValueOnce(olderRefresh.promise);
    mocks.librarySyncNow.mockReturnValueOnce(newerAction.promise);

    let latest!: UseLibrarySyncResult;
    await act(async () => {
      root.render(<Harness workspace={ws} onValue={(v) => (latest = v)} />);
    });
    expect(latest.snapshot?.revision).toBe(1);

    let actionPromise!: Promise<void>;
    await act(async () => {
      listener?.({ payload: { revision: 2 } });
      actionPromise = latest.syncNow();
    });

    // Newer action fails first: records error and advances settled sequence.
    await act(async () => {
      newerAction.reject(new LibrarySyncCommandError("localStorage"));
      await actionPromise;
    });
    expect(latest.error).toBe("localStorage");
    expect(latest.snapshot?.revision).toBe(1);

    // Older snapshot resolves later: must not replace the snapshot or clear the newer error.
    await act(async () => {
      olderRefresh.resolve(makeSnapshot(ws, 2, { status: "syncing", done: 1, total: 2 }, true));
    });
    expect(latest.error).toBe("localStorage");
    expect(latest.snapshot?.revision).toBe(1);
    expect(latest.snapshot?.state).toEqual({ status: "synced" });
  });

  it("ignores responses from an earlier session after a ws1 -> ws2 -> ws1 round trip", async () => {
    const ws1 = makeWorkspace("ws-1");
    const ws2 = makeWorkspace("ws-2");
    const firstWs1Fetch = deferred<LibrarySyncSnapshot>();
    const ws2Fetch = deferred<LibrarySyncSnapshot>();
    const secondWs1Fetch = deferred<LibrarySyncSnapshot>();

    mocks.librarySyncChanged.mockResolvedValue(vi.fn());
    mocks.librarySyncSnapshot
      .mockReturnValueOnce(firstWs1Fetch.promise)
      .mockReturnValueOnce(ws2Fetch.promise)
      .mockReturnValueOnce(secondWs1Fetch.promise);

    let latest!: UseLibrarySyncResult;
    await act(async () => {
      root.render(<Harness workspace={ws1} onValue={(v) => (latest = v)} />);
    });
    await act(async () => {
      root.render(<Harness workspace={ws2} onValue={(v) => (latest = v)} />);
    });
    await act(async () => {
      root.render(<Harness workspace={ws1} onValue={(v) => (latest = v)} />);
    });

    // The first ws1 request settles after the round trip: it must NOT populate the new ws1 session.
    await act(async () => {
      firstWs1Fetch.resolve(makeSnapshot(ws1, 99, { status: "offline" }, true));
    });
    expect(latest.snapshot).toBeNull();

    await act(async () => {
      secondWs1Fetch.resolve(makeSnapshot(ws1, 1, { status: "synced" }, true));
    });
    expect(latest.snapshot?.revision).toBe(1);
    expect(latest.snapshot?.state).toEqual({ status: "synced" });
  });

  it("orders overlapping requests so a late older failure cannot overwrite a newer success and counts busy actions", async () => {
    const ws = makeWorkspace("ws-1");
    const firstAction = deferred<LibrarySyncSnapshot>();
    const secondAction = deferred<LibrarySyncSnapshot>();

    mocks.librarySyncChanged.mockResolvedValue(vi.fn());
    mocks.librarySyncSnapshot.mockResolvedValue(makeSnapshot(ws, 1, { status: "synced" }, true));
    mocks.librarySyncNow
      .mockReturnValueOnce(firstAction.promise)
      .mockReturnValueOnce(secondAction.promise);

    let latest!: UseLibrarySyncResult;
    await act(async () => {
      root.render(<Harness workspace={ws} onValue={(v) => (latest = v)} />);
    });
    expect(latest.snapshot?.revision).toBe(1);

    let p1!: Promise<void>;
    let p2!: Promise<void>;
    await act(async () => {
      p1 = latest.syncNow();
      p2 = latest.syncNow();
    });
    expect(latest.busy).toBe(true);

    // Newer action resolves first: snapshot updates and busy remains true while action 1 is still running.
    await act(async () => {
      secondAction.resolve(makeSnapshot(ws, 2, { status: "synced" }, true));
      await p2;
    });
    expect(latest.snapshot?.revision).toBe(2);
    expect(latest.error).toBeNull();
    expect(latest.busy).toBe(true);

    // Older action rejects late: must not overwrite newer success with an error, and clears busy.
    await act(async () => {
      firstAction.reject(new LibrarySyncCommandError("busy"));
      await p1;
    });
    expect(latest.snapshot?.revision).toBe(2);
    expect(latest.error).toBeNull();
    expect(latest.busy).toBe(false);
  });

  it("does not tear down the listener when given an equal workspace handle in a new object", async () => {
    const unlisten = vi.fn();
    mocks.librarySyncChanged.mockResolvedValue(unlisten);
    mocks.librarySyncSnapshot.mockResolvedValue(
      makeSnapshot(makeWorkspace("ws-1"), 3, { status: "synced" }, true),
    );

    let latest!: UseLibrarySyncResult;
    await act(async () => {
      root.render(<Harness workspace={makeWorkspace("ws-1")} onValue={(v) => (latest = v)} />);
    });
    expect(mocks.librarySyncChanged).toHaveBeenCalledTimes(1);
    expect(mocks.librarySyncSnapshot).toHaveBeenCalledTimes(1);
    expect(latest.snapshot?.revision).toBe(3);

    await act(async () => {
      root.render(<Harness workspace={makeWorkspace("ws-1")} onValue={(v) => (latest = v)} />);
    });
    expect(unlisten).not.toHaveBeenCalled();
    expect(mocks.librarySyncChanged).toHaveBeenCalledTimes(1);
    expect(mocks.librarySyncSnapshot).toHaveBeenCalledTimes(1);
    expect(latest.snapshot?.revision).toBe(3);
  });

  it("never exposes the previous workspace snapshot during the commit that switches workspaces", async () => {
    const ws1 = makeWorkspace("ws-1");
    const ws2 = makeWorkspace("ws-2");
    const ws2Fetch = deferred<LibrarySyncSnapshot>();

    mocks.librarySyncChanged.mockResolvedValue(vi.fn());
    mocks.librarySyncSnapshot
      .mockResolvedValueOnce(makeSnapshot(ws1, 1, { status: "synced" }, true))
      .mockReturnValueOnce(ws2Fetch.promise);

    const observed: Array<{ ws: string | null; snapWs: string | null }> = [];
    await act(async () => {
      root.render(
        <Harness
          workspace={ws1}
          onValue={(v) =>
            observed.push({ ws: "ws-1", snapWs: v.snapshot?.workspace.id.id ?? null })
          }
        />,
      );
    });
    expect(observed.at(-1)).toEqual({ ws: "ws-1", snapWs: "ws-1" });

    observed.length = 0;
    await act(async () => {
      root.render(
        <Harness
          workspace={ws2}
          onValue={(v) =>
            observed.push({ ws: "ws-2", snapWs: v.snapshot?.workspace.id.id ?? null })
          }
        />,
      );
    });
    // Even on the very first render for ws-2 (before useEffect runs), ws-1's snapshot is never exposed.
    expect(observed.every((entry) => entry.snapWs === null)).toBe(true);
  });

  it("releases busy on workspace change while an action is in flight and ignores the late answer", async () => {
    const ws1 = makeWorkspace("ws-1");
    const ws2 = makeWorkspace("ws-2");
    const inFlightTurnOn = deferred<LibrarySyncSnapshot>();

    mocks.librarySyncChanged.mockResolvedValue(vi.fn());
    mocks.librarySyncSnapshot
      .mockResolvedValueOnce(makeSnapshot(ws1, 1, { status: "off" }, false))
      .mockResolvedValueOnce(makeSnapshot(ws2, 1, { status: "off" }, false));
    mocks.librarySyncTurnOn.mockReturnValueOnce(inFlightTurnOn.promise);

    let latest!: UseLibrarySyncResult;
    await act(async () => {
      root.render(<Harness workspace={ws1} onValue={(v) => (latest = v)} />);
    });

    let actionPromise!: Promise<void>;
    await act(async () => {
      actionPromise = latest.turnOn([]);
    });
    expect(latest.busy).toBe(true);

    await act(async () => {
      root.render(<Harness workspace={ws2} onValue={(v) => (latest = v)} />);
    });
    expect(latest.busy).toBe(false);
    expect(latest.snapshot?.workspace).toEqual(ws2);

    await act(async () => {
      inFlightTurnOn.resolve(makeSnapshot(ws1, 9, { status: "synced" }, true));
      await actionPromise;
    });
    expect(latest.busy).toBe(false);
    expect(latest.snapshot?.workspace).toEqual(ws2);
    expect(latest.snapshot?.state).toEqual({ status: "off" });
  });
});
