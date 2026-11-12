import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { installMatchMediaStub } from "@/tests/matchMedia";
import EditingCard from "./EditingCard";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../panels/info/FenInput", () => ({ default: () => null }));
vi.mock("./PiecesGrid", () => ({ default: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;
let store: TreeStore;

beforeEach(() => {
  installMatchMediaStub();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  store = createTreeStore();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  store.dispose();
});

test("the close button has the translated position-editor name and closes editing", async () => {
  const setEditingMode = vi.fn();
  await act(async () =>
    root.render(
      <MantineProvider>
        <TreeStateContext.Provider value={store}>
          <EditingCard
            boardRef={{ current: null }}
            setEditingMode={setEditingMode}
            selectedPiece={null}
            setSelectedPiece={vi.fn()}
          />
        </TreeStateContext.Provider>
      </MantineProvider>,
    ),
  );
  const close = host.querySelector("button")!;
  expect(close.getAttribute("aria-label")).toBe("Board.EditPosition.Close");
  await act(async () => close.click());
  expect(setEditingMode).toHaveBeenCalledExactlyOnceWith(false);
});
