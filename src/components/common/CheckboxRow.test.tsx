import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { MantineProvider } from "@mantine/core";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { CheckboxRow } from "./CheckboxRow";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

async function renderRow() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <MantineProvider>
        <CheckboxRow data-testid="row">
          <CheckboxRow.Item label="Bullet" defaultChecked={false} />
          <CheckboxRow.Item label="Blitz" defaultChecked />
        </CheckboxRow>
      </MantineProvider>,
    ),
  );
}

function itemRoot(label: string) {
  const input = [...host!.querySelectorAll<HTMLInputElement>("input")].find(
    (candidate) => candidate.labels?.[0]?.textContent === label,
  );
  const element = input?.closest<HTMLElement>(".mantine-Checkbox-root");
  if (!input || !element) throw new Error(`checkbox ${label} is not rendered`);
  return { input, element };
}

test("separates pairs by a gap wider than each label's offset from its own box", async () => {
  await renderRow();
  const row = host!.querySelector<HTMLElement>('[data-testid="row"]')!;
  expect(row.style.getPropertyValue("--group-gap")).toBe("var(--mantine-spacing-lg)");
  expect(row.style.rowGap).toBe("var(--mantine-spacing-sm)");
  for (const label of ["Bullet", "Blitz"]) {
    expect(itemRoot(label).element.style.getPropertyValue("--label-offset-start")).toBe(
      "calc(var(--mantine-spacing-xs) / 2)",
    );
  }
});

test("keeps each item a small, labelled checkbox that forwards its props", async () => {
  await renderRow();
  expect(itemRoot("Bullet").element.style.getPropertyValue("--checkbox-size")).toBe(
    "var(--checkbox-size-xs)",
  );
  expect(itemRoot("Blitz").input.checked).toBe(true);
  expect(itemRoot("Bullet").input.checked).toBe(false);
});
