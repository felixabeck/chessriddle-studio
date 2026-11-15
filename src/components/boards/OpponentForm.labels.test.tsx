import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { OpponentSettings } from "@/state/opponentSettings";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import { OpponentForm } from "./OpponentForm";

installMatchMediaStub();
installResizeObserverStub();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./EnginesSelect", () => ({
  EnginesSelect: () => null,
}));
vi.mock("@/components/panels/analysis/EngineSettingsForm", () => ({
  default: () => null,
}));
vi.mock("@/components/common/GoModeInput", () => ({
  default: () => null,
}));
vi.mock("lucide-react", () => ({
  Brain: () => null,
  User: () => null,
}));

let host: HTMLDivElement;
let root: Root;
const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

function byAccessibleName(container: ParentNode, name: string): HTMLElement[] {
  const matches: HTMLElement[] = [];
  if (container instanceof HTMLElement && container.getAttribute("aria-label") === name) {
    matches.push(container);
  }
  for (const el of container.querySelectorAll<HTMLElement>("[aria-label]")) {
    if (el.getAttribute("aria-label") === name) matches.push(el);
  }
  for (const caption of container.querySelectorAll("label")) {
    if (caption.textContent?.trim() !== name || !caption.htmlFor) continue;
    const control = document.getElementById(caption.htmlFor);
    if (control && container.contains(control)) matches.push(control);
  }
  return [...new Set(matches)];
}

function namedInput(container: ParentNode, name: string): HTMLInputElement {
  const input = byAccessibleName(container, name).find(
    (el): el is HTMLInputElement =>
      el instanceof HTMLInputElement && el.type !== "radio" && el.type !== "hidden",
  );
  if (!input) {
    throw new Error(`No input with accessible name ${JSON.stringify(name)}`);
  }
  return input;
}

function namedGroup(container: ParentNode, name: string): HTMLElement {
  const group = byAccessibleName(container, name).find((el) => el.getAttribute("role") === "group");
  if (!group) {
    throw new Error(`No group named ${JSON.stringify(name)}`);
  }
  return group;
}

const felixSettings: OpponentSettings = {
  type: "human",
  name: "Felix",
  timeControl: { seconds: 180000, increment: 2000 },
  timeUnit: "m",
  incrementUnit: "s",
};

test("Play-setup opponent fields expose accessible names", async () => {
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <OpponentForm
          sameTimeControl={false}
          opponent={felixSettings}
          setOpponent={vi.fn()}
          setOtherOpponent={vi.fn()}
          sideLabel="White"
        />
      </MantineProvider>,
    );
  });

  const group = namedGroup(host, "White");
  expect(namedInput(group, "Common.Name").value).toBe("Felix");
  expect(namedInput(group, "GoMode.Time").value).toBe("3");
  expect(namedInput(group, "Board.Opponent.Increment").value).toBe("2");
  expect(namedInput(group, "Board.Opponent.TimeUnit").value).toBe("m");
  expect(namedInput(group, "Board.Opponent.IncrementUnit").value).toBe("s");
});

test("each side group scopes its name field", async () => {
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <OpponentForm
          sameTimeControl={false}
          opponent={felixSettings}
          setOpponent={vi.fn()}
          setOtherOpponent={vi.fn()}
          sideLabel="White"
        />
        <OpponentForm
          sameTimeControl={false}
          opponent={{ ...felixSettings, name: "Anna" }}
          setOpponent={vi.fn()}
          setOtherOpponent={vi.fn()}
          sideLabel="Black"
        />
      </MantineProvider>,
    );
  });

  const white = namedGroup(host, "White");
  const black = namedGroup(host, "Black");
  expect(namedInput(white, "Common.Name").value).toBe("Felix");
  expect(namedInput(black, "Common.Name").value).toBe("Anna");
});
