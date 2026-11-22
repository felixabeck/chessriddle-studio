import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);

test("browser packages are reproducible, self-contained, and share the same code", async (t) => {
  // Built outside the checkout, so a gate run leaves no files behind.
  const out = await mkdtemp(join(tmpdir(), "chessriddle-studio-extension-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const build = () =>
    execFileSync(process.execPath, ["scripts/build.mjs", "--out", out], { cwd: root });
  const readPackages = () =>
    Promise.all(
      ["chrome", "firefox"].map((browser) =>
        readFile(join(out, `chessriddle-studio-${browser}-${version}.zip`)),
      ),
    );
  build();
  const first = await readPackages();
  build();
  const second = await readPackages();
  assert.deepEqual(second, first);
  const [chrome, firefox] = second.map(unzipSync);
  const decode = (value) => new TextDecoder().decode(value);
  for (const files of [chrome, firefox]) {
    const manifest = JSON.parse(decode(files["manifest.json"]));
    for (const path of [
      ...manifest.content_scripts[0].js,
      ...manifest.content_scripts[0].css,
      ...Object.values(manifest.icons),
      "LICENSE",
    ]) {
      assert.ok(files[path]?.length, path);
    }
    // Tests, the link contract and the documents stay out of the store packages.
    assert.deepEqual(Object.keys(files).sort(), [
      "LICENSE",
      "icons/128.png",
      "icons/16.png",
      "icons/32.png",
      "icons/48.png",
      "manifest.json",
      "src/content.css",
      "src/content.js",
      "src/core.js",
    ]);
    assert.equal(manifest.version, version);
    assert.equal(manifest.name, "Analyze in ChessRiddle Studio");
  }
  assert.equal(JSON.parse(decode(chrome["manifest.json"])).browser_specific_settings, undefined);
  assert.equal(
    JSON.parse(decode(firefox["manifest.json"])).browser_specific_settings.gecko.id,
    "studio-link@chessriddle.com",
  );
  for (const path of Object.keys(chrome).filter((path) => path !== "manifest.json")) {
    assert.deepEqual(chrome[path], firefox[path], path);
  }
});

test("the build refuses --out without a directory", () => {
  assert.throws(() =>
    execFileSync(process.execPath, ["scripts/build.mjs", "--out"], { cwd: root, stdio: "pipe" }),
  );
});
