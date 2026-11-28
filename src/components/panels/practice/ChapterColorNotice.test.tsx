import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FileMetadata } from "@/components/files/file";
import { createTreeStore } from "@/state/store/tree";
import { tabStorage } from "@/state/store/tabStorage";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { defaultTree } from "@/utils/treeReducer";
import { ChapterColorNotice } from "./ChapterColorNotice";

const mocks = vi.hoisted(() => ({
  repertoireFileColor: vi.fn(async (): Promise<"white" | "black" | null> => null),
}));

vi.mock("@/components/files/repertoireColor", () => ({
  repertoireFileColor: mocks.repertoireFileColor,
}));

installMatchMediaStub();

const repertoire: FileMetadata = {
  type: "file",
  handle: { id: { id: "rep" }, kind: "fileWorkspace" },
  name: "Black.pgn",
  numGames: 2,
  metadata: { type: "repertoire", tags: [] },
  lastModified: 1,
};

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
});

function storeWith(orientation?: "white" | "black") {
  const id = crypto.randomUUID();
  const tree = defaultTree();
  if (orientation) tree.headers.orientation = orientation;
  tabStorage.seed(id, tree);
  return createTreeStore(id);
}

async function render(store: ReturnType<typeof createTreeStore>, file = repertoire) {
  await act(async () => {
    root.render(
      <MantineProvider>
        <ChapterColorNotice store={store} file={file} />
      </MantineProvider>,
    );
  });
}

const notice = () => container.querySelector("[data-chapter-color-notice]");

test("an uncolored chapter of a Black repertoire can be set to Black", async () => {
  mocks.repertoireFileColor.mockResolvedValue("black");
  const store = storeWith();
  await render(store);

  expect(notice()?.textContent).toContain("Repertoire.Color.ChapterMissing");
  const black = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Repertoire.Color.TrainAsBlack",
  )!;
  await act(async () => black.click());

  expect(store.getState().headers.orientation).toBe("black");
  expect(store.getState().dirty).toBe(true);
  expect(notice()).toBeNull();
});

test("an uncolored chapter of a repertoire without a shared color is flagged and can be White", async () => {
  mocks.repertoireFileColor.mockResolvedValue(null);
  const store = storeWith();
  await render(store);
  expect(notice()).not.toBeNull();

  const white = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Repertoire.Color.TrainAsWhite",
  )!;
  await act(async () => white.click());
  expect(store.getState().headers.orientation).toBe("white");
  expect(notice()).toBeNull();
});

test("no notice when the repertoire's chapters are White, already right", async () => {
  mocks.repertoireFileColor.mockResolvedValue("white");
  await render(storeWith());
  expect(notice()).toBeNull();
});

test("no notice for a chapter with a color or a game outside a repertoire", async () => {
  mocks.repertoireFileColor.mockResolvedValue("black");
  await render(storeWith("white"));
  expect(notice()).toBeNull();

  await render(storeWith(), { ...repertoire, metadata: { type: "game", tags: [] } });
  expect(notice()).toBeNull();
  expect(mocks.repertoireFileColor).not.toHaveBeenCalled();
});

test("a failed lookup still names the uncolored chapter", async () => {
  mocks.repertoireFileColor.mockRejectedValueOnce(new Error("index unavailable"));
  await render(storeWith());
  await vi.waitFor(() => expect(notice()).not.toBeNull());
});

test("a lookup for a file the tab has left does not decide the notice", async () => {
  let resolveFirst!: (color: "white" | "black" | null) => void;
  mocks.repertoireFileColor
    .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
    .mockResolvedValueOnce("black");
  const store = storeWith();
  await render(store);
  await render(store, { ...repertoire, handle: { id: { id: "other" }, kind: "fileWorkspace" } });
  await vi.waitFor(() => expect(notice()).not.toBeNull());

  // The first file's late "White" answer must not hide the notice for the current file.
  await act(async () => resolveFirst("white"));
  expect(notice()).not.toBeNull();
});

test("a replaced file object for the same file does not look its color up again", async () => {
  mocks.repertoireFileColor.mockResolvedValue("black");
  const store = storeWith();
  await render(store);
  await render(store, { ...repertoire });
  await vi.waitFor(() => expect(notice()).not.toBeNull());
  expect(mocks.repertoireFileColor).toHaveBeenCalledTimes(1);
});
