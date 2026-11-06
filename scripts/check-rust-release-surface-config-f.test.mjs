import { describe, expect, test } from "vitest";
import {
  CHECKOUT_FILES,
  expectCliStatus,
  runCheckerOver,
} from "./rust-release-surface-fixture.mjs";

describe("R5 config, test-only scope, and physical source surface", () => {
  const packageManifest = new Map(CHECKOUT_FILES).get("src-tauri/Cargo.toml");
  const packageTargetRoots = [
    [
      "bin target path",
      '\n[[bin]]\nname = "chessriddle-studio"\npath = "release_main.rs"\nautobins = false\n',
      "Cargo manifest path keys may add Rust code",
    ],
    [
      "lib target path",
      '\n[lib]\npath = "../lib.rs"\n',
      "Cargo manifest path keys may add Rust code",
    ],
    ["autobins key", "\nautobins = false\n", "may not change the production target roots"],
    ["quoted bin table", "\n['bin']\n", "may not change the production target roots"],
    [
      "inline local path dependency",
      '\nhelper = { path = "../helper" }\n',
      "Cargo manifest path keys may add Rust code",
    ],
    [
      "dotted local path dependency",
      '\nhelper.path = "../helper"\n',
      "Cargo manifest path keys may add Rust code",
    ],
    [
      "patch path dependency",
      "\n[patch.crates-io]\nserde = { 'path' = \"../serde\" }\n",
      "Cargo manifest path keys may add Rust code",
    ],
    [
      "package workspace key",
      '\nworkspace = "../cargo-workspace"\n',
      "may not change the production target roots",
    ],
    ["quoted workspace table", "\n['workspace']\n", "may not change the production target roots"],
  ];
  test.each(packageTargetRoots)("O3.15 rejects %s", async (_name, suffix, diagnostic) => {
    const result = await runCheckerOver([
      { path: "src-tauri/Cargo.toml", contents: `${packageManifest}${suffix}` },
    ]);
    expectCliStatus(result, 1);
    expect(result.output).toContain(`src-tauri/Cargo.toml: R5: ${diagnostic}`);
  });
  test("O3.15 rejects a root-manifest patch path", async () => {
    const result = await runCheckerOver([
      { path: "Cargo.toml", contents: '[patch.crates-io]\nserde = { path = "../serde" }\n' },
    ]);
    expectCliStatus(result, 1);
    expect(result.output).toContain("Cargo.toml: R5: Cargo manifest path keys may add Rust code");
  });
  test("O3.15 accepts a path value and the real package manifest", async () => {
    const withDescription = packageManifest.replace(
      'description = "A Modern Chess Database"',
      'description = "a path"',
    );
    const result = await runCheckerOver([
      { path: "src-tauri/Cargo.toml", contents: withDescription },
    ]);
    expectCliStatus(result, 0);
  });
  test.each(["../pgn-reader", "vendor/other-reader"])(
    "rejects a changed pgn-reader patch destination %s",
    async (destination) => {
      const result = await runCheckerOver([
        {
          path: "src-tauri/Cargo.toml",
          contents: packageManifest.replace(
            'path = "vendor/pgn-reader"',
            `path = "${destination}"`,
          ),
        },
      ]);
      expectCliStatus(result, 1);
      expect(result.output).toContain("Cargo manifest path keys may add Rust code");
    },
  );
  test("rejects the approved spelling outside the patch table", async () => {
    const result = await runCheckerOver([
      {
        path: "src-tauri/Cargo.toml",
        contents: packageManifest.replace("[patch.crates-io]", "[dependencies.other]"),
      },
    ]);
    expectCliStatus(result, 1);
    expect(result.output).toContain("Cargo manifest path keys may add Rust code");
  });
});
