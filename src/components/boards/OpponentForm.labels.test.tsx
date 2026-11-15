import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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

test("Play-setup opponent fields expose accessible names", async () => {
  await act(async () => {
    root.render(
      <MantineProvider env="test">
        <OpponentForm
          sameTimeControl={false}
          opponent={{
            type: "human",
            name: "Felix",
            timeControl: { seconds: 180000, increment: 2000 },
            timeUnit: "m",
            incrementUnit: "s",
          }}
          setOpponent={vi.fn()}
          setOtherOpponent={vi.fn()}
          sideLabel="White"
        />
      </MantineProvider>,
    );
  });

  const group = host.querySelector('[role="group"]');
  expect(group).not.toBeNull();
  expect(group!.getAttribute("aria-label")).toBe("White");

  const nameInput = [...host.querySelectorAll<HTMLInputElement>("input")].find(
    (input) => input.value === "Felix",
  )!;
  expect(nameInput.getAttribute("aria-label")).toBe("Common.Name");

  const numberInputs = [...host.querySelectorAll<HTMLInputElement>(".mantine-NumberInput-input")];
  const timeInput = numberInputs.find((input) => input.value === "3")!;
  const incrementInput = numberInputs.find((input) => input.value === "2")!;
  expect(timeInput.labels![0].textContent).toBe("GoMode.Time");
  expect(incrementInput.labels![0].textContent).toBe("Board.Opponent.Increment");

  const unitSelects = [...host.querySelectorAll<HTMLInputElement>(".mantine-Select-input")];
  expect(unitSelects.map((input) => input.getAttribute("aria-label"))).toEqual([
    "Board.Opponent.TimeUnit",
    "Board.Opponent.IncrementUnit",
  ]);
});
