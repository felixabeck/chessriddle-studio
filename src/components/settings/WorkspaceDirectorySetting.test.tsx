import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WorkspaceDirectorySetting } from "./WorkspaceDirectorySetting";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@mantine/core", () => ({
  Input: ({ children, component: Component = "div", ...props }: any) => (
    <Component {...props}>{children}</Component>
  ),
  Text: ({ children }: any) => <span>{children}</span>,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLDivElement;
let load: ReturnType<typeof vi.fn<() => Promise<{ displayName: string }>>>;
let issue: ReturnType<typeof vi.fn<() => Promise<{ displayName: string }>>>;
let onSelected: ReturnType<typeof vi.fn<(name: string) => void>>;
let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  load = vi.fn().mockResolvedValue({ displayName: "MyChessDBs" });
  issue = vi.fn().mockResolvedValue({ displayName: "NewFolder" });
  onSelected = vi.fn();
  onError = vi.fn();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render() {
  await act(async () =>
    root.render(
      <WorkspaceDirectorySetting
        load={load}
        issue={issue}
        onSelected={onSelected}
        onError={onError}
      />,
    ),
  );
}

test("hydrates the stored workspace display name on mount", async () => {
  await render();
  expect(host.textContent).toContain("MyChessDBs");
  expect(load).toHaveBeenCalledOnce();
});

test("shows the issued name and reports the successful selection", async () => {
  await render();
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("NewFolder");
  expect(onSelected).toHaveBeenCalledExactlyOnceWith("NewFolder");
});

test("remount hydrates the latest workspace name", async () => {
  await render();
  await act(async () => root.unmount());
  root = createRoot(host);
  load.mockResolvedValue({ displayName: "LatestFolder" });
  await render();
  expect(host.textContent).toContain("LatestFolder");
  expect(load).toHaveBeenCalledTimes(2);
});

test("failed hydration offers selection without reporting a picker error", async () => {
  load.mockRejectedValue(new Error("workspace unavailable"));
  await render();
  expect(host.textContent).toContain("Settings.Directories.Select");
  expect(onError).not.toHaveBeenCalled();
});

test("late hydration cannot overwrite a successfully selected name", async () => {
  let resolve!: (workspace: { displayName: string }) => void;
  load.mockReturnValue(new Promise((done) => (resolve = done)));
  await render();
  await act(async () => host.querySelector("button")!.click());
  await act(async () => resolve({ displayName: "OldFolder" }));
  expect(host.textContent).toContain("NewFolder");
  expect(host.textContent).not.toContain("OldFolder");
});

test("late hydration failure cannot overwrite a successfully selected name", async () => {
  let reject!: (error: Error) => void;
  load.mockReturnValue(new Promise((_, fail) => (reject = fail)));
  await render();
  await act(async () => host.querySelector("button")!.click());
  await act(async () => reject(new Error("stale")));
  expect(host.textContent).toContain("NewFolder");
  expect(host.textContent).not.toContain("Settings.Directories.Select");
});

test("shows loading until hydration settles", async () => {
  let resolve!: (workspace: { displayName: string }) => void;
  load.mockReturnValue(new Promise((done) => (resolve = done)));
  await render();
  expect(host.textContent).toContain("Common.Loading");
  await act(async () => resolve({ displayName: "MyChessDBs" }));
  expect(host.textContent).toContain("MyChessDBs");
});

test("hydration from an unmounted instance cannot overwrite a remounted instance", async () => {
  let resolve!: (workspace: { displayName: string }) => void;
  load.mockReturnValueOnce(new Promise((done) => (resolve = done)));
  await render();
  await act(async () => root.unmount());
  root = createRoot(host);
  load.mockResolvedValue({ displayName: "LatestFolder" });
  await render();
  await act(async () => resolve({ displayName: "OldFolder" }));
  expect(host.textContent).toContain("LatestFolder");
  expect(onError).not.toHaveBeenCalled();
});

test("a selection that lands after unmount still reports the switched native root", async () => {
  let resolve!: (workspace: { displayName: string }) => void;
  issue.mockReturnValue(new Promise((done) => (resolve = done)));
  await render();
  await act(async () => host.querySelector("button")!.click());
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => resolve({ displayName: "NewFolder" }));
  expect(onSelected).toHaveBeenCalledExactlyOnceWith("NewFolder");
});
