import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

// release.yml runs this exact command line; a broken entry point must fail here, not on a tag.
const script = join(import.meta.dirname, "release-notes.mjs");
const repo = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const changelog = join(dir, "CHANGELOG.md");
writeFileSync(changelog, "# Changelog\n\n## 2.0.0\n\n- two\n\n## 1.0.0\n");

const run = (args, cwd = dir) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });

test("prints the tag's section and exits 0", () => {
  expect(run(["v2.0.0"])).toMatchObject({ status: 0, stdout: "- two\n", stderr: "" });
  expect(run(["2.0.0", changelog], repo)).toMatchObject({ status: 0, stdout: "- two\n" });
});

test("fails a missing or empty section with no output", () => {
  for (const tag of ["v3.0.0", "v1.0.0"]) {
    const result = run([tag]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^::error::CHANGELOG\.md/);
  }
});

test("refuses to run without a tag", () => {
  expect(run([])).toMatchObject({ status: 2, stdout: "" });
});
