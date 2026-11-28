import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { BoardBar } from "./BoardBar";

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

test("a title without onNameClick renders plain bold text without a button", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <BoardBar name="Italian Game" height="1.9rem" placement="above" />
      </MantineProvider>,
    ),
  );
  expect(host.querySelector("[data-board-bar]")?.textContent).toBe("Italian Game");
  expect(host.querySelector("button")).toBeNull();
  expect(host.querySelector("[tabindex]")).toBeNull();
  const name = host.querySelector("p");
  expect(name?.style.fontWeight).toBe("bold");
});

test("a player with onNameClick renders a button that invokes it", async () => {
  const onNameClick = vi.fn();
  await act(async () =>
    root.render(
      <MantineProvider>
        <BoardBar name="White Player" height="1.9rem" placement="above" onNameClick={onNameClick} />
      </MantineProvider>,
    ),
  );
  const button = host.querySelector<HTMLElement>("button");
  expect(button?.textContent).toBe("White Player");
  expect(button?.style.minWidth).toBe("0px");
  expect(button?.style.flex).toBe("0 1 auto");
  await act(async () => button?.click());
  expect(onNameClick).toHaveBeenCalledOnce();
});

test("a detail renders muted after the name and is hidden without a name", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <BoardBar name="Vorstoß" detail="4.h4" height="1.9rem" placement="above" />
      </MantineProvider>,
    ),
  );
  const texts = [...host.querySelectorAll("p")];
  expect(texts.map((text) => text.textContent)).toEqual(["Vorstoß", "4.h4"]);
  expect(texts[0].style.fontWeight).toBe("bold");
  expect(texts[1].style.fontWeight).toBe("");
  expect(texts[1].style.color).toContain("dimmed");

  await act(async () =>
    root.render(
      <MantineProvider>
        <BoardBar name="" detail="4.h4" height="1.9rem" placement="above" />
      </MantineProvider>,
    ),
  );
  expect(host.querySelector("[data-board-bar]")?.textContent).toBe("");
});

test("each bar aligns its content toward the board", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <BoardBar name="Black Player" height="1.9rem" placement="above" />
        <BoardBar name="White Player" height="1.9rem" placement="below" />
      </MantineProvider>,
    ),
  );
  const bars = Array.from(host.querySelectorAll<HTMLElement>("[data-board-bar]"));
  expect(bars.map((bar) => bar.dataset.boardBar)).toEqual(["above", "below"]);
  const align = (element: Element) =>
    (element as HTMLElement).style.getPropertyValue("--group-align");
  expect(bars.map(align)).toEqual(["flex-end", "flex-start"]);
  expect(bars.map((bar) => align(bar.lastElementChild!))).toEqual(["flex-end", "flex-start"]);
});

test("an empty clickable title shows its muted placeholder, and a set name replaces it", async () => {
  const onNameClick = vi.fn();
  const bar = (name: string) => (
    <MantineProvider>
      <BoardBar
        name={name}
        placeholder="Untitled line"
        height="1.9rem"
        placement="above"
        onNameClick={onNameClick}
      />
    </MantineProvider>
  );
  await act(async () => root.render(bar("")));
  const button = host.querySelector("button");
  expect(button?.textContent).toBe("Untitled line");
  expect(button?.querySelector("p")?.getAttribute("data-dimmed") ?? button?.innerHTML).toContain(
    "dimmed",
  );
  await act(async () => button?.click());
  expect(onNameClick).toHaveBeenCalledOnce();

  await act(async () => root.render(bar("Two Knights")));
  expect(host.querySelector("button")?.textContent).toBe("Two Knights");
  expect(host.querySelector("button")?.innerHTML).not.toContain("dimmed");
});

test("a placeholder is not shown when the title cannot be clicked", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <BoardBar name="" placeholder="Untitled line" height="1.9rem" placement="above" />
      </MantineProvider>,
    ),
  );
  expect(host.querySelector("[data-board-bar]")?.textContent).toBe("");
});

test("renders actions at the right end after children and keeps the name truncatable before actions wrap", async () => {
  await act(async () =>
    root.render(
      <MantineProvider>
        <BoardBar
          name="Very long player name that truncates"
          height="1.9rem"
          placement="above"
          actions={<button type="button">Flip</button>}
        >
          <span data-testid="material">Mat</span>
        </BoardBar>
      </MantineProvider>,
    ),
  );
  const bar = host.querySelector<HTMLElement>("[data-board-bar='above']")!;
  const leftGroup = bar.firstElementChild as HTMLElement;
  const rightGroup = bar.lastElementChild as HTMLElement;
  const nameText = leftGroup.querySelector<HTMLElement>("p")!;
  expect(leftGroup.style.minWidth).toBe("0px");
  expect(leftGroup.style.flex).toBe("1 1 0%");
  expect(leftGroup.style.overflow).toBe("");
  expect(nameText.dataset.truncate).toBe("end");
  expect(nameText.style.minWidth).toBe("0px");
  expect(nameText.style.flex).toBe("0 1 auto");
  expect(rightGroup.style.flexGrow).toBe("0");
  expect(rightGroup.style.flexShrink).toBe("1");
  expect(rightGroup.style.minWidth).toBe("0px");
  expect(rightGroup.style.overflow).toBe("");
  expect(bar.style.minWidth).toBe("0rem");
  expect(bar.style.width).toBe("100%");
  expect(bar.style.paddingLeft).toBe("var(--board-bar-inset, 2.5rem)");
  expect(bar.style.paddingRight).toBe("var(--mantine-spacing-xs)");
  expect(bar.style.marginLeft).toBe("");
  expect(bar.style.marginRight).toBe("");
  expect(Array.from(rightGroup.children, (child) => child.textContent)).toEqual(["Mat", "Flip"]);
});
