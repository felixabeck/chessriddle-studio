import { MantineProvider } from "@mantine/core";
import { parseUci } from "chessops";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createTreeStore, type TreeStore } from "@/state/store/tree";
import { catalogueI18n } from "@/tests/catalogues";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { TreeStateContext } from "../common/TreeStateContext";
import Clock from "./Clock";

vi.mock("@/utils/sound", () => ({ playSound: vi.fn() }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function renderClock(store: TreeStore, color: "white" | "black" = "white") {
  const i18n = await catalogueI18n("en-US");
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <MantineProvider env="test">
          <TreeStateContext.Provider value={store}>
            <Clock color={color} turn={color} />
          </TreeStateContext.Provider>
        </MantineProvider>
      </I18nextProvider>,
    );
  });
  return host.querySelector<HTMLDivElement>(".mantine-Paper-root")!;
}

test("sets title from the resolved time control, including side-specific and unparseable fallback", async () => {
  const store = createTreeStore();
  store.getState().setHeaders({
    ...store.getState().headers,
    time_control: "5400+30",
    white_time_control: "600+5",
    black_time_control: "garbage",
  });

  const whitePaper = await renderClock(store, "white");
  expect(whitePaper.getAttribute("title")).toBe("10 min + 5 s per move");

  const blackPaper = await renderClock(store, "black");
  expect(blackPaper.getAttribute("title")).toBe("90 min + 30 s per move");
});

test("omits title when no time control resolves (node clocks only or unparseable tags)", async () => {
  const store = createTreeStore();
  await act(async () => {
    store.getState().makeMove({ payload: parseUci("e2e4")! });
    store.getState().setClock(5160);
  });

  const nodeOnlyPaper = await renderClock(store, "white");
  expect(nodeOnlyPaper.textContent).toBe("1:26:00");
  expect(nodeOnlyPaper.hasAttribute("title")).toBe(false);

  await act(async () => {
    store.getState().setHeaders({
      ...store.getState().headers,
      time_control: "?",
      white_time_control: "garbage",
    });
  });

  expect(nodeOnlyPaper.hasAttribute("title")).toBe(false);
});
