import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import ToggleButtonGroup from "./ToggleButtonGroup";

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

test("names each option, exposes pressed state, labels the group, and toggles on click", async () => {
  const toggleOption = vi.fn();

  await act(async () => {
    root.render(
      <MantineProvider>
        <ToggleButtonGroup
          label="Time control"
          includeTooltips
          toggleOption={toggleOption}
          options={[
            {
              name: "Bullet",
              value: "bullet",
              isToggled: true,
              content: <svg aria-hidden />,
            },
            {
              name: "Blitz",
              value: "blitz",
              isToggled: false,
              content: <svg aria-hidden />,
            },
          ]}
        />
      </MantineProvider>,
    );
  });

  const bullet = container.querySelector<HTMLButtonElement>('button[aria-label="Bullet"]')!;
  const blitz = container.querySelector<HTMLButtonElement>('button[aria-label="Blitz"]')!;
  expect(bullet.getAttribute("aria-label")).toBe("Bullet");
  expect(blitz.getAttribute("aria-label")).toBe("Blitz");
  expect(bullet.getAttribute("aria-pressed")).toBe("true");
  expect(blitz.getAttribute("aria-pressed")).toBe("false");

  const group = container.querySelector('[role="group"]')!;
  const labelledBy = group.getAttribute("aria-labelledby");
  expect(document.getElementById(labelledBy!)?.textContent).toBe("Time control");

  await act(async () => {
    blitz.click();
  });
  expect(toggleOption).toHaveBeenCalledWith("blitz");
});
