import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, type Cache } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FileWorkspaceHandle, WorkspaceListing } from "@/bindings";
import { tauri } from "@/platform/tauri";
import { useWorkspaceListing } from "./useWorkspaceListing";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("@/platform/tauri", () => ({ tauri: { listFileWorkspace: vi.fn() } }));
let host: HTMLDivElement;
let root: Root;
let cache: Cache;
let pending: {
  workspace: FileWorkspaceHandle;
  signal: AbortSignal;
  resolve: (listing: WorkspaceListing) => void;
}[];
function workspace(id: string): FileWorkspaceHandle {
  return { kind: "fileWorkspace", id: { id } };
}
function Consumer({ workspace: root }: { workspace: FileWorkspaceHandle }) {
  const listing = useWorkspaceListing(root);
  return <span>{listing.data?.map((entry) => entry.name).join(",") ?? "pending"}</span>;
}
async function render(first: string, second?: string) {
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => cache, shouldRetryOnError: false }}>
        <Consumer workspace={workspace(first)} />
        {second && <Consumer workspace={workspace(second)} />}
      </SWRConfig>,
    ),
  );
}
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  cache = new Map();
  pending = [];
  vi.mocked(tauri.listFileWorkspace).mockReset();
  vi.mocked(tauri.listFileWorkspace).mockImplementation(
    (workspace, options) =>
      new Promise((resolve) => {
        pending.push({ workspace, signal: options!.signal!, resolve });
      }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
test("shares the existing workspace listing key and request between consumers", async () => {
  await render("one", "one");
  expect(tauri.listFileWorkspace).toHaveBeenCalledTimes(1);
  await act(async () => pending[0].resolve({ entries: [], unread: [] }));
  expect(host.textContent).toBe("");
});
test("aborts the old workspace and unmounted listing and never displays an old result", async () => {
  await render("one");
  await render("two");
  expect(pending[0].signal.aborted).toBe(true);
  await act(async () => pending[0].resolve({ entries: [], unread: [] }));
  expect(host.textContent).toBe("pending");
  await act(async () => root.render(null));
  expect(pending[1].signal.aborted).toBe(true);
  await act(async () => pending[1].resolve({ entries: [], unread: [] }));
});
