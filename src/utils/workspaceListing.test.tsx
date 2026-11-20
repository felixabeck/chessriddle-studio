import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import useSWR, { SWRConfig, unstable_serialize, useSWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useNativeRequestOwner } from "@/hooks/useNativeRequestOwner";
import { createFile } from "@/utils/files";
import { TauriCommandError } from "@/platform/tauri";
import { workspaceListingToEntries } from "@/components/files/file";
import {
  reconcileWorkspaceListing,
  workspaceListingKey,
  type WorkspaceListingCache,
} from "./workspaceListing";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const native = vi.hoisted(() => ({ createWorkspaceFile: vi.fn(), listFileWorkspace: vi.fn() }));
vi.mock("@/platform/tauri", async (original) => ({
  ...(await original<typeof import("@/platform/tauri")>()),
  tauri: native,
}));

const workspace = { id: { id: "A" }, kind: "fileWorkspace" } as const;
const key = workspaceListingKey(workspace);
const leftover = {
  handle: { id: { id: "leftover" }, kind: "fileWorkspace" },
  kind: "file",
  name: "Created",
  children: [],
  metadata: { type: "game", tags: [] },
  gameCount: 1,
  lastModified: 1,
} as const;
let host: HTMLDivElement;
let root: Root;
let context!: WorkspaceListingCache;
let result: Awaited<ReturnType<typeof createFile>> | undefined;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function Reader({ visible }: { visible: boolean }) {
  context = useSWRConfig();
  const owner = useNativeRequestOwner(visible ? key : null);
  const { data } = useSWR(visible ? key : null, () =>
    owner!.run(async (signal) =>
      workspaceListingToEntries(await native.listFileWorkspace(workspace, { signal }), workspace),
    ),
  );
  return (
    <>
      <output>{data?.map((entry: { name: string }) => entry.name).join(",")}</output>
      <button
        onClick={async () => {
          result = await createFile({
            workspace,
            parent: workspace,
            filename: "Created",
            filetype: "game",
            listingCache: context,
          });
        }}
      >
        Create
      </button>
    </>
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  result = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test.each([false, true])(
  "createFile awaits delayed real SWR listing before returning typed cleanup error, relist failure=%s",
  async (fails) => {
    const cause = new TauriCommandError({
      tag: "backend-error",
      category: "operation-and-cleanup",
      message: "private diagnostic",
    });
    const listing = deferred<(typeof leftover)[]>();
    native.createWorkspaceFile.mockRejectedValueOnce(cause);
    native.listFileWorkspace
      .mockResolvedValueOnce({ entries: [], unread: [] })
      .mockReturnValueOnce(listing.promise.then((entries) => ({ entries, unread: [] })));
    const cache = new Map();
    await act(async () =>
      root.render(
        <SWRConfig
          value={{ provider: () => cache, shouldRetryOnError: false, revalidateOnFocus: false }}
        >
          <Reader visible />
        </SWRConfig>,
      ),
    );
    await act(async () => host.querySelector("button")!.click());
    try {
      expect(native.listFileWorkspace).toHaveBeenCalledTimes(2);
      expect(result).toBeUndefined();
      expect(native.createWorkspaceFile).toHaveBeenCalledOnce();
    } finally {
      await act(async () => {
        if (fails) listing.reject(new Error("relist failed"));
        else listing.resolve([leftover]);
      });
    }
    expect(result?.isErr).toBe(true);
    if (!result?.isErr) throw new Error("Expected cleanup to remain an error Result");
    expect(result.error).toBe(cause);
    expect((result.error as TauriCommandError).details.backendCategory).toBe(
      "operation-and-cleanup",
    );
    expect(native.listFileWorkspace).toHaveBeenCalledTimes(2);
    expect(native.listFileWorkspace).toHaveBeenLastCalledWith(workspace, {
      signal: expect.any(AbortSignal),
    });
    expect(native.createWorkspaceFile).toHaveBeenCalledOnce();
    expect(host.querySelector("output")?.textContent).toBe(fails ? "" : "Created");
  },
);

test("inactive createFile invalidates only its owning provider and fetches on next mount", async () => {
  const cause = new TauriCommandError({
    tag: "backend-error",
    category: "operation-and-cleanup",
    message: "private diagnostic",
  });
  native.createWorkspaceFile.mockRejectedValueOnce(cause);
  native.listFileWorkspace.mockResolvedValue({ entries: [leftover], unread: [] });
  const cache = new Map([[unstable_serialize(key), { data: [{ name: "stale" }] }]]);
  const foreignCache = new Map([[unstable_serialize(key), { data: [{ name: "foreign" }] }]]);
  async function render(visible: boolean) {
    await act(async () =>
      root.render(
        <>
          <SWRConfig
            value={{ provider: () => cache, shouldRetryOnError: false, revalidateOnFocus: false }}
          >
            <Reader visible={visible} />
          </SWRConfig>
          <SWRConfig value={{ provider: () => foreignCache }}>
            <span>Other cache</span>
          </SWRConfig>
        </>,
      ),
    );
  }
  await render(false);
  await act(async () => host.querySelector("button")!.click());
  expect(result?.isErr).toBe(true);
  expect(cache.get(unstable_serialize(key))?.data).toBeUndefined();
  expect(foreignCache.get(unstable_serialize(key))?.data).toEqual([{ name: "foreign" }]);
  expect(native.listFileWorkspace).toHaveBeenCalledOnce();
  await render(true);
  await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toBe("Created"));
  expect(native.listFileWorkspace).toHaveBeenCalledTimes(2);
});

test("inactive cleanup retires SWR's completed pre-mutation fetch before immediate remount", async () => {
  const cause = new TauriCommandError({
    tag: "backend-error",
    category: "operation-and-cleanup",
    message: "private diagnostic",
  });
  native.createWorkspaceFile.mockRejectedValueOnce(cause);
  native.listFileWorkspace
    .mockResolvedValueOnce({ entries: [], unread: [] })
    .mockResolvedValue({ entries: [leftover], unread: [] });
  const cache = new Map();
  async function render(visible: boolean) {
    await act(async () =>
      root.render(
        <SWRConfig
          value={{
            provider: () => cache,
            dedupingInterval: 60000,
            revalidateOnFocus: false,
            shouldRetryOnError: false,
          }}
        >
          <Reader visible={visible} />
        </SWRConfig>,
      ),
    );
  }
  await render(true);
  expect(native.listFileWorkspace).toHaveBeenCalledOnce();
  await render(false);
  await act(async () => host.querySelector("button")!.click());
  expect(result?.isErr).toBe(true);
  expect(native.listFileWorkspace).toHaveBeenCalledTimes(2);
  await render(true);
  await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toBe("Created"));
  expect(native.listFileWorkspace).toHaveBeenCalledTimes(3);
});

