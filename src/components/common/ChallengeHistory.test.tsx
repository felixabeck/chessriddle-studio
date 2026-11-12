import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import ChallengeHistory from "./ChallengeHistory";

vi.mock("@/state/atoms", () => ({ hidePuzzleRatingAtom: "hideRating" }));
vi.mock("jotai", () => ({ useAtomValue: () => false }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test.each([0, 1, 2])("only challenge %i is exposed as the current step", async (current) => {
  await act(async () => {
    root.render(
      <MantineProvider>
        <ChallengeHistory
          challenges={[
            { completion: "correct" },
            { completion: "incorrect" },
            { completion: "incomplete" },
          ]}
          current={current}
          select={vi.fn()}
        />
      </MantineProvider>,
    );
  });

  const buttons = [...container.querySelectorAll("button")];
  expect(buttons).toHaveLength(3);
  expect(buttons.map((button) => button.getAttribute("aria-current"))).toEqual(
    buttons.map((_, index) => (index === current ? "step" : null)),
  );
  expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
});
