import { MantineProvider } from "@mantine/core";
import { createStore, Provider } from "jotai";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { installMatchMediaStub } from "@/tests/matchMedia";
import {
  DatabaseLayoutContext,
  databaseSplitAtoms,
  DATABASE_SPLIT_KEY,
} from "@/state/databaseLayout";
import GridLayout from "./GridLayout";

installMatchMediaStub();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test.each(["compact reflow", "unmount"])(
  "%s discards an unfinished drag without writing the committed preference",
  async (interruption) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const store = createStore();
    store.set(databaseSplitAtoms.commit, 25);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const render = (compact: boolean, mounted = true) =>
      act(async () =>
        root.render(
          <Provider store={store}>
            <MantineProvider>
              <DatabaseLayoutContext.Provider
                value={{ compact, minimum: compact ? 50 : 20, rootFont: 16 }}
              >
                {mounted && <GridLayout search={<input />} table={<div />} preview={<div />} />}
              </DatabaseLayoutContext.Provider>
            </MantineProvider>
          </Provider>,
        ),
      );
    let measurement: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await render(false);
      expect(host.querySelector("[data-database-layout]")!.getAttribute("data-percentage")).toBe(
        "25",
      );
      const divider = host.querySelector(".mosaic-split")!;
      measurement = vi
        .spyOn(divider.parentElement!, "getBoundingClientRect")
        .mockReturnValue(new DOMRect(0, 0, 1000, 600));
      await act(async () => {
        divider.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
        document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 650 }));
      });
      expect(host.querySelector("[data-database-layout]")!.getAttribute("data-percentage")).toBe(
        "65",
      );
      expect(store.get(databaseSplitAtoms.preferred)).toBe(25);
      expect(writes).not.toHaveBeenCalled();
      await render(interruption === "compact reflow", interruption !== "unmount");
      expect(host.querySelectorAll(".mosaic-split")).toHaveLength(0);
      expect(host.querySelectorAll("[data-database-layout]")).toHaveLength(
        interruption === "compact reflow" ? 1 : 0,
      );
      await render(false);
      expect(host.querySelector("[data-database-layout]")!.getAttribute("data-percentage")).toBe(
        String(store.get(databaseSplitAtoms.preferred)),
      );
      expect(store.get(databaseSplitAtoms.preferred)).toBe(25);
      expect(localStorage.getItem(DATABASE_SPLIT_KEY)).toBe("25");
      expect(writes).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      measurement?.mockRestore();
      host.remove();
      writes.mockRestore();
    }
  },
);

test("shared mounted tiles observe commits, clamp without storage writes and retain preview ownership on compact reflow", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const store = createStore();
  store.set(databaseSplitAtoms.commit, 25);
  const writes = vi.spyOn(Storage.prototype, "setItem");
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Preview() {
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return <div data-preview-owner />;
  }
  const render = (compact: boolean, minimum: number) =>
    act(async () =>
      root.render(
        <Provider store={store}>
          <MantineProvider>
            <DatabaseLayoutContext.Provider value={{ compact, minimum, rootFont: 16 }}>
              {["games", "players", "tournaments"].map((id) => (
                <GridLayout key={id} search={<input />} table={<div />} preview={<Preview />} />
              ))}
            </DatabaseLayoutContext.Provider>
          </MantineProvider>
        </Provider>,
      ),
    );
  try {
    await render(false, 40);
    expect(
      [...host.querySelectorAll("[data-database-layout]")].map((element) =>
        element.getAttribute("data-percentage"),
      ),
    ).toEqual(["40", "40", "40"]);
    expect(writes).not.toHaveBeenCalled();
    expect(localStorage.getItem(DATABASE_SPLIT_KEY)).toBe("25");
    // An interrupted measurement can leave Mosaic's DOM rectangle empty before reflow.
    await act(async () => {
      host
        .querySelector(".mosaic-split")!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    });
    expect(store.get(databaseSplitAtoms.preferred)).toBe(25);
    expect(writes).not.toHaveBeenCalled();
    const owners = [...host.querySelectorAll("[data-preview-owner]")];
    await render(true, 50);
    expect(host.querySelectorAll(".mosaic-split")).toHaveLength(0);
    expect([...host.querySelectorAll("[data-preview-owner]")]).toEqual(owners);
    await render(false, 20);
    expect(host.querySelector("[data-database-layout]")!.getAttribute("data-percentage")).toBe(
      "25",
    );
    expect(writes).not.toHaveBeenCalled();
    // A completed drag on the first layout's divider commits the clamped split for all three.
    const divider = host.querySelector(".mosaic-split")!;
    const measurement = vi
      .spyOn(divider.parentElement!, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 1000, 600));
    await act(async () => {
      divider.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 100 }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 100 }));
    });
    measurement.mockRestore();
    expect(store.get(databaseSplitAtoms.preferred)).toBe(20);
    expect(writes).toHaveBeenCalledOnce();
    expect(
      [...host.querySelectorAll("[data-database-layout]")].map((element) =>
        element.getAttribute("data-percentage"),
      ),
    ).toEqual(["20", "20", "20"]);
    // The divider is the only way to resize: no layout renders a resize button.
    expect(host.querySelectorAll("[data-database-layout] button")).toHaveLength(0);
    expect(mounted).toHaveBeenCalledTimes(3);
    expect(unmounted).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    writes.mockRestore();
  }
});
