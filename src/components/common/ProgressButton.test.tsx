import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ProgressEvent, ProgressItem } from "@/bindings";

type WireProgressEvent = Omit<ProgressEvent, "generation"> & { generation: string };

const nativeProgress = vi.hoisted(() => ({
  enabled: false,
  getProgress: vi.fn(),
  clearProgress: vi.fn(),
  listener: undefined as ((event: { payload: WireProgressEvent }) => void) | undefined,
}));

const progress = vi.hoisted(() => ({
  progress: 100,
  finished: true,
  isActive: false,
  clear: vi.fn(),
  fence: vi.fn(),
  item: {
    id: "engine_0",
    generation: 1n,
    progress: 100,
    finished: true,
    state: "failed" as "failed" | "succeeded" | "cancelled" | "running",
  } as ProgressItem,
}));
const notifyListenerError = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useProgress", async (original) => {
  const actual = await original<typeof import("@/hooks/useProgress")>();
  return {
    useProgress: (id: string) => (nativeProgress.enabled ? actual.useProgress(id) : progress),
  };
});
vi.mock("@/bindings/generated", () => ({
  commands: {
    getProgress: nativeProgress.getProgress,
    clearProgress: nativeProgress.clearProgress,
  },
  events: {
    progressEvent: {
      listen: vi.fn(async (listener: (event: { payload: WireProgressEvent }) => void) => {
        nativeProgress.listener = listener;
        return () => {
          nativeProgress.listener = undefined;
        };
      }),
    },
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/files/notifyError", () => ({ notifyListenerError }));
vi.mock("./IconAction", () => ({
  default: ({ onClick }: { onClick: () => void }) => (
    <button type="button" data-testid="cancel" onClick={onClick}>
      cancel
    </button>
  ),
}));
import ProgressButton from "./ProgressButton";
import { tauri } from "@/platform/tauri";

vi.mock("@mantine/core", () => ({
  Box: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Button: ({ children, disabled, onClick }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Progress: (props: { value: number; "aria-label"?: string }) => (
    <output data-testid="progress" aria-label={props["aria-label"]}>
      {props.value}
    </output>
  ),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  nativeProgress.enabled = false;
  nativeProgress.listener = undefined;
  nativeProgress.getProgress.mockReset().mockResolvedValue(null);
  nativeProgress.clearProgress.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  progress.finished = true;
  progress.progress = 100;
  progress.isActive = false;
  progress.item = {
    id: "engine_0",
    generation: 1n,
    progress: 100,
    finished: true,
    state: "failed",
  };
  progress.clear.mockReset().mockResolvedValue(undefined);
  progress.fence.mockReset();
  notifyListenerError.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("a failed download does not mark the engine as installed", async () => {
  await act(async () => {
    root.render(
      <ProgressButton
        id="engine_0"
        initInstalled={false}
        onClick={() => undefined}
        labels={{
          completed: "Installed",
          action: "Install",
          inProgress: "Downloading",
          finalizing: "Extracting",
        }}
        inProgress={false}
        setInProgress={() => undefined}
      />,
    );
  });
  const button = host.querySelector("button");
  expect(button?.textContent).toContain("Install");
  expect(button?.disabled).toBe(false);
  expect(host.querySelector("[data-testid='progress']")).toBeNull();
});

test("failed partial progress has no fill while showProgress is set", async () => {
  progress.progress = 37;
  progress.item = { ...progress.item, progress: 37, state: "failed" };
  await act(async () => {
    root.render(
      <ProgressButton
        id="job"
        initInstalled={false}
        completeOnProgressSuccess={false}
        onClick={() => undefined}
        labels={{ completed: "Done", action: "Install", inProgress: "Downloading" }}
        inProgress
        setInProgress={() => undefined}
      />,
    );
  });
  expect(host.querySelector("[data-testid='progress']")).toBeNull();
});

test("cancelled progress does not mark the action completed", async () => {
  progress.item = { ...progress.item, state: "cancelled" };
  await act(async () => {
    root.render(
      <ProgressButton
        id="engine_0"
        initInstalled={false}
        onClick={() => undefined}
        labels={{
          completed: "Installed",
          action: "Install",
          inProgress: "Downloading",
          finalizing: "Extracting",
        }}
        inProgress={false}
        setInProgress={() => undefined}
      />,
    );
  });
  const button = host.querySelector("button");
  expect(button?.textContent).toContain("Install");
  expect(button?.disabled).toBe(false);
});

test("initInstalled marks the action completed even if progress failed", async () => {
  await act(async () => {
    root.render(
      <ProgressButton
        id="engine_0"
        initInstalled
        onClick={() => undefined}
        labels={{
          completed: "Installed",
          action: "Install",
          inProgress: "Downloading",
          finalizing: "Extracting",
        }}
        inProgress={false}
        setInProgress={() => undefined}
      />,
    );
  });
  const button = host.querySelector("button");
  expect(button?.textContent).toContain("Installed");
  expect(button?.disabled).toBe(true);
});

test("completeOnProgressSuccess false ignores a succeeded download job", async () => {
  progress.item = { ...progress.item, state: "succeeded" };
  await act(async () => {
    root.render(
      <ProgressButton
        id="engine_0"
        initInstalled={false}
        completeOnProgressSuccess={false}
        onClick={() => undefined}
        labels={{
          completed: "Installed",
          action: "Install",
          inProgress: "Downloading",
          finalizing: "Extracting",
        }}
        inProgress={false}
        setInProgress={() => undefined}
      />,
    );
  });
  const button = host.querySelector("button");
  expect(button?.textContent).toContain("Install");
  expect(button?.disabled).toBe(false);
});

test("a succeeded download marks the action completed", async () => {
  progress.item = { ...progress.item, state: "succeeded" };
  await act(async () => {
    root.render(
      <ProgressButton
        id="engine_0"
        initInstalled={false}
        onClick={() => undefined}
        labels={{
          completed: "Installed",
          action: "Install",
          inProgress: "Downloading",
          finalizing: "Extracting",
        }}
        inProgress={false}
        setInProgress={() => undefined}
      />,
    );
  });
  const button = host.querySelector("button");
  expect(button?.textContent).toContain("Installed");
  expect(button?.disabled).toBe(true);
});

test("a late clear acknowledgement cannot stop a replacement operation", async () => {
  progress.finished = false;
  progress.item = { ...progress.item, finished: false, state: "running" };
  let resolveClear: () => void = () => undefined;
  progress.clear.mockReturnValueOnce(new Promise<void>((resolve) => (resolveClear = resolve)));
  const setInProgress = vi.fn();
  const render = (id: string) =>
    root.render(
      <ProgressButton
        id={id}
        initInstalled={false}
        onClick={() => undefined}
        onCancel={vi.fn()}
        labels={{ completed: "Done", action: "Run", inProgress: "Running" }}
        inProgress
        setInProgress={setInProgress}
      />,
    );
  await act(async () => render("old"));
  await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='cancel']")!.click());
  await act(async () => render("replacement"));
  await act(async () => resolveClear());
  expect(setInProgress).not.toHaveBeenCalledWith(false);
});

test("reports clear rejection while keeping the running UI", async () => {
  progress.finished = false;
  progress.item = { ...progress.item, finished: false, state: "running" };
  const failure = new Error("clear failed");
  progress.clear.mockRejectedValueOnce(failure);
  const setInProgress = vi.fn();
  await act(async () => {
    root.render(
      <ProgressButton
        id="job"
        initInstalled={false}
        onClick={() => undefined}
        onCancel={vi.fn()}
        labels={{ completed: "Done", action: "Run", inProgress: "Running" }}
        inProgress
        setInProgress={setInProgress}
      />,
    );
  });
  await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='cancel']")!.click());
  expect(notifyListenerError).toHaveBeenCalledWith(failure);
  expect(setInProgress).not.toHaveBeenCalledWith(false);
});

test("a successful non-clearing cancel fences its returned generation", async () => {
  progress.progress = 50;
  progress.finished = false;
  progress.isActive = true;
  progress.item = { ...progress.item, progress: 50, finished: false, state: "running" };
  const onCancel = vi.fn().mockResolvedValue({ clearedGeneration: 4n });
  const setInProgress = vi.fn();

  await act(async () => {
    root.render(
      <ProgressButton
        id="job"
        initInstalled={false}
        onClick={() => undefined}
        onCancel={onCancel}
        clearOnCancel={false}
        labels={{ completed: "Done", action: "Run", inProgress: "Running" }}
        inProgress
        setInProgress={setInProgress}
      />,
    );
  });
  await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='cancel']")!.click());

  expect(onCancel).toHaveBeenCalledOnce();
  expect(progress.clear).not.toHaveBeenCalled();
  expect(progress.fence).toHaveBeenCalledWith(4n);
  expect(setInProgress).toHaveBeenCalledWith(false);
});

test("a successful non-clearing cancel with no generation fences the displayed generation", async () => {
  progress.progress = 50;
  progress.finished = false;
  progress.isActive = true;
  progress.item = { ...progress.item, progress: 50, finished: false, state: "running" };
  const onCancel = vi.fn().mockResolvedValue({ clearedGeneration: null });
  const setInProgress = vi.fn();

  await act(async () => {
    root.render(
      <ProgressButton
        id="job"
        initInstalled={false}
        onClick={() => undefined}
        onCancel={onCancel}
        clearOnCancel={false}
        labels={{ completed: "Done", action: "Run", inProgress: "Running" }}
        inProgress
        setInProgress={setInProgress}
      />,
    );
  });
  await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='cancel']")!.click());

  expect(progress.clear).not.toHaveBeenCalled();
  expect(progress.fence).toHaveBeenCalledWith(2n);
  expect(setInProgress).toHaveBeenCalledWith(false);
});

test("a null acknowledgement with nothing displayed at press time keeps the null fence", async () => {
  Object.assign(progress, { item: null });
  const onCancel = vi.fn().mockResolvedValue({ clearedGeneration: null });
  await act(async () => {
    root.render(
      <ProgressButton
        id="job"
        initInstalled={false}
        onClick={() => undefined}
        onCancel={onCancel}
        clearOnCancel={false}
        labels={{ completed: "Done", action: "Run", inProgress: "Running" }}
        inProgress
        setInProgress={() => undefined}
      />,
    );
  });
  await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='cancel']")!.click());
  expect(progress.fence).toHaveBeenCalledExactlyOnceWith(null);
});

test("a non-clearing cancel without an outcome keeps the null fence", async () => {
  progress.isActive = true;
  const onCancel = vi.fn().mockResolvedValue(undefined);
  await act(async () => {
    root.render(
      <ProgressButton
        id="job"
        initInstalled={false}
        onClick={() => undefined}
        onCancel={onCancel}
        clearOnCancel={false}
        labels={{ completed: "Done", action: "Run", inProgress: "Running" }}
        inProgress
        setInProgress={() => undefined}
      />,
    );
  });
  await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='cancel']")!.click());
  expect(progress.fence).toHaveBeenCalledExactlyOnceWith(null);
});

async function reportProgress(generation: bigint, value: number) {
  await act(async () =>
    nativeProgress.listener!({
      payload: {
        id: "job",
        generation: generation.toString(),
        progress: value,
        finished: false,
        state: "running",
        cleared: false,
      },
    }),
  );
}

async function renderNativeProgress(onCancel: () => Promise<{ clearedGeneration: null }>) {
  nativeProgress.enabled = true;
  await act(async () =>
    root.render(
      <ProgressButton
        id="job"
        initInstalled={false}
        onClick={() => undefined}
        onCancel={onCancel}
        clearOnCancel={false}
        labels={{ completed: "Done", action: "Run", inProgress: "Running" }}
        inProgress={false}
        setInProgress={() => undefined}
      />,
    ),
  );
}

test("a late null cancel acknowledgement leaves a newer generation visible and updating", async () => {
  let acknowledge!: (outcome: { clearedGeneration: null }) => void;
  const onCancel = vi.fn(
    () =>
      new Promise<{ clearedGeneration: null }>((resolve) => {
        acknowledge = resolve;
      }),
  );
  await renderNativeProgress(onCancel);
  await reportProgress(9007199254740993n, 30);
  await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='cancel']")!.click());
  await reportProgress(9007199254740994n, 40);
  await act(async () => acknowledge({ clearedGeneration: null }));
  expect(host.querySelector("[data-testid='progress']")?.textContent).toBe("40");
  expect(host.querySelector("[data-testid='cancel']")).not.toBeNull();
  await reportProgress(9007199254740994n, 65);
  expect(host.querySelector("[data-testid='progress']")?.textContent).toBe("65");
});

test("out-of-order Cancel answers hide only the generations each press displayed", async () => {
  const answers: Array<(outcome: { clearedGeneration: null }) => void> = [];
  const onCancel = vi.fn(
    () =>
      new Promise<{ clearedGeneration: null }>((resolve) => {
        answers.push(resolve);
      }),
  );
  await renderNativeProgress(onCancel);
  await reportProgress(3n, 30);
  await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='cancel']")!.click());
  await reportProgress(4n, 40);
  await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='cancel']")!.click());
  expect(onCancel).toHaveBeenCalledTimes(2);
  await act(async () => answers[1]({ clearedGeneration: null }));
  expect(host.querySelector("[data-testid='progress']")).toBeNull();
  expect(host.querySelector("[data-testid='cancel']")).toBeNull();
  await reportProgress(5n, 50);
  await act(async () => answers[0]({ clearedGeneration: null }));
  expect(host.querySelector("[data-testid='progress']")?.textContent).toBe("50");
  expect(host.querySelector("[data-testid='cancel']")).not.toBeNull();
  await reportProgress(4n, 90);
  expect(host.querySelector("[data-testid='progress']")?.textContent).toBe("50");
  await reportProgress(5n, 70);
  expect(host.querySelector("[data-testid='progress']")?.textContent).toBe("70");
});

