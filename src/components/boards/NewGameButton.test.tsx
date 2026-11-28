import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FileMetadata } from "@/components/files/file";
import { installMatchMediaStub } from "@/tests/matchMedia";
import NewGameButton from "./NewGameButton";

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(async () => "tab"),
  repertoireFileColor: vi.fn(async (): Promise<"white" | "black" | null> => null),
}));

vi.mock("@/utils/tabs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/tabs")>()),
  createTab: mocks.createTab,
}));
vi.mock("@/components/files/repertoireColor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/files/repertoireColor")>()),
  repertoireFileColor: mocks.repertoireFileColor,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(async () => undefined) }));

installMatchMediaStub();

function file(type: "repertoire" | "game"): FileMetadata {
  return {
    type: "file",
    handle: { id: { id: "file" }, kind: "fileWorkspace" },
    name: "Lines.pgn",
    numGames: 3,
    metadata: { type, tags: [] },
    lastModified: 1,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.repertoireFileColor.mockResolvedValue(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function clickNewGame(target: FileMetadata) {
  await act(async () => {
    root.render(
      <Provider store={createStore()}>
        <MantineProvider>
          <NewGameButton origin={{ kind: "fileDraft", file: target }} explanation="" />
        </MantineProvider>
      </Provider>,
    );
  });
  await act(async () => container.querySelector("button")!.click());
  await vi.waitFor(() => expect(mocks.createTab).toHaveBeenCalledTimes(1));
  return (mocks.createTab.mock.calls[0] as unknown as [{ initialTree?: { headers: object } }])[0];
}

test("a new chapter of a Black repertoire starts from Black's side", async () => {
  mocks.repertoireFileColor.mockResolvedValue("black");
  const call = await clickNewGame(file("repertoire"));
  expect(call.initialTree?.headers).toMatchObject({ orientation: "black" });
});

test("a repertoire without a shared color and a game file start from an empty tree", async () => {
  const repertoireCall = await clickNewGame(file("repertoire"));
  expect(repertoireCall.initialTree).toBeUndefined();

  mocks.createTab.mockClear();
  mocks.repertoireFileColor.mockClear();
  const gameCall = await clickNewGame(file("game"));
  expect(gameCall.initialTree).toBeUndefined();
  expect(mocks.repertoireFileColor).not.toHaveBeenCalled();
});
