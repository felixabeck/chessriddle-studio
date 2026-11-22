import { MantineProvider, Menu } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PinnedPlacement } from "@/state/atoms";
import { type BoardLayoutMode, BoardLayoutModeContext } from "@/state/paneLayout";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { PinnedPlacementItems } from "./PinnedPlacementItems";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  installMatchMediaStub();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
async function renderMenu(
  mode: BoardLayoutMode,
  current: PinnedPlacement | null,
  onChoose: (placement: PinnedPlacement) => void = () => undefined,
) {
  await act(async () =>
    root.render(
      <MantineProvider env="test">
        <BoardLayoutModeContext.Provider value={mode}>
          <Menu opened withinPortal={false}>
            <Menu.Target>
              <button type="button">position</button>
            </Menu.Target>
            <Menu.Dropdown>
              <PinnedPlacementItems current={current} onChoose={onChoose} />
            </Menu.Dropdown>
          </Menu>
        </BoardLayoutModeContext.Provider>
      </MantineProvider>,
    ),
  );
}

test.each(["mosaic", "stacked"] as const)(
  "in the %s layout the first place is above the tabs",
  async (mode) => {
    await renderMenu(mode, null);
    expect(items().map((item) => item.textContent)).toEqual([
      "Pinned.AboveTabs",
      "Pinned.AboveNotation",
      "Pinned.BelowNotation",
      "Pinned.BelowBoard",
    ]);
  },
);

test("with the panels beside the notation the first place is named for spanning both, and still chooses the place above the tabs", async () => {
  const chosen: PinnedPlacement[] = [];
  await renderMenu("beside", "notation", (placement) => chosen.push(placement));
  expect(items().map((item) => item.textContent)).toEqual([
    "Pinned.AboveNotationAndTabs",
    "Pinned.AboveNotation",
    "Pinned.BelowNotation",
    "Pinned.BelowBoard",
  ]);
  expect(
    items()
      .filter((item) => item.getAttribute("aria-current") === "true")
      .map((item) => item.textContent),
  ).toEqual(["Pinned.AboveNotation"]);
  await act(async () => items()[0].click());
  // The current place calls nothing.
  await act(async () => items()[1].click());
  expect(chosen).toEqual(["tabs"]);
});