test.each([9007199254740993n, 18446744073709551615n])(
  "a rejected wire clear safely fences generation %s and ignores delayed frames",
  async (generation) => {
    nativeProgress.clearProgress.mockRejectedValue({
      tag: "backend-error",
      category: "conflict",
      message: "clear refused",
    });
    await renderNativeProgress(async () => {
      try {
        await tauri.clearProgress("job");
      } catch {
        return { clearedGeneration: null };
      }
      throw new Error("expected a rejected clear");
    });
    await reportProgress(generation, 35);
    expect(host.querySelector("[data-testid='progress']")?.textContent).toBe("35");
    await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='cancel']")!.click());
    expect(host.querySelector("[data-testid='progress']")).toBeNull();
    await reportProgress(generation, 75);
    expect(host.querySelector("[data-testid='progress']")).toBeNull();
    if (generation < 18446744073709551615n) {
      await reportProgress(generation + 1n, 45);
    }
    expect(host.querySelector("[data-testid='progress']")?.textContent).toBe(
      generation < 18446744073709551615n ? "45" : undefined,
    );
  },
);

test("a rejected cancel keeps the running UI and is not reported by the button", async () => {
  progress.progress = 50;
  progress.finished = false;
  progress.isActive = true;
  progress.item = { ...progress.item, progress: 50, finished: false, state: "running" };
  const failure = new Error("cancel failed");
  const setInProgress = vi.fn();
  const onCancel = vi.fn().mockRejectedValue(failure);

  await act(async () => {
    root.render(
      <ProgressButton
        id="job"
        initInstalled={false}
        onClick={() => undefined}
        onCancel={onCancel}
        clearOnCancel={false}
        labels={{ completed: "Done", action: "Run", inProgress: "Running" }}
        inProgress
        setInProgress={setInProgress}
      />,
    );
  });
  await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='cancel']")!.click());

  expect(progress.clear).not.toHaveBeenCalled();
  expect(progress.fence).not.toHaveBeenCalled();
  expect(setInProgress).not.toHaveBeenCalledWith(false);
  expect(notifyListenerError).not.toHaveBeenCalled();
});