test("reconciliation survives disposal of the submitting SWR provider and never restores stale cached data", async () => {
  native.listFileWorkspace
    .mockResolvedValueOnce({ entries: [], unread: [] })
    .mockResolvedValue({ entries: [leftover], unread: [] });
  const cache = new Map();
  const foreign = new Map([[unstable_serialize(key), { data: [{ name: "foreign" }] }]]);
  async function mount() {
    await act(async () =>
      root.render(
        <SWRConfig
          value={{ provider: () => cache, shouldRetryOnError: false, revalidateOnFocus: false }}
        >
          <Reader visible />
        </SWRConfig>,
      ),
    );
  }
  await mount();
  const captured = context;
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => foreign }}>
        <span>Other provider</span>
      </SWRConfig>,
    ),
  );
  await expect(reconcileWorkspaceListing(workspace, captured)).resolves.toBeUndefined();
  expect(native.listFileWorkspace).toHaveBeenCalledTimes(2);
  expect(native.listFileWorkspace).toHaveBeenLastCalledWith(workspace);
  expect(cache.get(unstable_serialize(key))?.data).toBeUndefined();
  expect(foreign.get(unstable_serialize(key))?.data).toEqual([{ name: "foreign" }]);
  await mount();
  await vi.waitFor(() => expect(host.querySelector("output")?.textContent).toBe("Created"));
  expect(native.listFileWorkspace).toHaveBeenCalledTimes(3);
});

test("provider disposal during reconciliation still finishes the captured native read without publishing into its replacement", async () => {
  const listing = deferred<(typeof leftover)[]>();
  native.listFileWorkspace
    .mockResolvedValueOnce({ entries: [], unread: [] })
    .mockReturnValueOnce(listing.promise.then((entries) => ({ entries, unread: [] })))
    .mockResolvedValue({ entries: [leftover], unread: [] });
  const cache = new Map();
  const foreign = new Map();
  await act(async () =>
    root.render(
      <SWRConfig
        value={{ provider: () => cache, shouldRetryOnError: false, revalidateOnFocus: false }}
      >
        <Reader visible />
      </SWRConfig>,
    ),
  );
  let reconciliation!: Promise<void>;
  await act(async () => {
    reconciliation = reconcileWorkspaceListing(workspace, context);
  });
  expect(native.listFileWorkspace).toHaveBeenCalledTimes(2);
  await act(async () =>
    root.render(
      <SWRConfig key="replacement" value={{ provider: () => foreign }}>
        <span>New owner</span>
      </SWRConfig>,
    ),
  );
  expect(native.listFileWorkspace.mock.calls[1][1].signal.aborted).toBe(true);
  await act(async () => {
    listing.resolve([leftover]);
    await reconciliation;
  });
  expect(native.listFileWorkspace).toHaveBeenCalledTimes(3);
  expect(native.listFileWorkspace).toHaveBeenLastCalledWith(workspace);
  expect(foreign.size).toBe(0);
  expect(cache.get(unstable_serialize(key))?.data).toBeUndefined();
  expect(host.textContent).toBe("New owner");
});
