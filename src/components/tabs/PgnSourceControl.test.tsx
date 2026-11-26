import { MantineProvider } from "@mantine/core";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FileMetadata } from "@/components/files/file";
import { installMatchMediaStub } from "@/tests/matchMedia";
import { PgnSourceControl } from "./PgnSourceControl";

const mocks = vi.hoisted(() => ({
  pickPgnFile: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/utils/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/files")>()),
  pickPgnFile: mocks.pickPgnFile,
}));
vi.mock("@/components/files/notifyError", () => ({
  runUnlessCancelled: async (_title: string, action: () => Promise<void>) => action(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
installMatchMediaStub();

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function ControlledPgnSource({
  onFileChangeSpy,
  disabled = false,
}: {
  onFileChangeSpy: (value: FileMetadata | null) => void;
  disabled?: boolean;
}) {
  const [file, setFile] = useState<FileMetadata | null>(null);
  const [pgn, setPgn] = useState("");
  return (
    <PgnSourceControl
      file={file}
      onFileChange={(next) => {
        onFileChangeSpy(next);
        setFile(next);
      }}
      pgn={pgn}
      onPgnChange={setPgn}
      disabled={disabled}
    />
  );
}

test("real Mantine FileInput and Textarea mutually disable and clearing via picker null re-enables textarea", async () => {
  const sampleFile: FileMetadata = {
    type: "file",
    name: "sicilian.pgn",
    handle: { id: { id: "sicilian" }, kind: "fileWorkspace" },
    numGames: 2,
    metadata: { type: "game", tags: [] },
    lastModified: 1,
  };
  mocks.pickPgnFile.mockResolvedValueOnce(sampleFile).mockResolvedValueOnce(null);
  const onFileChange = vi.fn();

  await act(async () => {
    root.render(
      <MantineProvider>
        <ControlledPgnSource onFileChangeSpy={onFileChange} />
      </MantineProvider>,
    );
  });

  const fileButton = () => host.querySelector<HTMLButtonElement>("button.mantine-FileInput-input")!;
  const textarea = () => host.querySelector<HTMLTextAreaElement>("textarea")!;

  expect(fileButton().disabled).toBe(false);
  expect(textarea().disabled).toBe(false);

  // Picking a file disables the textarea.
  await act(async () => {
    fileButton().click();
  });
  await vi.waitFor(() => expect(textarea().disabled).toBe(true));
  expect(onFileChange).toHaveBeenLastCalledWith(sampleFile);
  expect(fileButton().textContent).toContain("sicilian.pgn");

  // Re-clicking the file input when pickPgnFile resolves to null clears the file and re-enables textarea.
  await act(async () => {
    fileButton().click();
  });
  await vi.waitFor(() => expect(textarea().disabled).toBe(false));
  expect(onFileChange).toHaveBeenLastCalledWith(null);

  // Typing PGN disables the FileInput button.
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textarea(), "1. e4 e5 *");
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(fileButton().disabled).toBe(true);

  // Passing disabled={true} disables both inputs and blocks picker invocation.
  await act(async () => {
    root.render(
      <MantineProvider>
        <ControlledPgnSource onFileChangeSpy={onFileChange} disabled />
      </MantineProvider>,
    );
  });
  expect(fileButton().disabled).toBe(true);
  expect(textarea().disabled).toBe(true);
  await act(async () => {
    fileButton().click();
  });
  expect(mocks.pickPgnFile).toHaveBeenCalledTimes(2);
});