test.each([
  ["cancelled", false],
  ["failed", false],
  ["running", true],
] as const)("renders the progress bar for %s according to its state", async (state, hasBar) => {
  progress.progress = 50;
  progress.finished = state !== "running";
  progress.isActive = state === "running";
  progress.item = { ...progress.item, progress: 50, finished: state !== "running", state };

  await act(async () => {
    root.render(
      <ProgressButton
        id="job"
        initInstalled={false}
        onClick={() => undefined}
        labels={{ completed: "Done", action: "Run", inProgress: "Running" }}
        inProgress={false}
        setInProgress={() => undefined}
      />,
    );
  });

  expect(host.querySelector("[data-testid='progress']") !== null).toBe(hasBar);
  expect(host.querySelector("[data-testid='progress']")?.getAttribute("aria-label") ?? null).toBe(
    hasBar ? "Running" : null,
  );
});

test("retained wire success shows finalization only while owned, including after rejected clear and remount", async () => {
  nativeProgress.enabled = true;
  nativeProgress.getProgress.mockResolvedValue({
    status: "ok",
    data: {
      id: "job",
      generation: "9007199254740993",
      progress: 100,
      finished: true,
      state: "succeeded",
    },
  });
  nativeProgress.clearProgress.mockRejectedValue({
    tag: "backend-error",
    category: "conflict",
    message: "clear refused",
  });
  const render = (inProgress: boolean) =>
    root.render(
      <ProgressButton
        id="job"
        initInstalled={false}
        completeOnProgressSuccess={false}
        onClick={() => undefined}
        labels={{
          completed: "Done",
          action: "Run",
          inProgress: "Running",
          finalizing: "Finalizing",
        }}
        inProgress={inProgress}
        setInProgress={() => undefined}
      />,
    );

  await act(async () => render(true));
  expect(host.querySelector("[data-testid='progress']")?.textContent).toBe("100");
  expect(host.querySelector("button")?.textContent).toContain("Finalizing");
  expect(host.querySelector("button")?.disabled).toBe(true);
  await expect(tauri.clearProgress("job")).rejects.toThrow("clear refused");
  expect(nativeProgress.clearProgress).toHaveBeenCalledExactlyOnceWith("job");
  await act(async () => render(false));
  expect(host.querySelector("[data-testid='progress']")).toBeNull();
  expect(host.querySelector("button")?.textContent).toBe("Run");
  expect(host.querySelector("button")?.disabled).toBe(false);

  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => render(false));
  expect(nativeProgress.getProgress).toHaveBeenCalledTimes(2);
  expect(host.querySelector("[data-testid='progress']")).toBeNull();
  expect(host.querySelector("button")?.textContent).toBe("Run");
  expect(host.querySelector("button")?.disabled).toBe(false);
  await reportProgress(9007199254740994n, 45);
  expect(host.querySelector("[data-testid='progress']")?.textContent).toBe("45");
  expect(host.querySelector("button")?.disabled).toBe(true);
});

test("ownerless wire Running remains visible and cancellable after remount and rejected cancel", async () => {
  nativeProgress.getProgress.mockResolvedValue({
    status: "ok",
    data: { id: "job", generation: "7", progress: 45, finished: false, state: "running" },
  });
  const onCancel = vi.fn().mockRejectedValue(new Error("cancel refused"));
  await renderNativeProgress(onCancel);
  await act(async () => root.unmount());
  root = createRoot(host);
  await renderNativeProgress(onCancel);
  expect(nativeProgress.getProgress).toHaveBeenCalledTimes(2);
  expect(host.querySelector("[data-testid='progress']")?.textContent).toBe("45");
  expect(host.querySelector("button")?.disabled).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='cancel']")!.click());
  expect(onCancel).toHaveBeenCalledOnce();
  expect(host.querySelector("[data-testid='progress']")?.textContent).toBe("45");
  expect(host.querySelector("[data-testid='cancel']")).not.toBeNull();
  expect(nativeProgress.clearProgress).not.toHaveBeenCalled();
});
