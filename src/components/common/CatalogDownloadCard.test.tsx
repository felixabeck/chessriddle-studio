import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PathRef } from "@/bindings";
import type ProgressButton from "./ProgressButton";
import { runDownloadJob } from "@/hooks/downloadJobs";
import CatalogDownloadCard from "./CatalogDownloadCard";

type ProgressButtonProps = ComponentProps<typeof ProgressButton>;

const mocks = vi.hoisted(() => ({
  progressButtonProps: null as ProgressButtonProps | null,
  notify: vi.fn(),
  downloadFile: vi.fn(),
  cancelDownload: vi.fn(),
  cancelDownloadForProgress: vi.fn(),
  clearProgress: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/components/files/notifyError", () => ({
  notifyUnlessCancelled: mocks.notify,
  runUnlessCancelled: async (title: string, run: () => Promise<unknown>, domain?: string) => {
    try {
      return await run();
    } catch (error) {
      mocks.notify(title, error, domain);
      return undefined;
    }
  },
}));
vi.mock("@/platform/tauri", async (original) => {
  const actual = await original<typeof import("@/platform/tauri")>();
  return {
    cancellationError: actual.cancellationError,
    tauri: {
      downloadFile: mocks.downloadFile,
      cancelDownload: mocks.cancelDownload,
      cancelDownloadForProgress: mocks.cancelDownloadForProgress,
      clearProgress: mocks.clearProgress,
      getProgress: vi.fn(async () => null),
    },
    tauriSubscriptions: { progress: vi.fn(async () => () => {}) },
    withDownloadTicket: (run: (ticket: string) => Promise<unknown>) => run("ticket-1"),
  };
});
vi.mock("@mantine/core", () => ({
  Box: ({ children }: any) => <div>{children}</div>,
  Divider: () => <hr />,
  Group: ({ children }: any) => <div>{children}</div>,
  Paper: ({ children }: any) => <div>{children}</div>,
  Stack: ({ children }: any) => <div data-stat>{children}</div>,
  Text: ({ children }: any) => <span>{children}</span>,
}));
vi.mock("./ProgressButton", () => ({
  default: (props: ProgressButtonProps) => {
    mocks.progressButtonProps = props;
    return (
      <button type="button" onClick={() => props.onClick(props.id)}>
        {props.labels.action}
      </button>
    );
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const item = {
  title: "Masters",
  description: "Classical games",
  downloadLink: "https://example.test/masters.db3",
  sha256: "b".repeat(64),
  signature: "sig",
};
const destination: PathRef = { id: "destination" };
const progressId = "catalog:masters";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.progressButtonProps = null;
  mocks.clearProgress.mockResolvedValue(1n);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(overrides: Partial<ComponentProps<typeof CatalogDownloadCard>> = {}) {
  const props: ComponentProps<typeof CatalogDownloadCard> = {
    item,
    kindLabel: "Kind.Label",
    stats: [
      { label: "Stat.Size", value: "1 KB" },
      { label: "Stat.Games", value: "12" },
    ],
    progressId,
    initInstalled: false,
    resolveDestination: vi.fn(async () => destination),
    leaf: "Masters.db3",
    onInstalled: vi.fn(async () => {}),
    errorDomain: "database",
    ...overrides,
  };
  await act(async () => root.render(<CatalogDownloadCard {...props} />));
  return props;
}

test("renders the kind, title, description and each stat in order", async () => {
  await render({ initInstalled: true });
  expect(host.textContent).toContain("Kind.Label");
  expect(host.textContent).toContain("Masters");
  expect(host.textContent).toContain("Classical games");
  expect([...host.querySelectorAll("[data-stat]")].map((stat) => stat.textContent)).toEqual([
    "Stat.Size1 KB",
    "Stat.Games12",
  ]);
  expect(mocks.progressButtonProps).toMatchObject({
    id: progressId,
    initInstalled: true,
    clearOnCancel: false,
    inProgress: false,
    labels: {
      completed: "Common.Installed",
      action: "Common.Install",
      inProgress: "Common.Downloading",
      finalizing: "Common.Extracting",
    },
  });
});

test("resolves the destination inside the job, downloads the leaf, then runs onInstalled", async () => {
  const order: string[] = [];
  mocks.downloadFile.mockImplementation(async () => {
    order.push("download");
  });
  const props = await render({
    resolveDestination: vi.fn(async () => {
      order.push("destination");
      return destination;
    }),
    onInstalled: vi.fn(async () => {
      order.push("installed");
    }),
  });

  await act(async () => host.querySelector("button")!.click());

  expect(order).toEqual(["destination", "download", "installed"]);
  expect(mocks.downloadFile).toHaveBeenCalledExactlyOnceWith(
    progressId,
    item.downloadLink,
    destination,
    "Masters.db3",
    null,
    "ticket-1",
    { sha256: item.sha256, signature: item.signature },
  );
  expect(props.onInstalled).toHaveBeenCalledExactlyOnceWith();
  expect(mocks.notify).not.toHaveBeenCalled();
  expect(mocks.progressButtonProps?.inProgress).toBe(false);
});

test("reports a failed download under the card's error domain", async () => {
  const failure = new Error("network");
  mocks.downloadFile.mockRejectedValue(failure);
  const props = await render({ errorDomain: "puzzle" });

  await act(async () => host.querySelector("button")!.click());

  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith("Common.Error", failure, "puzzle");
  expect(props.onInstalled).not.toHaveBeenCalled();
});

test("shows a job started elsewhere for its progress id as in progress", async () => {
  await render();
  let finish!: () => void;
  let job!: Promise<unknown>;
  await act(async () => {
    job = runDownloadJob(progressId, () => new Promise<void>((resolve) => (finish = resolve)));
  });
  expect(mocks.progressButtonProps?.inProgress).toBe(true);

  await act(async () => {
    finish();
    await job;
  });
  expect(mocks.progressButtonProps?.inProgress).toBe(false);
});

test("notifies a failed cancel request under the common error title", async () => {
  const failure = new Error("ipc down");
  mocks.cancelDownloadForProgress.mockRejectedValue(failure);
  await render();

  await expect(act(async () => mocks.progressButtonProps!.onCancel!())).rejects.toMatchObject({
    reason: "request",
  });
  expect(mocks.cancelDownloadForProgress).toHaveBeenCalledExactlyOnceWith(progressId);
  expect(mocks.notify).toHaveBeenCalledExactlyOnceWith("Common.Error", failure);
});
