import { MantineProvider } from "@mantine/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { StoreApi } from "zustand";
import { afterEach, expect, test, vi } from "vitest";
import { useDatabaseList } from "@/hooks/useDatabaseList";
import type { TreeStoreState } from "@/state/store/tree";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { installResizeObserverStub } from "@/tests/resizeObserver";
import SaveToDatabaseModal from "./SaveToDatabaseModal";

vi.mock("@/hooks/useDatabaseList", () => ({ useDatabaseList: vi.fn() }));
vi.mock("@/utils/tabs", () => ({
  useTabActions: () => ({ getTab: vi.fn(), updateTab: vi.fn() }),
  saveToDatabase: vi.fn(),
}));
vi.mock("@/components/common/AppModal", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();
installResizeObserverStub();
let host: HTMLDivElement;
let root: Root;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

test.each([
  ["missing", "This database folder is no longer available. Choose another."],
  ["permission", "ChessRiddle Studio is not allowed to read this database folder. Choose another."],
  ["changed", "This database folder changed. Choose another."],
  ["too-large", "This database folder is too large to list. Choose another."],
] as const)(
  "shows Library recovery guidance for a typed %s listing failure",
  async (rootFailure, message) => {
    vi.mocked(useDatabaseList).mockReturnValue({
      error: { tag: "backend-error", category: "io", message: "private diagnostic", rootFailure },
      isLoading: false,
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useDatabaseList>);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <MantineProvider env="test">
          <SaveToDatabaseModal
            opened
            onClose={vi.fn()}
            tab={undefined}
            store={{} as StoreApi<TreeStoreState>}
          />
        </MantineProvider>,
      ),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(host.textContent).not.toContain("private diagnostic");
    expect(host.querySelector("input")?.disabled).toBe(true);
    expect(
      Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent === "Common.Save",
      )?.disabled,
    ).toBe(true);
  },
);
