import type { FileWorkspaceHandle, LibrarySyncChanged, LibrarySyncSnapshot } from "@/bindings";
import { LibrarySyncCommandError } from "@/platform/chessriddle";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLibrarySync, type UseLibrarySyncResult } from "./useLibrarySync";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({
  librarySyncSnapshot: vi.fn(),
  librarySyncTurnOn: vi.fn(),
  librarySyncTurnOff: vi.fn(),
  librarySyncSetFileSelected: vi.fn(),
  librarySyncNow: vi.fn(),
  librarySyncChanged: vi.fn(),
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

function makeWorkspace(id: string): FileWorkspaceHandle {
  return { id: { id }, kind: "fileWorkspace" };
}

function makeSnapshot(
  workspace: FileWorkspaceHandle,
  revision: number,
  state: LibrarySyncSnapshot["state"] = { status: "off" },
): LibrarySyncSnapshot {
  return {
    workspace,
    revision,
    available: true,
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

  it("invokes turnOn, turnOff, setFileSelected and syncNow through the platform facade", async () => {
    const ws = makeWorkspace("ws-1");
    const file = makeWorkspace("file-1");
    mocks.librarySyncChanged.mockResolvedValue(vi.fn());
    mocks.librarySyncSnapshot.mockResolvedValue(makeSnapshot(ws, 1, { status: "off" }));
    mocks.librarySyncTurnOn.mockResolvedValue(
      makeSnapshot(ws, 2, { status: "syncing", done: 0, total: 1 }),
    );
    mocks.librarySyncSetFileSelected.mockResolvedValue(makeSnapshot(ws, 3, { status: "synced" }));
    mocks.librarySyncNow.mockResolvedValue(makeSnapshot(ws, 4, { status: "synced" }));
    mocks.librarySyncTurnOff.mockResolvedValue(makeSnapshot(ws, 5, { status: "off" }));

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
      await latest.turnOn([file]);
    });
    expect(mocks.librarySyncTurnOn).toHaveBeenCalledWith(ws, [file]);
    expect(latest.snapshot?.revision).toBe(2);

    await act(async () => {
      await latest.setFileSelected(file, true);
    });
    expect(mocks.librarySyncSetFileSelected).toHaveBeenCalledWith(ws, file, true);
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

  it("reports snapshot fetch failure, listener failure, and action failure with closed error codes", async () => {
    const ws = makeWorkspace("ws-1");
    mocks.librarySyncChanged.mockResolvedValue(vi.fn());
    mocks.librarySyncSnapshot.mockRejectedValueOnce(new LibrarySyncCommandError("localStorage"));

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
    expect(latest.loading).toBe(false);
    expect(latest.error).toBe("localStorage");

    // Action failure surfaces closed error code and releases busy.
    mocks.librarySyncTurnOn.mockRejectedValueOnce(new LibrarySyncCommandError("busy"));
    await act(async () => {
      await latest.turnOn([]);
    });
    expect(latest.busy).toBe(false);
    expect(latest.error).toBe("busy");

    // Listener attachment failure surfaces error and stops loading.
    const ws2 = makeWorkspace("ws-2");
    mocks.librarySyncChanged.mockRejectedValueOnce(new Error("boom"));
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
    expect(latest.loading).toBe(false);
    expect(latest.error).toBe("unavailable");
  });

  it("releases busy on workspace change while an action is in flight and ignores the late answer", async () => {
    const ws1 = makeWorkspace("ws-1");
    const ws2 = makeWorkspace("ws-2");
    const inFlightTurnOn = deferred<LibrarySyncSnapshot>();

    mocks.librarySyncChanged.mockResolvedValue(vi.fn());
    mocks.librarySyncSnapshot
      .mockResolvedValueOnce(makeSnapshot(ws1, 1, { status: "off" }))
      .mockResolvedValueOnce(makeSnapshot(ws2, 1, { status: "off" }));
    mocks.librarySyncTurnOn.mockReturnValueOnce(inFlightTurnOn.promise);

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

    let actionPromise!: Promise<void>;
    await act(async () => {
      actionPromise = latest.turnOn([]);
    });
    expect(latest.busy).toBe(true);

    // Switch workspace while turnOn is still in flight.
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
    expect(latest.busy).toBe(false);
    expect(latest.snapshot?.workspace).toEqual(ws2);

    // Late answer for ws1 must be ignored and leave ws2 untouched.
    await act(async () => {
      inFlightTurnOn.resolve(makeSnapshot(ws1, 9, { status: "synced" }));
      await actionPromise;
    });
    expect(latest.busy).toBe(false);
    expect(latest.snapshot?.workspace).toEqual(ws2);
    expect(latest.snapshot?.state).toEqual({ status: "off" });
  });
});
