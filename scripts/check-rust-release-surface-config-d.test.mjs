import { describe, expect, test } from "vitest";
import {
  CHECKOUT_FILES,
  expectCliStatus,
  replaceExisting,
  runCheckerOver,
  withPackageDescription,
} from "./rust-release-surface-fixture.mjs";

describe("R5 config, test-only scope, and physical source surface", () => {
  const packageManifest = new Map(CHECKOUT_FILES).get("src-tauri/Cargo.toml");
  const packageLintManifests = [
    ["lints.clippy table", '\n[lints.clippy]\ndisallowed_methods = "allow"\n'],
    ["workspace lints table", '\n[workspace.lints.rust]\nwarnings = "allow"\n'],
    ["inline lints table", '\nlints = { clippy = { all = "allow" } }\n'],
    ["dotted lints key", '\nlints.clippy.extra = "allow"\n'],
    ["double-quoted header key", '\n["lints".clippy]\ndisallowed_methods = "allow"\n'],
    ["single-quoted header key", "\n['lints'.clippy]\ndisallowed_methods = \"allow\"\n"],
    ["single-quoted dotted key", "\n'lints'.clippy.extra = \"allow\"\n"],
    ["lints table header", '\n["lints"]\n'],
    ["basic string escape", '\nprobe = "a\\\\b"\n'],
    ["cargo-features key", '\ncargo-features = ["different"]\n'],
    ["quoted cargo-features key", '\n"cargo-features" = ["different"]\n'],
  ];
  test.each(packageLintManifests)(
    "O3.10 rejects %s in the package manifest",
    async (_name, suffix) => {
      const result = await runCheckerOver([
        { path: "src-tauri/Cargo.toml", contents: `${packageManifest}${suffix}` },
      ]);
      expectCliStatus(result, 1);
      expect(result.output).toContain(
        "src-tauri/Cargo.toml: R5: Cargo manifests may not define lint levels or cargo-features",
      );
    },
  );
  test("O3.10 rejects workspace lint levels in the root manifest", async () => {
    const result = await runCheckerOver([
      { path: "Cargo.toml", contents: '[workspace.lints.clippy]\nall = "allow"\n' },
    ]);
    expectCliStatus(result, 1);
    expect(result.output).toContain(
      "Cargo.toml: R5: Cargo manifests may not define lint levels or cargo-features",
    );
  });
  test.each([
    [
      "ordinary description",
      withPackageDescription(packageManifest, 'description = "no lints here"'),
    ],
    ["description value", withPackageDescription(packageManifest, 'description = "lints"')],
    [
      "multiline description value",
      withPackageDescription(packageManifest, 'description = """\nno lints here\n"""'),
    ],
    [
      "keyword value",
      replaceExisting(
        packageManifest,
        "[build-dependencies]",
        'keywords = ["lints"]\n\n[build-dependencies]',
      ),
    ],
    ["comment", `${packageManifest}\n# lints\n`],
  ])("O3.10 accepts %s without a key-position violation", async (_name, contents) => {
    const result = await runCheckerOver([{ path: "src-tauri/Cargo.toml", contents }]);
    expectCliStatus(result, 0);
  });
});
