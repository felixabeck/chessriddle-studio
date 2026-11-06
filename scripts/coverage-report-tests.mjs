import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  rm,
  readFile,
  rename as renameFile,
  symlink,
  unlink as unlinkFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import test, { after } from "node:test";
import {
  assertAreaFloors,
  assertBaseline,
  assignArea,
  buildCoverageReport,
  parseLcov,
  scopeSignature,
  writeBaseline,
} from "./coverage-report.mjs";
import {
  excluded,
  excludePatterns,
  globToRegExp,
  matches,
  normalisePath,
} from "./coverage-scope.mjs";
import {
  assertNoStaleRawProfiles,
  clearStaleRawProfiles,
  coverageTools,
  exportLcovOrDiagnose,
  formatExportCrashMessage,
  isCoverageExecutable,
  llvmCovExportArgs,
  probeCrashingSources,
  runBranchCoverage,
} from "./rust-branch-coverage.mjs";
import { filesBelow } from "./files-below.mjs";
import { RUST_COVERAGE_TOOLCHAIN } from "./toolchain-versions.mjs";
import { copyRustCoverageEntrypoint } from "./rust-coverage-test-harness.mjs";
import { maskRustSource, maskRustSourceWithSpans } from "./rust-source-mask.mjs";
import { classifyRustTestOnlySources, scanRustTestOnly } from "./rust-test-only.mjs";
import { testTempRoots } from "./test-temp-root.mjs";

const temporaryRoot = testTempRoots(after);

const config = {
  version: 1,
  sources: [
    {
      id: "frontend",
      root: "src",
      include: ["src/**/*.ts"],
      exclude: [{ pattern: "src/**/tests/**" }],
    },
  ],
  areas: [{ id: "utilities", source: "frontend", paths: ["src/utils/**"] }],
};
const lcov = `TN:\nSF:src/utils/example.ts\nFN:1,example\nFNDA:1,example\nDA:1,1\nDA:2,0\nBRDA:1,0,0,1\nBRDA:1,0,1,0\nend_of_record\n`;
const duplicateFunctionLcov = `TN:\nSF:src/utils/example.ts\nFN:1,handler\nFN:10,handler\nFNDA:1,handler\nFNDA:0,handler\nDA:1,1\nDA:10,0\nend_of_record\n`;

async function fixture({ source = "export const example = 1;\n", files = {} } = {}) {
  const root = await temporaryRoot("coverage-report-");
  const fixtureFiles = { "src/utils/example.ts": source, ...files };
  for (const [path, contents] of Object.entries(fixtureFiles)) {
    const filePath = join(root, path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
  return { root };
}

function rustConfig({ include = ["src-tauri/src/**/*.rs"], exclude = [], exclusion = true } = {}) {
  return {
    version: 1,
    sources: [
      {
        id: "backend",
        root: "src-tauri/src",
        include,
        exclude,
        ...(exclusion ? { excludeTestOnlyItems: { reason: "Fixture test-only Rust code." } } : {}),
      },
    ],
    areas: [
      {
        id: "backend-area",
        source: "backend",
        minimumCoverage: { lines: 0, functions: 0, branches: 0 },
        paths: ["src-tauri/src/**"],
      },
    ],
  };
}

async function scanRustFixture(files, source = rustConfig().sources[0]) {
  const { root } = await fixture({ files });
  const result = await scanRustTestOnly({ root, source });
  return { root, result };
}

function physicalLines(source, first, last) {
  return source
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line, number }) => number >= first && number <= last && line.trim())
    .map(({ number }) => number);
}

function metrics(metric, covered, total) {
  return {
    lines: { covered: 2, total: 2 },
    functions: { covered: 1, total: 1 },
    branches: { covered: 1, total: 2 },
    [metric]: { covered, total },
  };
}

function withStatementFree(paths) {
  return {
    ...config,
    sources: [
      {
        ...config.sources[0],
        statementFree: paths.map((path) => ({ path, reason: "Fixture declaration." })),
      },
    ],
  };
}

function lcovRecord(file, { lines = 0, functions = 0, branches = 0 } = {}) {
  const records = [`TN:`, `SF:${file}`];
  for (let index = 1; index <= functions; index += 1) {
    records.push(`FN:${index},function${index}`, `FNDA:1,function${index}`);
  }
  for (let index = 1; index <= lines; index += 1) records.push(`DA:${index},1`);
  for (let index = 1; index <= branches; index += 1) records.push(`BRDA:${index},0,${index - 1},1`);
  records.push("end_of_record", "");
  return records.join("\n");
}

test("the shared Rust masker preserves offsets and separates comments from literal contents", () => {
  const source = String.raw`// { line comment
/* outer { /* nested } */ still open */
let normal = "{ escaped quote: \"";
let raw = r###"{ /* literal */ }"###;
let byte = b"{ not a delimiter";
let c_string = c"{ not a delimiter";
let byte_raw = br##"{ not a delimiter"##;
let c_raw = cr#"{ not a delimiter"#;
let chars = ('x', '\n', '\u{1f}', b'{');
let borrow: &'static str = "value";
'outer: loop { break 'outer; }
let pgn = b"{ Event \"brace\"";`;
  const { masked, comments, literals } = maskRustSourceWithSpans(source);
  assert.equal(maskRustSource(source), masked);
  assert.equal(masked.length, source.length);
  assert.deepEqual(
    masked.split("").filter((character) => character === "\n"),
    source.split("").filter((character) => character === "\n"),
  );
  assert.equal(comments.length, 2);
  assert.equal(literals.length, 12);
  assert.match(masked, /'static/);
  assert.match(masked, /'outer:/);
  assert.match(masked, /break 'outer/);
  assert.doesNotMatch(masked, /u\{1f\}|b"\{ Event/);
  assert.ok(comments.every(({ start, end }) => end > start));
  assert.ok(literals.every(({ start, end }) => end > start));
});

test("Rust cfg and nested cfg_attr predicates use the fixed three-valued test rule", async () => {
  const excludedAttributes = [
    "#[cfg(test)]",
    "#[cfg(all(test, unix))]",
    "#[cfg(not(not(test)))]",
    "#[cfg(any())]",
    "#[cfg_attr(not(test), cfg(test))]",
    '#[cfg(all(test, target_os = "a,b)"))]',
  ];
  const measuredAttributes = [
    "#[cfg(any(test, windows))]",
    "#[cfg(not(test))]",
    "#[cfg(unix)]",
    "#[cfg(all())]",
    "#[cfg_attr(test, allow(dead_code))]",
    "#[cfg_attr(test, cfg_attr(not(test), cfg(test)))]",
    "#[cfg_attr(unix, cfg(test))]",
    '#[cfg(target_os = "macos")]',
  ];

  for (const [attributes, expected] of [
    ...excludedAttributes.map((attribute) => [attribute, true]),
    ...measuredAttributes.map((attribute) => [attribute, false]),
    ["#[allow(dead_code)]\n#[cfg(test)]", true],
  ]) {
    const source = `${attributes}\nfn hidden() {}\nfn production() {}\n`;
    const { result } = await scanRustFixture({ "src-tauri/src/lib.rs": source });
    const lines = result.excludedLines.get("src-tauri/src/lib.rs");
    const hiddenLine = attributes.split("\n").length + 1;
    const productionLine = hiddenLine + 1;
    assert.equal(lines.has(hiddenLine), expected, attributes);
    assert.equal(lines.has(productionLine), false, attributes);
  }
});

test("the in-memory Rust classifier accepts atom valuations and defaults to the test rule", () => {
  const path = "src-tauri/src/lib.rs";
  const unixSource = [{ path, contents: "#[cfg(unix)]\nfn conditional() {}\n" }];
  expectClassifierLines(classifyRustTestOnlySources(unixSource), path, []);
  expectClassifierLines(classifyRustTestOnlySources(unixSource, { unix: false }), path, [1, 2]);
  expectClassifierLines(classifyRustTestOnlySources(unixSource, { unix: true }), path, []);

  const valueSource = [{ path, contents: '#[cfg(target_os = "macos")]\nfn conditional() {}\n' }];
  expectClassifierLines(
    classifyRustTestOnlySources(valueSource, { 'target_os="macos"': false }),
    path,
    [1, 2],
  );
});

function expectClassifierLines(result, path, expected) {
  assert.deepEqual(
    [...result.excludedLines.get(path)].sort((a, b) => a - b),
    expected,
  );
}

test("the in-memory Rust classifier resolves test-only modules from its supplied sources", async () => {
  const files = {
    "src-tauri/src/lib.rs": "#[cfg(test)]\nmod helper;\nfn production() {}\n",
    "src-tauri/src/helper.rs": "mod nested;\npub fn helper() {}\n",
    "src-tauri/src/helper/nested.rs": "pub fn nested() {}\n",
  };
  const sources = Object.entries(files).map(([path, contents]) => ({ path, contents }));
  const inMemory = classifyRustTestOnlySources(sources);
  const { result: filesystem } = await scanRustFixture(files);

  assert.deepEqual(inMemory, filesystem);
  assert.deepEqual([...inMemory.testOnlyFiles].sort(), [
    "src-tauri/src/helper.rs",
    "src-tauri/src/helper/nested.rs",
  ]);

  assert.throws(
    () =>
      classifyRustTestOnlySources([
        { path: "src-tauri/src/lib.rs", contents: "#[cfg(test)]\nmod helper;\n" },
      ]),
    /src-tauri\/src\/lib\.rs:2: cannot resolve test-only module helper/,
  );
  assert.throws(
    () =>
      classifyRustTestOnlySources([
        { path: "src-tauri/src/lib.rs", contents: "#[cfg(test)]\nmod helper;\n" },
        { path: "src-tauri/src/helper.rs", contents: "pub fn one() {}\n" },
        { path: "src-tauri/src/helper/mod.rs", contents: "pub fn two() {}\n" },
      ]),
    /src-tauri\/src\/lib\.rs:2: ambiguous test-only module helper: src-tauri\/src\/helper\.rs, src-tauri\/src\/helper\/mod\.rs/,
  );
});

test("test-only item extents stop at each recognised item terminator", async () => {
  const cases = [
    ["body-bearing fn", 'pub async unsafe extern "C" fn hidden() {\n    let _value = true;\n}'],
    ["const fn", "const fn hidden() {}"],
    ["bare extern fn", "extern fn hidden();"],
    ["extern fn with ABI", 'extern "C" fn hidden();'],
    ["inline module", "mod hidden { fn nested() {} }"],
    [
      "test-only module with spaced comparisons",
      "mod hidden {\n    fn compare(a: i32, b: i32, c: i32) {\n        if a < b && b < c {}\n    }\n}",
    ],
    ["impl", "impl Hidden { fn nested() {} }"],
    ["trait", "trait Hidden { fn nested(&self); }"],
    ["braced struct", "struct Hidden { field: bool, }"],
    ["braced enum", "enum Hidden { Variant, }"],
    ["braced union", "union Hidden { field: u32 }"],
    ["use item", "use crate::hidden;"],
    ["type item", "type Hidden = bool;"],
    ["const item", "const HIDDEN: bool = true;"],
    ["static item", "static HIDDEN: bool = true;"],
    ["tuple struct", "struct Hidden(bool);"],
    ["unit struct", "struct Hidden;"],
    ["braced macro item with semicolon", "fixture! {\n    const VALUE: bool = true;\n};"],
  ];
  for (const [name, snippet] of cases) {
    const source = `#[cfg(test)]\n${snippet}\nfn production_after() {}\n`;
    const { result } = await scanRustFixture({ "src-tauri/src/lib.rs": source });
    const excluded = [...result.excludedLines.get("src-tauri/src/lib.rs")].sort((a, b) => a - b);
    assert.deepEqual(excluded, physicalLines(source, 1, snippet.split("\n").length + 1), name);
    assert.equal(excluded.includes(snippet.split("\n").length + 2), false, name);
  }
});

test("test-only statement extents stop at statement, branch, block, and expression boundaries", async () => {
  const cases = [
    ["let with braced initializer", "  let hidden = {\n    true\n  } && {\n    false\n  };"],
    [
      "if/else-if/else with semicolon",
      "  if first {\n    one();\n  } else if second {\n    two();\n  } else {\n    three();\n  };",
    ],
    ["if/else chain without semicolon", "  if first {\n    one();\n  } else {\n    two();\n  }"],
    [
      "match statement",
      "  match value {\n    Some(_) => { one(); },\n    None => { two(); },\n  };",
    ],
    ["bare block with semicolon", "  {\n    hidden();\n  };"],
    ["expression statement with closure", "  value.with(|slot| {\n    *slot = true;\n  });"],
    ["local item", "  fn local() {\n    hidden();\n  }"],
  ];
  for (const [name, snippet] of cases) {
    const source = `fn enclosing() {\n  #[cfg(test)]\n${snippet}\n  let production_after = true;\n}\n`;
    const { result } = await scanRustFixture({ "src-tauri/src/lib.rs": source });
    const lastTestLine = snippet.split("\n").length + 2;
    assert.deepEqual(
      [...result.excludedLines.get("src-tauri/src/lib.rs")].sort((a, b) => a - b),
      physicalLines(source, 2, lastTestLine),
      name,
    );
    assert.equal(
      result.excludedLines.get("src-tauri/src/lib.rs").has(lastTestLine + 1),
      false,
      name,
    );
  }

  const macroSource = `fn enclosing() {\n  #[cfg(test)]\n  matches! {\n    true, true\n  }\n  && false;\n  let production_after = true;\n}\n`;
  const { result: macroResult } = await scanRustFixture({ "src-tauri/src/lib.rs": macroSource });
  assert.deepEqual([...macroResult.excludedLines.get("src-tauri/src/lib.rs")], [2, 3, 4, 5]);
  assert.equal(macroResult.excludedLines.get("src-tauri/src/lib.rs").has(6), false);
});

test("comma-list extents preserve following parameters, arguments, fields, elements, and variants", async () => {
  const cases = [
    [
      "generic parameter spanning lines",
      "fn consume(\n    #[cfg(test)]\n    observer: Option<\n        &Arc<dyn A + Send>,\n    >,\n    visible: (),\n) {}\n",
      [2, 3, 4, 5],
    ],
    [
      "argument",
      "fn call() {\n  consume(\n    #[cfg(test)]\n    1,\n    2,\n  );\n  production();\n}\n",
      [3, 4],
    ],
    [
      "last argument without comma",
      "fn call() {\n  consume(\n    #[cfg(test)]\n    1\n  );\n  production();\n}\n",
      [3, 4],
    ],
    [
      "struct field",
      "struct Record {\n  #[cfg(test)]\n  hidden: bool,\n  visible: bool,\n}\n",
      [2, 3],
    ],
    ["array element", "const VALUES: [u8; 2] = [\n  #[cfg(test)]\n  1,\n  2,\n];\n", [2, 3]],
    ["enum variant", "enum Kind {\n  #[cfg(test)]\n  Hidden,\n  Visible,\n}\n", [2, 3]],
    [
      "braced const generic argument",
      "fn consume<const N: usize, T>(\n  #[cfg(test)]\n  hidden: Array<{ N + 1 }, ()>,\n  visible: (),\n) {}\n",
      [2, 3],
    ],
  ];
  for (const [name, source, expected] of cases) {
    const { result } = await scanRustFixture({ "src-tauri/src/lib.rs": source });
    assert.deepEqual(
      [...result.excludedLines.get("src-tauri/src/lib.rs")].sort((a, b) => a - b),
      expected,
      name,
    );
  }
});

test("thread_local! braces are item lists and exclude only a test-only static entry", async () => {
  const source = `thread_local! {\n  static PRODUCTION: bool = false;\n  #[cfg(test)]\n  static TEST_ONLY: bool = true;\n}\nfn production_after() {}\n`;
  const { result } = await scanRustFixture({ "src-tauri/src/lib.rs": source });
  assert.deepEqual([...result.excludedLines.get("src-tauri/src/lib.rs")], [3, 4]);
  const stdSource = `std::thread_local! {\n  static PRODUCTION: bool = false;\n  #[cfg(test)]\n  static TEST_ONLY: bool = true;\n}\nfn production_after() {}\n`;
  const { result: stdResult } = await scanRustFixture({ "src-tauri/src/lib.rs": stdSource });
  assert.deepEqual([...stdResult.excludedLines.get("src-tauri/src/lib.rs")], [3, 4]);
});

test("a no-comma match arm with a block RHS stops before the following production arm", async () => {
  const source = `fn enclosing(value: bool) {\n  match value {\n    #[cfg(test)]\n    true => {\n      hidden();\n    }\n    false => {\n      production();\n    }\n  }\n}\n`;
  const { result } = await scanRustFixture({ "src-tauri/src/lib.rs": source });
  assert.deepEqual([...result.excludedLines.get("src-tauri/src/lib.rs")], [3, 4, 5, 6]);
  assert.equal(result.excludedLines.get("src-tauri/src/lib.rs").has(7), false);
});

test("test-only module files are excluded in both layouts and recursively", async () => {
  for (const [target, extra] of [
    ["src-tauri/src/helper.rs", {}],
    ["src-tauri/src/helper/mod.rs", {}],
    ["src-tauri/src/helper.rs", { "src-tauri/src/helper/nested.rs": "pub fn nested() {}\n" }],
  ]) {
    const source = "#[cfg(test)]\nmod helper;\nfn production() {}\n";
    const { result } = await scanRustFixture({
      "src-tauri/src/lib.rs": source,
      [target]: extra["src-tauri/src/helper/nested.rs"]
        ? "// whole test-only module file\nmod nested;\npub fn helper() {}\n"
        : "// whole test-only module file\npub fn helper() {}\n",
      ...extra,
    });
    assert.deepEqual([...result.excludedLines.get("src-tauri/src/lib.rs")], [1, 2]);
    assert.ok(result.testOnlyFiles.has(target), target);
    assert.equal(
      result.excludedLineCounts.get(target),
      extra["src-tauri/src/helper/nested.rs"] ? 3 : 2,
      target,
    );
    assert.equal(result.excludedLines.get(target).has(2), true, target);
    if (extra["src-tauri/src/helper/nested.rs"]) {
      assert.ok(result.testOnlyFiles.has("src-tauri/src/helper/nested.rs"));
      assert.equal(result.excludedLineCounts.get("src-tauri/src/helper/nested.rs"), 1);
    }
  }
});

test("filesystem scanning ignores test-only modules outside its supplied file set", async () => {
  const source = rustConfig().sources[0];
  const parent = "src-tauri/src/lib.rs";
  const child = "src-tauri/src/x.rs";
  const parentSource = "#[cfg(test)]\nmod x;\n";
  const { root } = await fixture({
    files: {
      [parent]: parentSource,
      [child]: "pub fn helper() {}\n",
    },
  });

  const result = await scanRustTestOnly({ root, source, files: [parent] });
  assert.deepEqual([...result.testOnlyFiles], []);
  assert.deepEqual([...result.excludedLines.get(parent)], [1, 2]);
  assert.equal(result.excludedLines.has(child), false);

  const { root: missingRoot } = await fixture({
    files: { [parent]: parentSource },
  });
  await assert.rejects(
    scanRustTestOnly({ root: missingRoot, source, files: [parent] }),
    /src-tauri\/src\/lib\.rs:2: cannot resolve test-only module x/,
  );
});

test("inner cfg attributes exclude their file or enclosing block", async () => {
  const files = {
    "src-tauri/src/file.rs": "#![cfg(test)]\npub fn file_only() {}\n",
    "src-tauri/src/block.rs":
      "fn enclosing()\n{\n  #![cfg(test)]\n  fn block_only() {}\n}\nfn production() {}\n",
  };
  const { result } = await scanRustFixture(files);
  assert.equal(result.testOnlyFiles.has("src-tauri/src/file.rs"), true);
  assert.deepEqual([...result.excludedLines.get("src-tauri/src/file.rs")], [1, 2]);
  assert.deepEqual([...result.excludedLines.get("src-tauri/src/block.rs")], [2, 3, 4, 5]);
  assert.equal(result.excludedLines.get("src-tauri/src/block.rs").has(6), false);
});

test("line mapping leaves production literals alone and includes trailing test-item comments", async () => {
  const source =
    '#[cfg(test)]\nfn hidden() {} // trailing test comment\nconst PRODUCTION: &str = "literal";\nfn after() {}\n';
  const { result } = await scanRustFixture({ "src-tauri/src/lib.rs": source });
  assert.deepEqual([...result.excludedLines.get("src-tauri/src/lib.rs")], [1, 2]);
  assert.equal(result.excludedLines.get("src-tauri/src/lib.rs").has(3), false);
});

test("line mapping excludes empty lines inside a test item and keeps those between items", async () => {
  // Measured on the real tree: `llvm-cov` emits a `DA` record for a blank line inside a test body
  // or a multi-line string (`src-tauri/src/db/mod.rs:4623`), because the enclosing region spans it.
  const source =
    'fn production() {}\n\n#[cfg(test)]\nfn hidden() {\n    let pgn = "[Event \\"E\\"]\n\n1. e4 *";\n\n    drop(pgn);\n}\n\nfn after() {}\n';
  const { result } = await scanRustFixture({ "src-tauri/src/lib.rs": source });
  assert.deepEqual(
    [...result.excludedLines.get("src-tauri/src/lib.rs")].sort((a, b) => a - b),
    [3, 4, 5, 6, 7, 8, 9, 10],
  );
});

test("LCOV filtering drops excluded DA, FN, paired FNDA, and BRDA records", () => {
  const input = `TN:\nSF:src-tauri/src/lib.rs\nFN:1,duplicate\nFN:2,duplicate\nFNDA:1,duplicate\nFNDA:0,duplicate\nDA:1,1\nDA:2,0\nBRDA:1,0,0,1\nBRDA:2,0,0,0\nend_of_record\n`;
  const [record] = parseLcov(
    input,
    (file) => file,
    (_file, line) => line !== 2,
  );
  assert.deepEqual(record.metrics, {
    lines: { covered: 1, total: 1 },
    functions: { covered: 1, total: 1 },
    branches: { covered: 1, total: 1 },
  });
});

test("filtered Rust measurement drives buildCoverageReport and the CLI ratchet", async () => {
  const config = rustConfig({ exclude: ["src-tauri/src/lib.rs"] });
  const files = {
    "src-tauri/src/lib.rs": "#[cfg(test)]\nmod support;\nfn excluded_by_config() {}\n",
    "src-tauri/src/support.rs": "pub fn test_support() {}\n",
    "src-tauri/src/production.rs":
      "pub fn before() {}\n#[cfg(test)]\npub fn hidden() {}\npub fn after() {}\n",
  };
  const { root } = await fixture({ files });
  const lcov = `TN:\nSF:src-tauri/src/production.rs\nFN:1,before\nFN:3,hidden\nFN:4,after\nFNDA:1,before\nFNDA:0,hidden\nFNDA:1,after\nDA:1,1\nDA:3,0\nDA:4,1\nBRDA:1,0,0,1\nBRDA:3,0,0,0\nBRDA:4,0,0,1\nend_of_record\n`;
  const report = await buildCoverageReport({
    config,
    configPath: "backend-coverage-areas.json",
    lcov,
    root,
  });
  assert.deepEqual(report["backend-area"], {
    lines: { covered: 2, total: 2 },
    functions: { covered: 2, total: 2 },
    branches: { covered: 2, total: 2 },
  });
  const baseline = {
    version: 1,
    scope: scopeSignature(config),
    areas: report,
  };
  const result = await runCoverageCli(root, {
    config,
    lcov,
    baselineContents: JSON.stringify(baseline),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Coverage ratchet and area floors passed/);
});

test("Rust exclusion failures are staged through the CLI with path, line, and exit status", async (t) => {
  const cases = [
    {
      name: "invalid exclusion config",
      files: { "src-tauri/src/lib.rs": "pub fn production() {}\n" },
      config: (() => {
        const invalid = rustConfig();
        invalid.sources[0].excludeTestOnlyItems = { reason: "  " };
        return invalid;
      })(),
      expected:
        "Coverage source backend excludeTestOnlyItems must be an object with a non-empty reason string",
    },
    {
      name: "non-Rust included file",
      files: {
        "src-tauri/src/lib.rs": "pub fn production() {}\n",
        "src-tauri/src/config.ts": "export {};\n",
      },
      config: rustConfig({ include: ["src-tauri/src/**/*"] }),
      expected: "src-tauri/src/config.ts:1: excludeTestOnlyItems can scan only .rs files",
    },
    {
      name: "unbalanced delimiter at EOF",
      files: { "src-tauri/src/lib.rs": "#[cfg(test)]\nfn hidden() {\n" },
      expected: "src-tauri/src/lib.rs:2: unbalanced delimiter at end of file",
    },
    {
      name: "unparseable cfg",
      files: { "src-tauri/src/lib.rs": "#[cfg(not(test, unix))]\nfn hidden() {}\n" },
      expected:
        "src-tauri/src/lib.rs:1: unparseable cfg predicate (not() requires one cfg predicate)",
    },
    {
      name: "unparseable cfg_attr",
      files: { "src-tauri/src/lib.rs": "#[cfg_attr(test)]\nfn hidden() {}\n" },
      expected:
        "src-tauri/src/lib.rs:1: unparseable cfg_attr predicate (expected a condition and attribute)",
    },
    {
      name: "unrecognised braced macro expression form",
      files: {
        "src-tauri/src/lib.rs":
          "fn enclosing() {\n  let value =\n    #[cfg(test)]\n    fixture! { 1 }?;\n}\n",
      },
      expected:
        "src-tauri/src/lib.rs:4: unsupported test-only form; give it its own item/statement or extend rust-test-only.mjs",
    },
    {
      name: "braced macro statement followed by .await",
      files: {
        "src-tauri/src/lib.rs":
          "fn enclosing() {\n  #[cfg(test)]\n  fixture! { true }\n  .await;\n}\n",
      },
      expected:
        "src-tauri/src/lib.rs:4: unsupported test-only form; give it its own item/statement or extend rust-test-only.mjs",
    },
    {
      name: "braced macro statement followed by a method call",
      files: {
        "src-tauri/src/lib.rs":
          "fn enclosing() {\n  #[cfg(test)]\n  fixture! { true }\n  .method();\n}\n",
      },
      expected:
        "src-tauri/src/lib.rs:4: unsupported test-only form; give it its own item/statement or extend rust-test-only.mjs",
    },
    {
      name: "braced macro statement followed by as",
      files: {
        "src-tauri/src/lib.rs":
          "fn enclosing() {\n  #[cfg(test)]\n  fixture! { true }\n  as bool;\n}\n",
      },
      expected:
        "src-tauri/src/lib.rs:4: unsupported test-only form; give it its own item/statement or extend rust-test-only.mjs",
    },
    {
      name: "if/else statement followed by try operator",
      files: {
        "src-tauri/src/lib.rs":
          "fn enclosing(value: bool) {\n  #[cfg(test)]\n  if value { one(); } else { two(); }\n  ?;\n}\n",
      },
      expected:
        "src-tauri/src/lib.rs:4: unsupported test-only form; give it its own item/statement or extend rust-test-only.mjs",
    },
    {
      name: "unplaceable try-block context",
      files: {
        "src-tauri/src/lib.rs":
          "fn enclosing() {\n  let value = try {\n    #[cfg(test)]\n    let hidden = true;\n    hidden\n  };\n}\n",
      },
      expected:
        "src-tauri/src/lib.rs:3: unplaceable test-only context; extend rust-test-only.mjs only for a listed Rust form",
    },
    {
      name: "statement without a terminator",
      files: {
        "src-tauri/src/lib.rs": "fn enclosing() {\n  #[cfg(test)]\n  let hidden = true\n}\n",
      },
      expected:
        "src-tauri/src/lib.rs:3: test-only statement reaches its enclosing } without a terminator",
    },
    {
      name: "shared line with production call",
      files: { "src-tauri/src/lib.rs": "#[cfg(test)] fn hidden() {} fn production() {}\n" },
      expected:
        "src-tauri/src/lib.rs:1: shared coverage line; give the test-only item its own lines",
    },
    {
      name: "shared line with production string literal",
      files: {
        "src-tauri/src/lib.rs": '#[cfg(test)] fn hidden() {} const VALUE: &str = "production";\n',
      },
      expected:
        "src-tauri/src/lib.rs:1: shared coverage line; give the test-only item its own lines",
    },
    {
      name: "nested module declaration inside test-only inline module",
      files: { "src-tauri/src/lib.rs": "#[cfg(test)] mod outer { mod inner; }\n" },
      expected:
        "src-tauri/src/lib.rs:1: unsupported test-only module declaration inside an inline module",
    },
    {
      name: "path attribute on test-only module",
      files: { "src-tauri/src/lib.rs": '#[path = "helper.rs"]\n#[cfg(test)]\nmod helper;\n' },
      expected: "src-tauri/src/lib.rs:3: unsupported #[path] on a test-only module declaration",
    },
    {
      name: "path attribute through cfg_attr on test-only module",
      files: {
        "src-tauri/src/lib.rs":
          '#[cfg_attr(test, path = "helpers/test.rs")]\n#[cfg(test)]\nmod helpers;\n',
      },
      expected: "src-tauri/src/lib.rs:3: unsupported #[path] on a test-only module declaration",
    },
    {
      name: "nested path attribute through cfg_attr on test-only module",
      files: {
        "src-tauri/src/lib.rs":
          '#[cfg_attr(test, cfg_attr(unix, path = "helpers/test.rs"))]\n#[cfg(test)]\nmod helpers;\n',
      },
      expected: "src-tauri/src/lib.rs:3: unsupported #[path] on a test-only module declaration",
    },
    {
      name: "unresolved test-only module",
      files: { "src-tauri/src/lib.rs": "#[cfg(test)]\nmod missing;\n" },
      expected: "src-tauri/src/lib.rs:2: cannot resolve test-only module missing",
    },
    {
      name: "ambiguous test-only module layouts",
      files: {
        "src-tauri/src/lib.rs": "#[cfg(test)]\nmod helper;\n",
        "src-tauri/src/helper.rs": "pub fn one() {}\n",
        "src-tauri/src/helper/mod.rs": "pub fn two() {}\n",
      },
      expected:
        "src-tauri/src/lib.rs:2: ambiguous test-only module helper: src-tauri/src/helper.rs, src-tauri/src/helper/mod.rs",
    },
    {
      name: "test-only attribute inside an unrelated macro input",
      files: {
        "src-tauri/src/lib.rs":
          "other_macro! {\n  #[cfg(test)]\n  static HIDDEN: bool = true;\n}\n",
      },
      expected: "src-tauri/src/lib.rs:2: unsupported test-only context inside a macro input",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { root } = await fixture({ files: entry.files });
      const result = await runCoverageCli(root, {
        config: entry.config ?? rustConfig(),
        lcov: "",
      });
      assert.equal(result.status, 1, result.stdout);
      assert.ok(result.stderr.includes(entry.expected), result.stderr);
    });
  }

  await t.test("unreadable included Rust file", async (t) => {
    const { root } = await fixture({
      files: {
        "src-tauri/src/lib.rs": "pub fn production() {}\n",
        "src-tauri/src/unreadable.rs": "pub fn unreadable() {}\n",
      },
    });
    await chmod(root, 0o755);
    await chmod(join(root, "src-tauri"), 0o755);
    await chmod(join(root, "src-tauri/src"), 0o755);
    t.after(() => chmod(join(root, "src-tauri/src/unreadable.rs"), 0o600));
    await chmod(join(root, "src-tauri/src/unreadable.rs"), 0);
    const result = await runCoverageCli(root, {
      config: rustConfig(),
      lcov: "",
      ...(process.getuid() === 0 ? { uid: 65534 } : {}),
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(
      result.stderr,
      /src-tauri\/src\/unreadable\.rs:1: unable to read Rust source: EACCES:/,
    );
  });
});

test(
  "test-only module resolution reports unreadable candidate directories",
  { skip: process.getuid?.() === 0 },
  async () => {
    const { root } = await fixture({
      files: { "src-tauri/src/parent.rs": "#[cfg(test)]\nmod helpers;\n" },
    });
    const candidateDirectory = join(root, "src-tauri/src/parent");
    await mkdir(candidateDirectory);
    await chmod(candidateDirectory, 0);
    try {
      await assert.rejects(
        scanRustTestOnly({
          root,
          source: rustConfig().sources[0],
          files: ["src-tauri/src/parent.rs"],
        }),
        (error) => {
          assert.match(error.message, /src-tauri\/src\/parent\.rs:2:/);
          assert.match(error.message, /EACCES: permission denied/);
          return true;
        },
      );
    } finally {
      await chmod(candidateDirectory, 0o755);
    }
  },
);

const OXFMT_SCRIPTS = {
  success: "#!/bin/sh\nexit 0\n",
  "non-zero": "#!/bin/sh\nprintf '%s' 'formatter rejected the temporary baseline' >&2\nexit 23\n",
  // A formatter killed by a signal leaves `status` null, which `status !== 0` still catches.
  // Without this fixture a regression to `status > 0` would report the kill as a success.
  signal: "#!/bin/sh\nkill -TERM $$\n",
};

async function installOxfmt(root, script) {
  await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
  await writeFile(join(root, "node_modules", ".bin", "oxfmt"), OXFMT_SCRIPTS[script], {
    mode: 0o755,
  });
}

function blankLcov(file) {
  return lcovRecord(file);
}

function cliConfig(statementFree = []) {
  return {
    version: 1,
    sources: [
      {
        id: "frontend",
        root: "src",
        include: ["src/**/*.ts"],
        exclude: [],
        ...(statementFree.length > 0 ? { statementFree } : {}),
      },
    ],
    areas: [
      {
        id: "utilities",
        source: "frontend",
        minimumCoverage: { lines: 0, functions: 0, branches: 0 },
        paths: ["src/utils/**"],
      },
    ],
  };
}

async function runCoverageCli(
  root,
  {
    config,
    lcov,
    writeBaseline = false,
    baselineContents,
    baselinePath = writeBaseline ? "scratch-baseline.json" : "baseline.json",
    instrumentChange,
    finding,
    extraArgs = [],
    extraEnv,
    uid,
  },
) {
  await writeFile(join(root, "config.json"), JSON.stringify(config));
  await writeFile(join(root, "lcov.info"), lcov);
  if (baselineContents !== undefined) {
    const path = join(root, baselinePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, baselineContents);
  } else if (!writeBaseline) {
    await writeFile(join(root, "baseline.json"), JSON.stringify({ version: 1 }));
  }
  const authorizationArgs = [
    ...(instrumentChange ? ["--instrument-change", instrumentChange] : []),
    ...(finding ? ["--finding", finding] : []),
  ];
  return spawnSync(
    process.execPath,
    [
      join(process.cwd(), "scripts", "coverage-report.mjs"),
      "--config",
      "config.json",
      "--baseline",
      baselinePath,
      "--lcov",
      "lcov.info",
      ...(writeBaseline ? ["--write-baseline"] : []),
      ...authorizationArgs,
      ...extraArgs,
    ],
    {
      cwd: root,
      encoding: "utf8",
      ...(uid === undefined ? {} : { uid, gid: uid }),
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    },
  );
}

async function runMappingOnlyCli(
  root,
  { config, files = {}, baselineScope = scopeSignature(config), extraArgs = [] },
) {
  await writeFile(join(root, "mapping-config.json"), JSON.stringify(config));
  await writeFile(
    join(root, "mapping-baseline.json"),
    JSON.stringify({ version: 1, scope: baselineScope, areas: {} }),
  );
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  return spawnSync(
    process.execPath,
    [
      join(process.cwd(), "scripts", "coverage-report.mjs"),
      "--config",
      "mapping-config.json",
      "--baseline",
      "mapping-baseline.json",
      "--mapping-only",
      ...extraArgs,
    ],
    { cwd: root, encoding: "utf8" },
  );
}

function mappingFixtureConfig({ areas = undefined, statementFree = [] } = {}) {
  return {
    version: 1,
    sources: [
      {
        id: "frontend",
        root: "src",
        include: ["src/**/*.ts"],
        exclude: [],
        statementFree,
      },
    ],
    areas: areas ?? [{ id: "utilities", source: "frontend", paths: ["src/utils/**"] }],
  };
}

test("mapping-only CLI rejects each invalid mapping and stale baseline scope", async (t) => {
  const production = { "src/utils/example.ts": "export const example = 1;\n" };
  const cases = [
    {
      name: "unmapped production file",
      config: mappingFixtureConfig({
        areas: [{ id: "elsewhere", source: "frontend", paths: ["src/elsewhere/**"] }],
      }),
      expected: /Unmapped production file: src\/utils\/example\.ts/u,
    },
    {
      name: "two areas claim one production file",
      config: mappingFixtureConfig({
        areas: [
          { id: "utilities", source: "frontend", paths: ["src/utils/**"] },
          { id: "duplicate", source: "frontend", paths: ["src/**"] },
        ],
      }),
      expected: /belongs to multiple coverage areas/u,
    },
    {
      name: "area claims the wrong source",
      config: mappingFixtureConfig({
        areas: [{ id: "utilities", source: "backend", paths: ["src/utils/**"] }],
      }),
      expected: /has the wrong source for src\/utils\/example\.ts/u,
    },
    {
      name: "area claims no production file",
      config: mappingFixtureConfig({
        areas: [
          { id: "utilities", source: "frontend", paths: ["src/utils/**"] },
          { id: "empty", source: "frontend", paths: ["src/empty/**"] },
        ],
      }),
      expected: /Coverage areas claim no production files: empty/u,
    },
    {
      name: "statementFree lies outside measured production files",
      config: mappingFixtureConfig({
        statementFree: [{ path: "src/gone.ts", reason: "No executable statements." }],
      }),
      expected:
        /statementFree declarations are outside the measured production set: src\/gone\.ts/u,
    },
    {
      name: "baseline records a different scope",
      config: mappingFixtureConfig(),
      baselineScope: { sources: [], areas: [] },
      expected: /Coverage measurement scope changed/u,
    },
    {
      name: "mapping-only rejects LCOV arguments",
      config: mappingFixtureConfig(),
      extraArgs: ["--lcov", "missing.info"],
      expected: /--mapping-only cannot be combined with --lcov/u,
    },
    {
      name: "mapping-only rejects baseline writes",
      config: mappingFixtureConfig(),
      extraArgs: ["--write-baseline"],
      expected: /--mapping-only cannot be combined with --write-baseline/u,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const scratch = await mkdtemp(join(tmpdir(), "coverage-mapping-case-"));
      subtest.after(() => rm(scratch, { recursive: true, force: true }));
      const result = await runMappingOnlyCli(scratch, {
        config: entry.config,
        files: production,
        baselineScope: entry.baselineScope ?? scopeSignature(entry.config),
        extraArgs: entry.extraArgs ?? [],
      });
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, entry.expected);
    });
  }
});

test("mapping-only mode passes against both real coverage configurations", async (t) => {
  const root = process.cwd();
  for (const [configPath, baselinePath] of [
    ["coverage-areas.json", "coverage-baselines.json"],
    ["backend-coverage-areas.json", "backend-coverage-baselines.json"],
  ]) {
    await t.test(configPath, () => {
      const result = spawnSync(
        process.execPath,
        [
          join(root, "scripts", "coverage-report.mjs"),
          "--config",
          configPath,
          "--baseline",
          baselinePath,
          "--mapping-only",
        ],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        /Coverage mapping passed: \d+ production files across \d+ areas/u,
      );
    });
  }
});

function writerConfig({ twoAreas = false, exclude = [] } = {}) {
  return {
    version: 1,
    sources: [
      {
        id: "frontend",
        root: "src",
        include: ["src/**/*.ts"],
        exclude,
      },
    ],
    areas: [
      {
        id: "utilities",
        source: "frontend",
        paths: ["src/utils/**"],
      },
      ...(twoAreas
        ? [
            {
              id: "puzzles",
              source: "frontend",
              paths: ["src/puzzles/**"],
            },
          ]
        : []),
    ],
  };
}

function coverageLcov(file, values) {
  const records = ["TN:", `SF:${file}`];
  for (let index = 1; index <= values.functions.total; index += 1) {
    const name = `function${index}`;
    records.push(
      `FN:${index},${name}`,
      `FNDA:${index <= values.functions.covered ? 1 : 0},${name}`,
    );
  }
  for (let index = 1; index <= values.lines.total; index += 1) {
    records.push(`DA:${index},${index <= values.lines.covered ? 1 : 0}`);
  }
  for (let index = 1; index <= values.branches.total; index += 1) {
    records.push(`BRDA:${index},0,${index},${index <= values.branches.covered ? 1 : 0}`);
  }
  records.push("end_of_record", "");
  return records.join("\n");
}

function writerLcov(areaMetrics) {
  return Object.entries(areaMetrics)
    .map(([area, values]) =>
      coverageLcov(`src/${area === "utilities" ? "utils" : area}/example.ts`, values),
    )
    .join("\n");
}

function baselineMetrics(lines, functions, branches) {
  return { lines, functions, branches };
}

function baselineFor(config, areas) {
  return { version: 1, scope: scopeSignature(config), areas };
}

async function writeFixtureFiles(root, files) {
  for (const [path, contents] of Object.entries(files)) {
    const absolutePath = join(root, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
  }
}

async function writeFixtureDecision(
  root,
  { decision = "d-20260927-23", governs = "f-20260829-04" } = {},
) {
  const decisionsPath = join(root, "tasks", "decisions.md");
  await mkdir(dirname(decisionsPath), { recursive: true });
  await writeFile(
    decisionsPath,
    `### ${decision} — Fixture decision\n\n* **Governs:** ${governs}\n`,
  );
}

async function assertScratchBaselineUnchanged(
  root,
  expected,
  baselinePath = "scratch-baseline.json",
) {
  assert.deepEqual(await readFile(join(root, baselinePath)), Buffer.from(expected));
}

function assertDeltaLines(output, areas) {
  for (const area of areas) {
    for (const metric of ["lines", "functions", "branches"]) {
      assert.match(output, new RegExp(`Coverage baseline delta: ${area} ${metric}:`));
    }
  }
}

async function findExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through PATH until the executable is found.
    }
  }
  throw new Error(`Could not find ${name} on PATH`);
}

async function gitInScratch(root, args, input = "") {
  const result = spawnSync("git", args, { cwd: root, input, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function createScratchHead(root, trackedFiles = {}) {
  await gitInScratch(root, ["init", "--quiet"]);
  const entries = [];
  for (const [path, contents] of Object.entries(trackedFiles)) {
    await writeFixtureFiles(root, { [path]: contents });
    const blob = await gitInScratch(root, ["hash-object", "-w", "--stdin"], contents);
    entries.push(`100644 blob ${blob}\t${path}\n`);
  }
  const tree = await gitInScratch(root, ["mktree"], entries.join(""));
  const commit = await gitInScratch(
    root,
    ["hash-object", "-t", "commit", "-w", "--stdin"],
    `tree ${tree}\nauthor Fixture <fixture@example.test> 0 +0000\ncommitter Fixture <fixture@example.test> 0 +0000\n\ncoverage writer fixture\n`,
  );
  await gitInScratch(root, ["update-ref", "refs/heads/fixture", commit]);
  await gitInScratch(root, ["symbolic-ref", "HEAD", "refs/heads/fixture"]);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function installGitShim(
  root,
  { command, status = 37, stdout = "", stderr = "fatal: simulated git failure" },
) {
  const realGit = await findExecutable("git");
  const shimDirectory = join(root, "git-shim");
  await mkdir(shimDirectory, { recursive: true });
  await writeFile(
    join(shimDirectory, "git"),
    `#!/bin/sh\nif [ "$1" = ${shellQuote(command)} ]; then\n  printf '%s' ${shellQuote(stdout)}\n  if [ -n ${shellQuote(stderr)} ]; then printf '%s\\n' ${shellQuote(stderr)} >&2; fi\n  exit ${status}\nfi\nexec ${shellQuote(realGit)} "$@"\n`,
    { mode: 0o755 },
  );
  return `${shimDirectory}${delimiter}${process.env.PATH}`;
}

async function coverageWriterFixture({ config = writerConfig(), records, files = {}, baseline }) {
  const { root } = await fixture();
  await writeFixtureFiles(root, files);
  return {
    root,
    config,
    lcov: records,
    baselineContents:
      baseline === undefined
        ? undefined
        : typeof baseline === "string"
          ? baseline
          : JSON.stringify(baseline),
  };
}

test("parses LCOV line, function, and branch totals", () => {
  assert.deepEqual(parseLcov(lcov), [
    {
      file: "src/utils/example.ts",
      metrics: {
        lines: { covered: 1, total: 2 },
        functions: { covered: 1, total: 1 },
        branches: { covered: 1, total: 2 },
      },
    },
  ]);
});

test("merges repeated source inputs by exact counter identity", () => {
  assert.deepEqual(parseLcov(`${lcov}${lcov}`), parseLcov(lcov));
});

test("matches same-named function data by declaration occurrence", () => {
  assert.deepEqual(parseLcov(duplicateFunctionLcov)[0].metrics.functions, {
    covered: 1,
    total: 2,
  });
});

test("assigns mapped files and rejects unmapped files", () => {
  assert.equal(assignArea("src/utils/example.ts", config).id, "utilities");
  assert.equal(assignArea("src/utils/chess/example.ts", config).id, "utilities");
  assert.throws(() => assignArea("src/other.ts", config), /Unmapped production file/);
});

test("preserves zero coverage as totals rather than dropping it", async () => {
  const { root } = await fixture();
  const report = await buildCoverageReport({
    config,
    configPath: "coverage-areas.json",
    lcov: lcov
      .replace("FNDA:1", "FNDA:0")
      .replace("DA:1,1", "DA:1,0")
      .replace("BRDA:1,0,0,1", "BRDA:1,0,0,0"),
    root,
  });
  assert.deepEqual(report.utilities, {
    lines: { covered: 0, total: 2 },
    functions: { covered: 0, total: 1 },
    branches: { covered: 0, total: 2 },
  });
});

test("rejects a blank measurement for an undeclared production file", async () => {
  const blankFile = "src/utils/blank.ts";
  const { root } = await fixture({ files: { [blankFile]: "export type Blank = string;\n" } });
  await assert.rejects(
    () =>
      buildCoverageReport({
        config,
        configPath: "coverage-areas.json",
        lcov: `${lcov}${blankLcov(blankFile)}`,
        root,
      }),
    (error) => {
      assert.equal(
        error.message,
        "Coverage measurement is blank for production files: src/utils/blank.ts. " +
          "A file present in the LCOV with no line, function or branch records has left the denominator without changing any percentage. " +
          "If the file genuinely has no statements, declare it under statementFree in coverage-areas.json; otherwise something removed it from the measurement (see docs/coverage.md).",
      );
      return true;
    },
  );
});

test("names two blank undeclared production files in stable order", async () => {
  const blankFiles = ["src/utils/blank-b.ts", "src/utils/blank-a.ts"];
  const { root } = await fixture({
    files: Object.fromEntries(blankFiles.map((file) => [file, "export type Blank = string;\n"])),
  });
  await assert.rejects(
    () =>
      buildCoverageReport({
        config,
        configPath: "coverage-areas.json",
        lcov: `${lcov}${blankLcov(blankFiles[0])}${blankLcov(blankFiles[1])}`,
        root,
      }),
    /Coverage measurement is blank for production files: src\/utils\/blank-a\.ts, src\/utils\/blank-b\.ts\./,
  );
});

test("accepts a declared blank without changing area metrics", async () => {
  const blankFile = "src/utils/blank.ts";
  const { root } = await fixture({ files: { [blankFile]: "export type Blank = string;\n" } });
  // O2 residual limitation: a declared file that gains statements and is raw-imported stays blank and is not caught.
  const report = await buildCoverageReport({
    config: withStatementFree([blankFile]),
    configPath: "coverage-areas.json",
    lcov: `${lcov}${blankLcov(blankFile)}`,
    root,
  });
  assert.deepEqual(report, {
    utilities: {
      lines: { covered: 1, total: 2 },
      functions: { covered: 1, total: 1 },
      branches: { covered: 1, total: 2 },
    },
  });
});

test("unions records for one file reached through two SF spellings", async () => {
  // Both spellings occur for real: `llvm-cov` writes absolute paths, `@vitest/coverage-v8`
  // repo-relative ones, and several LCOV files may be joined in one run. The two records must be
  // merged by counter identity, exactly as two identical spellings already are -- summing them
  // would double every total, and keeping only one of them would drop the counters only the other
  // carries. The two records below are deliberately *disjoint*, so neither failure passes.
  const { root } = await fixture();
  const absolute = `TN:\nSF:${join(root, "src/utils/example.ts")}\nFN:1,example\nFNDA:1,example\nDA:1,1\nBRDA:1,0,0,1\nend_of_record\n`;
  const relative = `TN:\nSF:src/utils/example.ts\nDA:2,0\nBRDA:1,0,1,0\nend_of_record\n`;
  const measured = {
    lines: { covered: 1, total: 2 },
    functions: { covered: 1, total: 1 },
    branches: { covered: 1, total: 2 },
  };
  const united = await buildCoverageReport({
    config,
    configPath: "coverage-areas.json",
    lcov: `${absolute}${relative}`,
    root,
  });
  assert.deepEqual(united.utilities, measured);
  // And a blank record for the other spelling neither hides the covered one nor is mistaken for
  // a blank measurement of the file.
  const withBlank = await buildCoverageReport({
    config,
    configPath: "coverage-areas.json",
    lcov: `${absolute}${relative}${blankLcov("src/utils/example.ts")}`,
    root,
  });
  assert.deepEqual(withBlank.utilities, measured);
});

test("counts two same-named functions declared on one line as two", () => {
  // The per-declaration index exists only for this case -- a name and a line shared by two
  // declarations. Dropping it collapses them into one identity and reports one function where
  // there are two, which no other fixture notices because every other one uses distinct lines.
  const declarations = parseLcov(
    "TN:\nSF:a.ts\nFN:1,f\nFN:1,f\nFNDA:1,f\nFNDA:0,f\nend_of_record\n",
  );
  assert.deepEqual(declarations[0].metrics.functions, { covered: 1, total: 2 });
});

test("keeps opaque function names and DA checksums distinct across merged records", () => {
  // Integer fields are canonical now. Free-text names and checksums still accept separator
  // characters, and JSON encoding must preserve them when records for one file are merged.
  const record = (counters) => `TN:\nSF:a.ts\n${counters}\nend_of_record\n`;
  for (const text of ["f:g", "a\u0000b", 'quote"', "back\\slash", " name "]) {
    const first = `FN:1,${text}\nFNDA:1,${text}\nDA:1,1,${text}`;
    const second = `FN:1,${text}:0\nFNDA:0,${text}:0\nDA:1,0,${text}:0`;
    const [merged] = parseLcov(`${record(first)}${record(second)}${record(first)}`);
    assert.deepEqual(merged.metrics.functions, { covered: 1, total: 2 }, text);
    assert.deepEqual(merged.metrics.lines, { covered: 1, total: 2 }, text);
  }
});

function malformedCounterCase(row, reason, raw, earlier = "") {
  const sf = "src/utils/example.ts";
  return {
    row,
    reason,
    raw,
    sf,
    line: earlier ? 3 : 2,
    input: `SF:${sf}\n${earlier ? `${earlier}\n` : ""}${raw}\nend_of_record\n`,
  };
}

// One fixture per new failure-matrix row. Field-count fixtures keep every present field valid.
const malformedLcovCases = [
  malformedCounterCase(93, "DA requires 2 or 3 fields", "DA:1"),
  malformedCounterCase(94, "DA line must be a canonical decimal >= 1", "DA:bogus,1"),
  malformedCounterCase(95, "DA hits must be a canonical decimal", "DA:1,bogus"),
  malformedCounterCase(96, "DA checksum must be non-empty when present", "DA:1,1,"),
  malformedCounterCase(97, "FN requires 2 fields", "FN:10,20,f"),
  malformedCounterCase(98, "FN line must be a canonical decimal >= 1", "FN:0,f"),
  malformedCounterCase(99, "FN name must be non-empty", "FN:1,"),
  malformedCounterCase(100, "FNDA requires 2 fields", "FNDA:1,f,extra", "FN:1,f"),
  malformedCounterCase(101, "FNDA hits must be a canonical decimal", "FNDA:x,f", "FN:1,f"),
  malformedCounterCase(102, "FNDA name must be non-empty", "FNDA:1,", "FN:1,f"),
  malformedCounterCase(103, "BRDA requires 4 fields", "BRDA:1,0,0"),
  malformedCounterCase(104, "BRDA line must be a canonical decimal >= 1", "BRDA:0,0,0,1"),
  malformedCounterCase(105, "BRDA block must be a canonical decimal", "BRDA:1,e0,0,1"),
  malformedCounterCase(106, "BRDA branch must be a canonical decimal", "BRDA:1,0,expression,1"),
  malformedCounterCase(107, "BRDA taken must be a canonical decimal or -", "BRDA:1,0,0,x"),
  { row: 108, reason: "SF path is empty", raw: "SF:", line: 1, input: "SF:\nend_of_record\n" },
  {
    row: 109,
    reason: "SF before end_of_record",
    raw: "SF:other.ts",
    sf: "src/utils/example.ts",
    line: 2,
    input: "SF:src/utils/example.ts\nSF:other.ts\nend_of_record\n",
  },
  {
    row: 110,
    reason: "counter without an open record",
    raw: "DA:1,1",
    line: 2,
    input: "TN:\nDA:1,1\n",
  },
  {
    row: 111,
    reason: "end_of_record without an open record",
    raw: "end_of_record",
    line: 1,
    input: "end_of_record\n",
  },
  {
    row: 112,
    reason: "open record for SF",
    sf: "src/utils/example.ts",
    input: "SF:src/utils/example.ts\nDA:1,1\n",
  },
  {
    row: 113,
    reason: "FNDA has no earlier matching FN",
    raw: "FNDA:1,f",
    sf: "src/utils/example.ts",
    line: 5,
    input:
      "SF:src/utils/example.ts\nFN:1,f\nend_of_record\nSF:src/utils/example.ts\nFNDA:1,f\nend_of_record\n",
  },
];

// These stage rows 93/97/100/103 in the other field-count direction and are not CLI-staged because those rows already are.
const oppositeFieldCountCases = [
  malformedCounterCase(93, "DA requires 2 or 3 fields", "DA:1,1,checksum,extra"),
  malformedCounterCase(97, "FN requires 2 fields", "FN:1"),
  malformedCounterCase(100, "FNDA requires 2 fields", "FNDA:1", "FN:1,f"),
  malformedCounterCase(103, "BRDA requires 4 fields", "BRDA:1,0,0,1,extra"),
];

function malformedMessage(entry) {
  if (entry.line === undefined) {
    return `Malformed LCOV at end of input: ${entry.reason} ${JSON.stringify(entry.sf)}`;
  }
  const record = entry.sf === undefined ? "" : ` in SF ${JSON.stringify(entry.sf)}`;
  return `Malformed LCOV at line ${entry.line}${record}: ${entry.reason}: ${JSON.stringify(entry.raw)}`;
}

test("parseLcov rejects each malformed-input rule with its complete diagnostic", async (t) => {
  for (const entry of [...malformedLcovCases, ...oppositeFieldCountCases]) {
    await t.test(`row ${entry.row}: ${entry.reason}`, () => {
      assert.throws(() => parseLcov(entry.input), {
        name: "Error",
        message: malformedMessage(entry),
      });
    });
  }
});

test("every malformed-input matrix row is staged through the CLI", async (t) => {
  const config = cliConfig();
  const baselineContents = JSON.stringify(
    baselineFor(config, { utilities: metrics("lines", 1, 2) }),
  );
  for (const entry of malformedLcovCases) {
    await t.test(`row ${entry.row}: ${entry.reason}`, async (t) => {
      const { root } = await fixture();
      t.after(() => rm(root, { recursive: true, force: true }));
      const result = await runCoverageCli(root, { config, lcov: entry.input, baselineContents });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `${malformedMessage(entry)}\n`);
      t.diagnostic(`staged row ${entry.row}: exit 1, ${result.stderr.trim()}`);
    });
  }
});

test("malformed LCOV refuses a baseline write before touching its bytes", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = malformedLcovCases.find(({ row }) => row === 95);
  const config = cliConfig();
  const baselineContents = JSON.stringify(
    baselineFor(config, { utilities: metrics("lines", 1, 2) }),
  );
  const result = await runCoverageCli(root, {
    config,
    lcov: entry.input,
    baselineContents,
    writeBaseline: true,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${malformedMessage(entry)}\n`);
  await assertScratchBaselineUnchanged(root, baselineContents);
});

test("canonical-decimal grammar rejects coercible numbers and damaged integer separators", () => {
  const invalid = [
    "",
    "01",
    " 1",
    "1 ",
    "+1",
    "-1",
    "1.0",
    "1e2",
    "NaN",
    "Infinity",
    "1\u0000a",
    "1:f",
  ];
  const fields = [
    ["DA line", (value) => `DA:${value},1`],
    ["DA hits", (value) => `DA:1,${value}`],
    ["FN line", (value) => `FN:${value},f`],
    ["FNDA hits", (value) => `FNDA:${value},f`],
    ["BRDA line", (value) => `BRDA:${value},0,0,1`],
    ["BRDA block", (value) => `BRDA:1,${value},0,1`],
    ["BRDA branch", (value) => `BRDA:1,0,${value},1`],
    ["BRDA taken", (value) => `BRDA:1,0,0,${value}`],
  ];
  for (const [field, counter] of fields) {
    for (const value of invalid) {
      assert.throws(
        () => parseLcov(`SF:a.ts\nFN:1,f\n${counter(value)}\nend_of_record\n`),
        (error) =>
          error.message.startsWith("Malformed LCOV") && error.message.includes(`${field} must be`),
        `${field}: ${JSON.stringify(value)}`,
      );
    }
  }
  for (const raw of ["DA:0,1", "FN:0,f", "BRDA:0,0,0,1"]) {
    assert.throws(() => parseLcov(`SF:a.ts\n${raw}\nend_of_record`), /canonical decimal >= 1/);
  }
  // These integer-field separator cases belonged to the former identity-injectivity fixture.
  for (const raw of [
    "FN:1:f,g",
    "FN:1\u0000a,b",
    "DA:1\u0000a,0,b",
    "BRDA:1\u00000,a,b,0",
    "BRDA:1,0,a\u0000b,1",
  ]) {
    assert.throws(() => parseLcov(`SF:a.ts\n${raw}\nend_of_record`), /Malformed LCOV/);
  }
});

test("validation precedes exclusions for every counter kind and paired FNDA", () => {
  for (const row of [94, 95, 98, 101, 105, 113]) {
    const entry = malformedLcovCases.find((entry) => entry.row === row);
    assert.throws(
      () =>
        parseLcov(
          entry.input,
          (file) => file,
          () => false,
        ),
      { message: malformedMessage(entry) },
    );
  }
});

test("record diagnostics preserve raw SF and line text and stop at the first violation", () => {
  const sf = 'raw\\path"\u0000.ts';
  const raw = 'DA:1,x,"\u0000';
  assert.throws(
    () =>
      parseLcov(`TN:\r\n\r\nSF:${sf}\r\n${raw}\r\nFN:0,f\r\nend_of_record`, () => "normalised.ts"),
    {
      message: malformedMessage({
        line: 4,
        sf,
        raw,
        reason: "DA hits must be a canonical decimal",
      }),
    },
  );
  for (const raw of ["DA:1,1", "FN:1,f", "FNDA:1,f", "BRDA:1,0,0,1"]) {
    assert.throws(() => parseLcov(raw), /counter without an open record/);
  }
  assert.throws(
    () => parseLcov("SF:a.ts\nFNDA:1,f\nFN:1,f\nend_of_record"),
    /FNDA has no earlier matching FN/,
  );
  assert.throws(
    () => parseLcov("SF:a.ts\nFN:1,f\nFNDA:0,f\nFNDA:1,f\nend_of_record"),
    /FNDA has no earlier matching FN/,
  );
});

test("accepts producer forms, ignored keys, checksums and maximum-hit merging unchanged", () => {
  const input = [
    "TN:",
    "VER:future",
    "unknown:ignored",
    "",
    "SF:a.ts",
    "FN:1,declared-only",
    "DA:1,0",
    "DA:1,2",
    "DA:2,0,opaque:checksum",
    "BRDA:1,0,0,-",
    "BRDA:1,0,0,3",
    "BRDA:2,0,1,-",
    "LF:999",
    "LH:999",
    "FNF:999",
    "FNH:999",
    "BRF:999",
    "BRH:999",
    "unknown:inside",
    "end_of_record",
    "VER:outside",
    "",
  ].join("\r\n");
  assert.deepEqual(parseLcov(input), [
    {
      file: "a.ts",
      metrics: {
        lines: { covered: 1, total: 2 },
        functions: { covered: 0, total: 1 },
        branches: { covered: 1, total: 2 },
      },
    },
  ]);
  assert.deepEqual(parseLcov("SF:a.ts\nBRDA:1,0,0,-\nend_of_record")[0].metrics.branches, {
    covered: 0,
    total: 1,
  });
});

test("gives a function the same identity whatever order the records declare it in", async () => {
  // Two records for one file need not list their functions in the same order. An occurrence index
  // counted per *name* made `FN:10,f; FN:20,f` and `FN:20,f; FN:10,f` four distinct functions and
  // reported 2/4 for a file with two.
  const { root } = await fixture();
  const forward = `TN:\nSF:${join(root, "src/utils/example.ts")}\nFN:10,f\nFN:20,f\nFNDA:1,f\nFNDA:0,f\nDA:10,1\nDA:20,0\nend_of_record\n`;
  const reversed = `TN:\nSF:src/utils/example.ts\nFN:20,f\nFN:10,f\nFNDA:0,f\nFNDA:1,f\nDA:20,0\nDA:10,1\nend_of_record\n`;
  const report = await buildCoverageReport({
    config,
    configPath: "coverage-areas.json",
    lcov: `${forward}${reversed}`,
    root,
  });
  assert.deepEqual(report.utilities.functions, { covered: 1, total: 2 });
  assert.deepEqual(report.utilities.lines, { covered: 1, total: 2 });
});

test("rejects a statementFree list of the wrong shape rather than ignoring it", async () => {
  // Matrix rows 14a and 14b record these two shapes as wrong-shape failures. Silently ignoring a
  // malformed declaration would make a mistyped entry a no-op, which is the one outcome the list
  // must not have, so the shapes are pinned here rather than only measured once. `null` is
  // deliberately not among them: `?? []` reads it as "no declarations", which is a safe reading --
  // the genuinely statement-free files then fail condition 1 loudly rather than quietly.
  const { root } = await fixture();
  for (const statementFree of [{}, [null]]) {
    await assert.rejects(
      () =>
        buildCoverageReport({
          config: { ...config, sources: [{ ...config.sources[0], statementFree }] },
          configPath: "coverage-areas.json",
          lcov,
          root,
        }),
      TypeError,
    );
  }
});

test("rejects a declaration for a file that exists on disk but is excluded", async () => {
  // Condition 2 is measured-set membership, not filesystem existence: an implementation
  // checking `fs.existsSync` would accept this declaration and the file would stay out of the
  // denominator with a config entry that looks deliberate.
  const excludedFile = "src/utils/tests/helper.ts";
  const { root } = await fixture({ files: { [excludedFile]: "export const helper = 1;\n" } });
  await assert.rejects(
    () =>
      buildCoverageReport({
        config: withStatementFree([excludedFile]),
        configPath: "coverage-areas.json",
        lcov,
        root,
      }),
    /Coverage statementFree declarations are outside the measured production set: src\/utils\/tests\/helper\.ts\./,
  );
});

test("rejects two declared paths absent from the measured production set", async () => {
  const declaredPaths = ["src/utils/dead-b.ts", "src/utils/dead-a.ts"];
  const { root } = await fixture();
  await assert.rejects(
    () =>
      buildCoverageReport({
        config: withStatementFree(declaredPaths),
        configPath: "coverage-areas.json",
        lcov,
        root,
      }),
    /Coverage statementFree declarations are outside the measured production set: src\/utils\/dead-a\.ts, src\/utils\/dead-b\.ts\. Remove each dead declaration or restore the file to the measured production set\./,
  );
});

test("rejects declared paths that are no longer blank", async () => {
  const declaredPaths = ["src/utils/declared-b.ts", "src/utils/declared-a.ts"];
  const { root } = await fixture({
    files: Object.fromEntries(
      declaredPaths.map((file) => [file, "export const declared = true;\n"]),
    ),
  });
  const declaredLcov = declaredPaths.map((file) =>
    lcovRecord(file, { lines: 1, functions: 1, branches: 1 }),
  );
  await assert.rejects(
    () =>
      buildCoverageReport({
        config: withStatementFree(declaredPaths),
        configPath: "coverage-areas.json",
        lcov: `${lcov}${declaredLcov.join("")}`,
        root,
      }),
    /Coverage statementFree declarations are no longer blank: src\/utils\/declared-a\.ts, src\/utils\/declared-b\.ts\. Remove each declaration so the file contributes its coverage records\./,
  );

  const partialZeroCases = [
    ["lines", { lines: 0, functions: 1, branches: 1 }],
    ["functions", { lines: 1, functions: 0, branches: 1 }],
    ["branches", { lines: 1, functions: 1, branches: 0 }],
  ];
  for (const [metric, totals] of partialZeroCases) {
    const file = `src/utils/declared-partial-${metric}.ts`;
    const partialFixture = await fixture({ files: { [file]: "export const declared = true;\n" } });
    await assert.rejects(
      () =>
        buildCoverageReport({
          config: withStatementFree([file]),
          configPath: "coverage-areas.json",
          lcov: `${lcov}${lcovRecord(file, totals)}`,
          root: partialFixture.root,
        }),
      new RegExp(
        `Coverage statementFree declarations are no longer blank: ${file.replaceAll("/", "\\/")}\\.`,
      ),
    );
  }
});

test("matches statementFree declarations literally rather than as globs", async () => {
  const { root } = await fixture();
  await assert.rejects(
    () =>
      buildCoverageReport({
        config: withStatementFree(["src/**"]),
        configPath: "coverage-areas.json",
        lcov,
        root,
      }),
    /Coverage statementFree declarations are outside the measured production set: src\/\*\*\./,
  );
});

test("accepts each partial-zero permutation for an undeclared production file", async () => {
  const partialZeroCases = [
    ["lines", { lines: 0, functions: 1, branches: 1 }],
    ["functions", { lines: 1, functions: 0, branches: 1 }],
    ["branches", { lines: 1, functions: 1, branches: 0 }],
  ];
  for (const [metric, totals] of partialZeroCases) {
    const file = `src/utils/partial-${metric}.ts`;
    const partialFixture = await fixture({ files: { [file]: "export const partial = true;\n" } });
    const report = await buildCoverageReport({
      config,
      configPath: "coverage-areas.json",
      lcov: `${lcov}${lcovRecord(file, totals)}`,
      root: partialFixture.root,
    });
    assert.deepEqual(report.utilities, {
      lines: { covered: 1 + (totals.lines > 0 ? 1 : 0), total: 2 + totals.lines },
      functions: { covered: 1 + (totals.functions > 0 ? 1 : 0), total: 1 + totals.functions },
      branches: { covered: 1 + (totals.branches > 0 ? 1 : 0), total: 2 + totals.branches },
    });
  }
});

test("rejects a blank measurement for a backend-shaped configuration", async () => {
  const backendConfig = {
    version: 1,
    sources: [
      {
        id: "backend",
        root: "src-tauri/src",
        include: ["src-tauri/src/**/*.rs"],
        exclude: [],
      },
    ],
    areas: [{ id: "backend-area", source: "backend", paths: ["src-tauri/src/**"] }],
  };
  const blankFile = "src-tauri/src/blank.rs";
  const { root } = await fixture({ files: { [blankFile]: "pub type Blank = ();\n" } });
  await assert.rejects(
    () =>
      buildCoverageReport({
        config: backendConfig,
        configPath: "backend-coverage-areas.json",
        lcov: blankLcov(blankFile),
        root,
      }),
    /Coverage measurement is blank for production files: src-tauri\/src\/blank\.rs\./,
  );
});

test("rejects coverage regressions", () => {
  const report = {
    utilities: {
      lines: { covered: 1, total: 2 },
      functions: { covered: 1, total: 1 },
      branches: { covered: 1, total: 2 },
    },
  };
  const baseline = {
    version: 1,
    areas: {
      utilities: {
        lines: { covered: 2, total: 2 },
        functions: { covered: 1, total: 1 },
        branches: { covered: 1, total: 2 },
      },
    },
  };
  assert.throws(() => assertBaseline(report, baseline), /utilities lines regressed/);
});

test("rejects untested code added on top of an unchanged covered count", () => {
  assert.throws(
    () =>
      assertBaseline(
        { utilities: metrics("lines", 15, 659) },
        { version: 1, areas: { utilities: metrics("lines", 15, 653) } },
      ),
    /utilities lines regressed/,
  );
});

test("rejects narrowing the measured scope, which shrinks the total without deleting code", () => {
  const metrics = () => ({
    lines: { covered: 50, total: 90 },
    functions: { covered: 1, total: 1 },
    branches: { covered: 1, total: 2 },
  });
  const widened = {
    ...config,
    sources: [
      {
        ...config.sources[0],
        exclude: [...config.sources[0].exclude, "src/untested-thing.ts"],
      },
    ],
  };
  // The second narrowing route the signature pins: the same measured file is
  // instead permitted to contribute nothing. Both must reject, or declaring a
  // file would be a narrowing that no guard sees.
  const declared = {
    ...config,
    sources: [
      {
        ...config.sources[0],
        statementFree: [
          { path: "src/untested-thing.ts", reason: "The fixture changed its declaration." },
        ],
      },
    ],
  };
  const baseline = {
    version: 1,
    scope: scopeSignature(config),
    areas: { utilities: { ...metrics(), lines: { covered: 50, total: 100 } } },
  };
  const namesEveryPinnedComponent = (error) => {
    assert.match(error.message, /source ids and roots/);
    assert.match(error.message, /include globs/);
    assert.match(error.message, /exclude globs/);
    assert.match(error.message, /statementFree/);
    assert.match(error.message, /area ids, sources, and paths/);
    assert.match(error.message, /scope subtree by hand/);
    assert.doesNotMatch(error.message, /coverage:baseline:|--write-baseline/);
    return true;
  };
  // Numbers alone would pass: covered is unchanged and the ratio rose.
  assert.doesNotThrow(() => assertBaseline({ utilities: metrics() }, baseline, config));
  assert.throws(
    () => assertBaseline({ utilities: metrics() }, baseline, widened),
    namesEveryPinnedComponent,
  );
  assert.throws(
    () => assertBaseline({ utilities: metrics() }, baseline, declared),
    namesEveryPinnedComponent,
  );
  // And the other direction: a baseline that records a declaration the config no longer makes.
  // The comparison is a string equality, so this is symmetric by construction -- but only this
  // case proves it, and it is the direction in which a declaration quietly disappears.
  const staleBaseline = { ...baseline, scope: scopeSignature(declared) };
  assert.throws(
    () => assertBaseline({ utilities: metrics() }, staleBaseline, config),
    namesEveryPinnedComponent,
  );
});

test("accepts a shrinking total when coverage rises", () => {
  // Covered rises and the ratio rises; only the denominator shrank, which is
  // observable here and must not count as a regression.
  assert.doesNotThrow(() =>
    assertBaseline(
      { utilities: metrics("branches", 77, 1048) },
      { version: 1, areas: { utilities: metrics("branches", 12, 1051) } },
    ),
  );
});

test("bounds the covered-count allowance by the total shrink and returns it", () => {
  assert.deepEqual(
    assertBaseline(
      { utilities: metrics("branches", 180, 5676) },
      { version: 1, areas: { utilities: metrics("branches", 181, 5677) } },
    ),
    [{ area: "utilities", metric: "branches", totalShrink: 1 }],
  );
  assert.throws(
    () =>
      assertBaseline(
        { utilities: metrics("branches", 179, 5676) },
        { version: 1, areas: { utilities: metrics("branches", 181, 5677) } },
      ),
    /utilities branches regressed/,
  );
});

test("reports no allowance for a shrink that never needed one", () => {
  // A shrinking total with rising coverage raises the ratio, so the
  // unadjusted rule already passes. Announcing an allowance here would claim
  // records were forgiven that were never at risk.
  assert.deepEqual(
    assertBaseline(
      { utilities: metrics("branches", 77, 1048) },
      { version: 1, areas: { utilities: metrics("branches", 12, 1051) } },
    ),
    [],
  );
});

test("keeps the current ratchets when the total does not shrink", () => {
  const baseline = { version: 1, areas: { utilities: metrics("lines", 15, 653) } };
  assert.throws(
    () => assertBaseline({ utilities: metrics("lines", 15, 659) }, baseline),
    /utilities lines regressed/,
  );
  assert.deepEqual(assertBaseline({ utilities: metrics("lines", 16, 653) }, baseline), []);
  assert.throws(
    () => assertBaseline({ utilities: metrics("lines", 14, 653) }, baseline),
    /utilities lines regressed/,
  );
  assert.throws(
    () => assertBaseline({ utilities: metrics("lines", 16, 700) }, baseline),
    /utilities lines regressed/,
  );
});

test("announces baseline allowances through the CLI", async () => {
  const { root } = await fixture();
  const sourcePath = relative(process.cwd(), join(root, "src")).split(sep).join("/");
  const config = {
    version: 1,
    sources: [
      {
        id: "frontend",
        root: join(root, "src"),
        include: [`${sourcePath}/**/*.ts`],
        exclude: [],
      },
    ],
    areas: [
      {
        id: "utilities",
        source: "frontend",
        minimumCoverage: { lines: 0, functions: 0, branches: 0 },
        paths: [`${sourcePath}/utils/**`],
      },
    ],
  };
  const baseline = {
    version: 1,
    scope: scopeSignature(config),
    areas: {
      utilities: {
        lines: { covered: 2, total: 2 },
        functions: { covered: 2, total: 2 },
        branches: { covered: 2, total: 2 },
      },
    },
  };
  const configPath = join(root, "config.json");
  const baselinePath = join(root, "baseline.json");
  const lcovPath = join(root, "lcov.info");
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(baselinePath, JSON.stringify(baseline));
  await writeFile(
    lcovPath,
    `TN:\nSF:${join(root, "src", "utils", "example.ts")}\nFN:1,example\nFNDA:1,example\nDA:1,1\nBRDA:1,0,0,1\nend_of_record\n`,
  );

  const result = spawnSync(
    process.execPath,
    [
      join(process.cwd(), "scripts", "coverage-report.mjs"),
      "--config",
      configPath,
      "--baseline",
      baselinePath,
      "--lcov",
      lcovPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Coverage baseline allowance: utilities lines, 1 record\(s\) forgiven due to total shrink/,
  );
});

test("reports each statementFree validation condition through the CLI", async () => {
  const blankFile = "src/utils/blank.ts";
  const blankFixture = await fixture({ files: { [blankFile]: "export type Blank = string;\n" } });
  const deadFixture = await fixture();
  const nonBlankFixture = await fixture();
  const cases = [
    {
      root: blankFixture.root,
      config: cliConfig(),
      lcov: `${lcov}${blankLcov(blankFile)}`,
      message: /Coverage measurement is blank for production files: src\/utils\/blank\.ts\./,
    },
    {
      root: deadFixture.root,
      config: cliConfig([{ path: "src/utils/dead.ts", reason: "Fixture declaration." }]),
      lcov,
      message:
        /Coverage statementFree declarations are outside the measured production set: src\/utils\/dead\.ts\./,
    },
    {
      root: nonBlankFixture.root,
      config: cliConfig([{ path: "src/utils/example.ts", reason: "Fixture declaration." }]),
      lcov,
      message: /Coverage statementFree declarations are no longer blank: src\/utils\/example\.ts\./,
    },
  ];
  for (const { root, config, lcov: fixtureLcov, message } of cases) {
    const result = await runCoverageCli(root, { config, lcov: fixtureLcov });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, message);
  }
});

test("reports a stale recorded scope through the CLI", async () => {
  // The scope message is the one this run rewrote, and a unit call to `assertBaseline` proves
  // neither the stderr an operator sees nor the exit status.
  const { root } = await fixture();
  const declared = cliConfig([{ path: "src/utils/example.ts", reason: "Fixture declaration." }]);
  await writeFile(join(root, "config.json"), JSON.stringify(cliConfig()));
  await writeFile(join(root, "lcov.info"), lcov);
  await writeFile(
    join(root, "baseline.json"),
    JSON.stringify({
      version: 1,
      scope: scopeSignature(declared),
      areas: {
        utilities: {
          lines: { covered: 1, total: 2 },
          functions: { covered: 1, total: 1 },
          branches: { covered: 1, total: 2 },
        },
      },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      join(process.cwd(), "scripts", "coverage-report.mjs"),
      "--config",
      "config.json",
      "--baseline",
      "baseline.json",
      "--lcov",
      "lcov.info",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Coverage measurement scope changed/);
  assert.match(result.stderr, /statementFree/);
  assert.match(result.stderr, /scope subtree by hand/);
  assert.doesNotMatch(result.stderr, /coverage:baseline:|--write-baseline/);
});

test("rejects an undeclared blank before the CLI writes a baseline", async () => {
  const blankFile = "src/utils/blank.ts";
  const { root } = await fixture({ files: { [blankFile]: "export type Blank = string;\n" } });
  const result = await runCoverageCli(root, {
    config: cliConfig(),
    lcov: `${lcov}${blankLcov(blankFile)}`,
    writeBaseline: true,
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(
    result.stderr,
    /Coverage measurement is blank for production files: src\/utils\/blank\.ts\./,
  );
  await assert.rejects(
    () => readFile(join(root, "scratch-baseline.json")),
    (error) => error.code === "ENOENT",
  );
});

test("preserves the previous baseline and cleans up every failed write path", async (t) => {
  const previousBaseline = Buffer.from("previous baseline bytes\n");
  const temporarySuffix = ".tmp.json";
  const failureCases = [
    {
      name: "writeFile failure",
      configure: (fileSystem) => {
        const primaryError = new Error("writeFile failed");
        fileSystem.writeFile = async (path, contents) => {
          await writeFile(path, contents);
          throw primaryError;
        };
        return primaryError;
      },
    },
    {
      name: "formatter non-zero exit",
      formatter: "non-zero",
    },
    {
      name: "formatter killed by a signal",
      formatter: "signal",
    },
    {
      name: "missing formatter binary",
      formatter: "missing",
    },
    {
      name: "rename failure",
      configure: (fileSystem) => {
        const primaryError = new Error("rename failed");
        fileSystem.rename = async () => {
          throw primaryError;
        };
        return primaryError;
      },
    },
  ];

  const runCase = async (failureCase, cleanupFails) => {
    const { root } = await fixture();
    const outputPath = join(root, "scratch-baseline.json");
    const temporaryPath = `${outputPath}${temporarySuffix}`;
    await writeFile(outputPath, previousBaseline);
    if (failureCase.formatter && failureCase.formatter !== "missing") {
      await installOxfmt(root, failureCase.formatter);
    }

    const unlinkCalls = [];
    const fileSystem = {
      writeFile,
      rename: renameFile,
      unlink: async (path) => {
        unlinkCalls.push(path);
        if (cleanupFails) throw new Error("unlink failed");
        return unlinkFile(path);
      },
    };
    const injectedPrimaryError = failureCase.configure?.(fileSystem);
    const write = () => writeBaseline({ areas: { utilities: {} }, path: outputPath }, fileSystem);
    let error;
    const invoke = failureCase.formatter
      ? async () => {
          const previousDirectory = process.cwd();
          process.chdir(root);
          try {
            return await write();
          } finally {
            process.chdir(previousDirectory);
          }
        }
      : write;
    await assert.rejects(invoke, (caught) => {
      error = caught;
      return true;
    });

    assert.deepEqual(await readFile(outputPath), previousBaseline);
    if (cleanupFails) {
      assert.deepEqual(unlinkCalls, [temporaryPath]);
      assert.ok(await readFile(temporaryPath, "utf8"));
    } else {
      await assert.rejects(
        () => readFile(temporaryPath),
        (cleanupError) => cleanupError.code === "ENOENT",
      );
    }

    if (injectedPrimaryError) {
      assert.equal(error, injectedPrimaryError);
      assert.equal(error.message, injectedPrimaryError.message);
    }
    if (failureCase.name === "writeFile failure") assert.equal(error.message, "writeFile failed");
    if (failureCase.name === "rename failure") assert.equal(error.message, "rename failed");
    if (failureCase.name === "formatter non-zero exit") {
      assert.match(
        error.message,
        new RegExp(
          `Failed to format coverage baseline with ${resolve(root, "node_modules/.bin/oxfmt")}`,
        ),
      );
      assert.match(
        error.message,
        /status=23; signal=null; stderr="formatter rejected the temporary baseline"/,
      );
    }
    if (failureCase.name === "formatter killed by a signal") {
      assert.match(
        error.message,
        new RegExp(
          `Failed to format coverage baseline with ${resolve(root, "node_modules/.bin/oxfmt")}`,
        ),
      );
      assert.match(error.message, /status=null; signal=SIGTERM/);
    }
    if (failureCase.name === "missing formatter binary") {
      assert.match(
        error.message,
        new RegExp(
          `Failed to format coverage baseline with ${resolve(root, "node_modules/.bin/oxfmt")}`,
        ),
      );
      assert.match(
        error.message,
        /status=null; signal=null; stderr=""; error\.code=ENOENT; error\.message=/,
      );
    }
  };

  const assertFormatterCliFailure = async (failureCase) => {
    const { root } = await fixture();
    const cliPreviousBaseline = Buffer.from(
      JSON.stringify(
        baselineFor(cliConfig(), {
          utilities: baselineMetrics(
            { covered: 0, total: 10 },
            { covered: 0, total: 10 },
            { covered: 0, total: 10 },
          ),
        }),
      ),
    );
    if (failureCase.formatter && failureCase.formatter !== "missing") {
      await installOxfmt(root, failureCase.formatter);
    }
    const cliResult = await runCoverageCli(root, {
      config: cliConfig(),
      lcov,
      writeBaseline: true,
      baselineContents: cliPreviousBaseline,
    });
    assert.notEqual(cliResult.status, 0, cliResult.stdout);
    assert.doesNotMatch(cliResult.stdout, /Wrote coverage baseline:/);
    assert.match(cliResult.stderr, /Failed to format coverage baseline with /);
    if (failureCase.name === "formatter non-zero exit") {
      assert.match(
        cliResult.stderr,
        /status=23; signal=null; stderr="formatter rejected the temporary baseline"/,
      );
    } else if (failureCase.name === "formatter killed by a signal") {
      assert.match(cliResult.stderr, /status=null; signal=SIGTERM/);
    } else {
      assert.match(
        cliResult.stderr,
        /status=null; signal=null; stderr=""; error\.code=ENOENT; error\.message=/,
      );
    }
    assert.deepEqual(await readFile(join(root, "scratch-baseline.json")), cliPreviousBaseline);
    await assert.rejects(
      () => readFile(join(root, "scratch-baseline.json.tmp.json")),
      (cleanupError) => cleanupError.code === "ENOENT",
    );
  };

  for (const failureCase of failureCases) {
    await t.test(`${failureCase.name}: failed write`, async () => {
      await runCase(failureCase, false);
      if (failureCase.formatter) await assertFormatterCliFailure(failureCase);
    });
    await t.test(`${failureCase.name}: failed cleanup`, () => runCase(failureCase, true));
  }
});

test("enforces configured percentage floors for every area metric", () => {
  const report = {
    utilities: {
      lines: { covered: 2, total: 4 },
      functions: { covered: 1, total: 2 },
      branches: { covered: 3, total: 4 },
    },
  };
  const configured = {
    ...config,
    areas: [
      {
        ...config.areas[0],
        minimumCoverage: { lines: 50, functions: 50, branches: 75 },
      },
    ],
  };
  assert.doesNotThrow(() => assertAreaFloors(report, configured));
  configured.areas[0].minimumCoverage.branches = 76;
  assert.throws(
    () => assertAreaFloors(report, configured),
    /utilities branches is below minimum coverage: 75\.00% < 76\.00%/,
  );
});

test("rejects an area whose declared source is not the file's source", async () => {
  // The only surviving copy of this check, and the one the production-file loop runs. The LCOV
  // loop's identical copy was dead for every input -- it saw only files that loop had already
  // validated -- and was deleted with `f-20260921-02`.
  const { root } = await fixture();
  const mismatched = {
    ...config,
    areas: [{ ...config.areas[0], source: "backend" }],
  };
  await assert.rejects(
    () =>
      buildCoverageReport({
        config: mismatched,
        configPath: "coverage-areas.json",
        lcov,
        root,
      }),
    /Coverage area utilities has the wrong source for src\/utils\/example\.ts/,
  );
});

test("rejects unmapped production files and missing coverage input", async () => {
  const unmapped = await fixture();
  await writeFile(join(unmapped.root, "src", "other.ts"), "export const other = 1;\n");
  await assert.rejects(
    () =>
      buildCoverageReport({ config, configPath: "coverage-areas.json", lcov, root: unmapped.root }),
    /Unmapped production file/,
  );
  const missing = await fixture();
  await assert.rejects(
    () =>
      buildCoverageReport({
        config,
        configPath: "coverage-areas.json",
        lcov: "",
        root: missing.root,
      }),
    /Coverage data missing/,
  );
});

test("writes a baseline with exact integer totals", async () => {
  const { root } = await fixture();
  const areas = await buildCoverageReport({
    config,
    configPath: "coverage-areas.json",
    lcov,
    root,
  });
  const path = join(root, "baseline.json");
  await writeBaseline({ areas, path });
  const baseline = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(baseline.areas.utilities.lines, { covered: 1, total: 2 });
  assert.doesNotThrow(() => assertBaseline(areas, baseline));
});

test("baseline writer refuses per-area covered-count and ratio decreases before writing", async (t) => {
  const config = writerConfig({ twoAreas: true });
  const reportMetrics = {
    utilities: baselineMetrics(
      { covered: 9, total: 18 },
      { covered: 2, total: 2 },
      { covered: 1, total: 2 },
    ),
    puzzles: baselineMetrics(
      { covered: 3, total: 6 },
      { covered: 1, total: 1 },
      { covered: 1, total: 2 },
    ),
  };
  const puzzleFile = { "src/puzzles/example.ts": "export const puzzle = 1;\n" };
  const cases = [
    {
      name: "covered count drops while the ratio stays level",
      areas: {
        utilities: baselineMetrics(
          { covered: 10, total: 20 },
          { covered: 2, total: 2 },
          { covered: 1, total: 2 },
        ),
        puzzles: reportMetrics.puzzles,
      },
      message: /utilities lines \(covered count 10 → 9\)/,
    },
    {
      name: "ratio drops while the covered count rises",
      areas: {
        utilities: baselineMetrics(
          { covered: 5, total: 10 },
          { covered: 2, total: 2 },
          { covered: 1, total: 2 },
        ),
        puzzles: reportMetrics.puzzles,
      },
      actualLines: { covered: 6, total: 13 },
      message: /utilities lines \(ratio 50\.00% → 46\.15%\)/,
    },
  ];

  for (const failureCase of cases) {
    await t.test(failureCase.name, async () => {
      const caseMetrics = {
        ...reportMetrics,
        utilities: {
          ...reportMetrics.utilities,
          lines: failureCase.actualLines ?? reportMetrics.utilities.lines,
        },
      };
      const fixtureCase = await coverageWriterFixture({
        config,
        records: writerLcov(caseMetrics),
        files: puzzleFile,
        baseline: baselineFor(config, failureCase.areas),
      });
      const expected = fixtureCase.baselineContents;
      const result = await runCoverageCli(fixtureCase.root, {
        config,
        lcov: fixtureCase.lcov,
        writeBaseline: true,
        baselineContents: expected,
      });
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /Coverage baseline write refused/);
      assert.match(result.stderr, failureCase.message);
      assertDeltaLines(result.stdout, ["utilities", "puzzles"]);
      await assertScratchBaselineUnchanged(fixtureCase.root, expected);
    });
  }

  await t.test("a removed area is a decrease of all its recorded metrics", async () => {
    const singleConfig = writerConfig();
    const singleLcov = writerLcov({
      utilities: baselineMetrics(
        { covered: 1, total: 1 },
        { covered: 1, total: 1 },
        { covered: 1, total: 1 },
      ),
    });
    const areas = {
      utilities: baselineMetrics(
        { covered: 1, total: 1 },
        { covered: 1, total: 1 },
        { covered: 1, total: 1 },
      ),
      retired: baselineMetrics(
        { covered: 1, total: 1 },
        { covered: 1, total: 1 },
        { covered: 1, total: 1 },
      ),
    };
    const fixtureCase = await coverageWriterFixture({
      config: singleConfig,
      records: singleLcov,
      baseline: baselineFor(singleConfig, areas),
    });
    const expected = fixtureCase.baselineContents;
    const result = await runCoverageCli(fixtureCase.root, {
      config: singleConfig,
      lcov: fixtureCase.lcov,
      writeBaseline: true,
      baselineContents: expected,
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(
      result.stdout,
      /Coverage baseline delta: retired lines: 1\/1 \(100\.00%\) → REMOVED \[DECREASE\]/,
    );
    assert.match(result.stderr, /areas changed: added=\[\], removed=\[retired\]/);
    await assertScratchBaselineUnchanged(fixtureCase.root, expected);
  });

  await t.test("0/0 to 0/1 is a ratio decrease", async () => {
    const singleConfig = writerConfig();
    const areas = {
      utilities: baselineMetrics(
        { covered: 0, total: 0 },
        { covered: 1, total: 1 },
        { covered: 1, total: 1 },
      ),
    };
    const records = writerLcov({
      utilities: baselineMetrics(
        { covered: 0, total: 1 },
        { covered: 1, total: 1 },
        { covered: 1, total: 1 },
      ),
    });
    const fixtureCase = await coverageWriterFixture({
      config: singleConfig,
      records,
      baseline: baselineFor(singleConfig, areas),
    });
    const expected = fixtureCase.baselineContents;
    const result = await runCoverageCli(fixtureCase.root, {
      config: singleConfig,
      lcov: fixtureCase.lcov,
      writeBaseline: true,
      baselineContents: expected,
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(
      result.stdout,
      /utilities lines: 0\/0 \(100\.00%\) → 0\/1 \(0\.00%\) \[DECREASE\]/,
    );
    assert.match(result.stderr, /utilities lines \(ratio 100\.00% → 0\.00%\)/);
    await assertScratchBaselineUnchanged(fixtureCase.root, expected);
  });
});

test("baseline writer prints every area metric on refused and accepted multi-area writes", async (t) => {
  const config = writerConfig({ twoAreas: true });
  const actual = {
    utilities: baselineMetrics(
      { covered: 9, total: 18 },
      { covered: 2, total: 2 },
      { covered: 1, total: 2 },
    ),
    puzzles: baselineMetrics(
      { covered: 3, total: 6 },
      { covered: 1, total: 1 },
      { covered: 1, total: 2 },
    ),
  };
  const lower = {
    utilities: baselineMetrics(
      { covered: 8, total: 18 },
      { covered: 1, total: 2 },
      { covered: 0, total: 2 },
    ),
    puzzles: baselineMetrics(
      { covered: 2, total: 6 },
      { covered: 0, total: 1 },
      { covered: 0, total: 2 },
    ),
  };
  const records = writerLcov(actual);
  const files = { "src/puzzles/example.ts": "export const puzzle = 1;\n" };

  await t.test("refused write", async () => {
    const fixtureCase = await coverageWriterFixture({
      config,
      records,
      files,
      baseline: baselineFor(config, lower),
    });
    const expected = fixtureCase.baselineContents;
    const result = await runCoverageCli(fixtureCase.root, {
      config,
      lcov: fixtureCase.lcov,
      writeBaseline: true,
      baselineContents: expected,
    });
    assert.equal(result.status, 1, result.stdout);
    assertDeltaLines(result.stdout, ["utilities", "puzzles"]);
    await assertScratchBaselineUnchanged(fixtureCase.root, expected);
  });

  await t.test("accepted increase-only write", async () => {
    const fixtureCase = await coverageWriterFixture({
      config,
      records,
      files,
      baseline: baselineFor(config, lower),
    });
    const expected = fixtureCase.baselineContents;
    await installOxfmt(fixtureCase.root, "success");
    const result = await runCoverageCli(fixtureCase.root, {
      config,
      lcov: fixtureCase.lcov,
      writeBaseline: true,
      baselineContents: expected,
    });
    assert.equal(result.status, 0, result.stderr);
    assertDeltaLines(result.stdout, ["utilities", "puzzles"]);
    assert.match(result.stdout, /Wrote coverage baseline: scratch-baseline\.json/);
    const written = JSON.parse(
      await readFile(join(fixtureCase.root, "scratch-baseline.json"), "utf8"),
    );
    assert.deepEqual(written.areas, actual);
  });
});

test("baseline writer requires authorization for area-set and scope changes", async (t) => {
  const config = writerConfig({ twoAreas: true });
  const actual = {
    utilities: baselineMetrics(
      { covered: 2, total: 2 },
      { covered: 1, total: 1 },
      { covered: 1, total: 1 },
    ),
    puzzles: baselineMetrics(
      { covered: 1, total: 1 },
      { covered: 1, total: 1 },
      { covered: 1, total: 1 },
    ),
  };
  const records = writerLcov(actual);
  const files = { "src/puzzles/example.ts": "export const puzzle = 1;\n" };
  const utilitiesOnly = { utilities: actual.utilities };

  await t.test("added area refused without authorization", async () => {
    const fixtureCase = await coverageWriterFixture({
      config,
      records,
      files,
      baseline: baselineFor(config, utilitiesOnly),
    });
    const expected = fixtureCase.baselineContents;
    const result = await runCoverageCli(fixtureCase.root, {
      config,
      lcov: fixtureCase.lcov,
      writeBaseline: true,
      baselineContents: expected,
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(
      result.stdout,
      /Coverage baseline delta: puzzles lines: NEW → 1\/1 \(100\.00%\) \[NEW\]/,
    );
    assert.match(result.stderr, /areas changed: added=\[puzzles\], removed=\[\]/);
    await assertScratchBaselineUnchanged(fixtureCase.root, expected);
  });

  await t.test("added area accepted with a governing decision", async () => {
    const fixtureCase = await coverageWriterFixture({
      config,
      records,
      files,
      baseline: baselineFor(config, utilitiesOnly),
    });
    const expected = fixtureCase.baselineContents;
    await writeFixtureDecision(fixtureCase.root);
    await installOxfmt(fixtureCase.root, "success");
    const result = await runCoverageCli(fixtureCase.root, {
      config,
      lcov: fixtureCase.lcov,
      writeBaseline: true,
      baselineContents: expected,
      instrumentChange: "d-20260927-23",
      finding: "f-20260829-04",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Coverage baseline write authorized by decision d-20260927-23 for finding f-20260829-04/,
    );
    assert.equal(
      JSON.parse(await readFile(join(fixtureCase.root, "scratch-baseline.json"), "utf8")).areas
        .puzzles.lines.total,
      1,
    );
  });

  await t.test("tracked empty and partial area sets are refused", async (t2) => {
    for (const { name, areas, expectedAdded } of [
      { name: "tracked empty areas", areas: {}, expectedAdded: /added=\[puzzles, utilities\]/ },
      {
        name: "one reported area missing from tracked prior",
        areas: utilitiesOnly,
        expectedAdded: /added=\[puzzles\]/,
      },
    ]) {
      await t2.test(name, async () => {
        const fixtureCase = await coverageWriterFixture({ config, records, files });
        const priorText = JSON.stringify(baselineFor(config, areas));
        await createScratchHead(fixtureCase.root, { "scratch-baseline.json": priorText });
        const expectedWorkingCopy = priorText;
        const result = await runCoverageCli(fixtureCase.root, {
          config,
          lcov: fixtureCase.lcov,
          writeBaseline: true,
          baselineContents: expectedWorkingCopy,
        });
        assert.equal(result.status, 1, result.stdout);
        assert.match(result.stderr, /areas changed: added=\[/);
        assert.match(result.stderr, expectedAdded);
        await assertScratchBaselineUnchanged(fixtureCase.root, expectedWorkingCopy);
      });
    }
  });

  await t.test("scope-only narrowing is refused without authorization", async () => {
    const priorConfig = writerConfig();
    const narrowedConfig = writerConfig({ exclude: ["src/utils/untested.ts"] });
    const example = baselineMetrics(
      { covered: 1, total: 1 },
      { covered: 1, total: 1 },
      { covered: 1, total: 1 },
    );
    const untested = baselineMetrics(
      { covered: 0, total: 1 },
      { covered: 0, total: 1 },
      { covered: 0, total: 1 },
    );
    const records = [
      coverageLcov("src/utils/example.ts", example),
      coverageLcov("src/utils/untested.ts", untested),
    ].join("\n");
    const fixtureCase = await coverageWriterFixture({
      config: narrowedConfig,
      records,
      files: { "src/utils/untested.ts": "export const untested = 0;\n" },
      baseline: baselineFor(priorConfig, {
        utilities: baselineMetrics(
          { covered: 1, total: 2 },
          { covered: 1, total: 2 },
          { covered: 1, total: 2 },
        ),
      }),
    });
    const expected = fixtureCase.baselineContents;
    const result = await runCoverageCli(fixtureCase.root, {
      config: narrowedConfig,
      lcov: fixtureCase.lcov,
      writeBaseline: true,
      baselineContents: expected,
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /Coverage baseline scope changed: sources\[0\]\.exclude/);
    assert.match(result.stderr, /scope keys changed: sources\[0\]\.exclude/);
    assert.doesNotMatch(result.stdout, /\[DECREASE\]/);
    await assertScratchBaselineUnchanged(fixtureCase.root, expected);
  });

  await t.test("scope-only narrowing is accepted with a governing decision", async () => {
    const priorConfig = writerConfig();
    const narrowedConfig = writerConfig({ exclude: ["src/utils/untested.ts"] });
    const example = baselineMetrics(
      { covered: 1, total: 1 },
      { covered: 1, total: 1 },
      { covered: 1, total: 1 },
    );
    const untested = baselineMetrics(
      { covered: 0, total: 1 },
      { covered: 0, total: 1 },
      { covered: 0, total: 1 },
    );
    const records = [
      coverageLcov("src/utils/example.ts", example),
      coverageLcov("src/utils/untested.ts", untested),
    ].join("\n");
    const fixtureCase = await coverageWriterFixture({
      config: narrowedConfig,
      records,
      files: { "src/utils/untested.ts": "export const untested = 0;\n" },
      baseline: baselineFor(priorConfig, {
        utilities: baselineMetrics(
          { covered: 1, total: 2 },
          { covered: 1, total: 2 },
          { covered: 1, total: 2 },
        ),
      }),
    });
    const expected = fixtureCase.baselineContents;
    await writeFixtureDecision(fixtureCase.root);
    await installOxfmt(fixtureCase.root, "success");
    const result = await runCoverageCli(fixtureCase.root, {
      config: narrowedConfig,
      lcov: fixtureCase.lcov,
      writeBaseline: true,
      baselineContents: expected,
      instrumentChange: "d-20260927-23",
      finding: "f-20260829-04",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Coverage baseline scope changed: sources\[0\]\.exclude/);
    assert.match(result.stdout, /authorized by decision d-20260927-23 for finding f-20260829-04/);
  });
});

test("baseline writer authorizes decreases only for an exact Governs finding token", async (t) => {
  const config = writerConfig();
  const actual = baselineMetrics(
    { covered: 9, total: 18 },
    { covered: 1, total: 1 },
    { covered: 1, total: 1 },
  );
  const priorAreas = {
    utilities: baselineMetrics(
      { covered: 10, total: 20 },
      { covered: 1, total: 1 },
      { covered: 1, total: 1 },
    ),
  };
  const cases = [
    {
      name: "missing decisions file",
      decisionFile: false,
      stderr: /requires tasks\/decisions\.md/,
    },
    {
      name: "decision entry does not exist",
      decision: "d-20260927-22",
      governs: "f-20260829-04",
      stderr: /No decision entry found for --instrument-change d-20260927-23/,
    },
    {
      name: "Governs names only an adjacent finding id",
      decision: "d-20260927-23",
      governs: "f-20260829-040",
      stderr: /Decision d-20260927-23 does not govern finding f-20260829-04/,
    },
  ];
  for (const failureCase of cases) {
    await t.test(failureCase.name, async () => {
      const fixtureCase = await coverageWriterFixture({
        config,
        records: writerLcov({ utilities: actual }),
        baseline: baselineFor(config, priorAreas),
      });
      const expected = fixtureCase.baselineContents;
      if (failureCase.decisionFile !== false) {
        await writeFixtureDecision(fixtureCase.root, {
          decision: failureCase.decision ?? "d-20260927-23",
          governs: failureCase.governs ?? "f-20260829-04",
        });
      }
      const result = await runCoverageCli(fixtureCase.root, {
        config,
        lcov: fixtureCase.lcov,
        writeBaseline: true,
        baselineContents: expected,
        instrumentChange: "d-20260927-23",
        finding: "f-20260829-04",
      });
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, failureCase.stderr);
      await assertScratchBaselineUnchanged(fixtureCase.root, expected);
    });
  }

  await t.test("a governing decision permits a decrease and is printed", async () => {
    const fixtureCase = await coverageWriterFixture({
      config,
      records: writerLcov({ utilities: actual }),
      baseline: baselineFor(config, priorAreas),
    });
    const expected = fixtureCase.baselineContents;
    await writeFixtureDecision(fixtureCase.root);
    await installOxfmt(fixtureCase.root, "success");
    const result = await runCoverageCli(fixtureCase.root, {
      config,
      lcov: fixtureCase.lcov,
      writeBaseline: true,
      baselineContents: expected,
      instrumentChange: "d-20260927-23",
      finding: "f-20260829-04",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Coverage baseline write authorized by decision d-20260927-23 for finding f-20260829-04/,
    );
    assert.match(
      result.stdout,
      /utilities lines: 10\/20 \(50\.00%\) → 9\/18 \(50\.00%\) \[DECREASE\]/,
    );
    assert.equal(
      JSON.parse(await readFile(join(fixtureCase.root, "scratch-baseline.json"), "utf8")).areas
        .utilities.lines.covered,
      9,
    );
  });
});

test("baseline writer validates prior metrics before writing", async (t) => {
  const config = writerConfig();
  const actual = baselineMetrics(
    { covered: 1, total: 1 },
    { covered: 1, total: 1 },
    { covered: 1, total: 1 },
  );
  const valid = baselineFor(config, { utilities: actual });
  const cases = [
    {
      name: "malformed JSON",
      contents: "{bad",
      message: /Invalid prior coverage baseline at/,
    },
    {
      name: "unsupported version",
      baseline: { ...valid, version: 2 },
      message: /expected version 1 and an areas object/,
    },
    {
      name: "areas is not an object",
      baseline: { ...valid, areas: null },
      message: /expected version 1 and an areas object/,
    },
    {
      name: "an area's metric container is not an object",
      baseline: { ...valid, areas: { utilities: null } },
      message: /utilities must contain all metrics/,
    },
    {
      name: "an area has no metric object",
      baseline: {
        ...valid,
        areas: { utilities: { functions: actual.functions, branches: actual.branches } },
      },
      message: /utilities lines must have non-negative integer/,
    },
    {
      name: "covered is not numeric",
      mutate: (baseline) => {
        baseline.areas.utilities.lines.covered = "bad";
      },
      message: /utilities lines must have non-negative integer/,
    },
    {
      name: "covered is negative",
      mutate: (baseline) => {
        baseline.areas.utilities.lines.covered = -1;
      },
      message: /utilities lines must have non-negative integer/,
    },
    {
      name: "covered exceeds total",
      mutate: (baseline) => {
        baseline.areas.utilities.lines.covered = 2;
      },
      message: /utilities lines must have non-negative integer/,
    },
    {
      name: "covered is fractional",
      mutate: (baseline) => {
        baseline.areas.utilities.lines.covered = 1.5;
        baseline.areas.utilities.lines.total = 2;
      },
      message: /utilities lines must have non-negative integer/,
    },
    {
      name: "total is fractional",
      mutate: (baseline) => {
        baseline.areas.utilities.lines.covered = 1;
        baseline.areas.utilities.lines.total = 2.5;
      },
      message: /utilities lines must have non-negative integer/,
    },
    {
      name: "total is negative",
      mutate: (baseline) => {
        baseline.areas.utilities.lines.covered = 0;
        baseline.areas.utilities.lines.total = -1;
      },
      message: /utilities lines must have non-negative integer/,
    },
  ];
  for (const failureCase of cases) {
    await t.test(failureCase.name, async () => {
      let contents = failureCase.contents;
      if (contents === undefined) {
        const baseline = structuredClone(failureCase.baseline ?? valid);
        failureCase.mutate?.(baseline);
        contents = JSON.stringify(baseline);
      }
      const fixtureCase = await coverageWriterFixture({
        config,
        records: writerLcov({ utilities: actual }),
        baseline: contents,
      });
      const result = await runCoverageCli(fixtureCase.root, {
        config,
        lcov: fixtureCase.lcov,
        writeBaseline: true,
        baselineContents: contents,
      });
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, failureCase.message);
      await assertScratchBaselineUnchanged(fixtureCase.root, contents);
    });
  }
});

test("baseline writer rejects invalid authorization flag combinations", async (t) => {
  const config = writerConfig();
  const contents = "previous baseline bytes\n";
  const cases = [
    {
      name: "instrument change without a finding",
      writeBaseline: true,
      extraArgs: ["--instrument-change", "d-20260927-23"],
      message: /--instrument-change and --finding must be used together/,
    },
    {
      name: "finding without an instrument change",
      writeBaseline: true,
      extraArgs: ["--finding", "f-20260829-04"],
      message: /--instrument-change and --finding must be used together/,
    },
    {
      name: "instrument change flags without baseline write",
      writeBaseline: false,
      extraArgs: ["--instrument-change", "d-20260927-23", "--finding", "f-20260829-04"],
      message: /--instrument-change and --finding require --write-baseline/,
    },
    {
      name: "missing instrument change value",
      writeBaseline: true,
      extraArgs: ["--instrument-change"],
      message: /Missing value for --instrument-change/,
    },
    {
      name: "missing finding value",
      writeBaseline: true,
      extraArgs: ["--finding"],
      message: /Missing value for --finding/,
    },
  ];
  for (const failureCase of cases) {
    await t.test(failureCase.name, async () => {
      const fixtureCase = await coverageWriterFixture({
        config,
        records: writerLcov({
          utilities: baselineMetrics(
            { covered: 1, total: 1 },
            { covered: 1, total: 1 },
            { covered: 1, total: 1 },
          ),
        }),
        baseline: contents,
      });
      const result = await runCoverageCli(fixtureCase.root, {
        config,
        lcov: fixtureCase.lcov,
        writeBaseline: failureCase.writeBaseline,
        baselineContents: contents,
        extraArgs: failureCase.extraArgs,
      });
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, failureCase.message);
      await assertScratchBaselineUnchanged(
        fixtureCase.root,
        contents,
        failureCase.writeBaseline ? "scratch-baseline.json" : "baseline.json",
      );
    });
  }
});

test("baseline writer uses committed HEAD, disk fallback, and permits a first write", async (t) => {
  const config = writerConfig();
  const actual = baselineMetrics(
    { covered: 9, total: 18 },
    { covered: 1, total: 1 },
    { covered: 1, total: 1 },
  );
  const prior = baselineFor(config, {
    utilities: baselineMetrics(
      { covered: 10, total: 20 },
      { covered: 1, total: 1 },
      { covered: 1, total: 1 },
    ),
  });
  const priorText = JSON.stringify(prior);
  const records = writerLcov({ utilities: actual });

  await t.test("tracked HEAD remains the prior when the working copy is lower", async () => {
    const fixtureCase = await coverageWriterFixture({ config, records });
    await createScratchHead(fixtureCase.root, { "scratch-baseline.json": priorText });
    const workingCopy = JSON.stringify(
      baselineFor(config, {
        utilities: baselineMetrics(
          { covered: 1, total: 2 },
          { covered: 1, total: 1 },
          { covered: 1, total: 1 },
        ),
      }),
    );
    const result = await runCoverageCli(fixtureCase.root, {
      config,
      lcov: fixtureCase.lcov,
      writeBaseline: true,
      baselineContents: workingCopy,
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(
      result.stdout,
      /utilities lines: 10\/20 \(50\.00%\) → 9\/18 \(50\.00%\) \[DECREASE\]/,
    );
    await assertScratchBaselineUnchanged(fixtureCase.root, workingCopy);
  });

  await t.test("untracked repository path falls back to its disk baseline", async () => {
    const fixtureCase = await coverageWriterFixture({ config, records });
    await createScratchHead(fixtureCase.root);
    const diskBaseline = baselineFor(config, {
      utilities: baselineMetrics(
        { covered: 0, total: 1 },
        { covered: 0, total: 1 },
        { covered: 0, total: 1 },
      ),
    });
    await installOxfmt(fixtureCase.root, "success");
    const result = await runCoverageCli(fixtureCase.root, {
      config,
      lcov: fixtureCase.lcov,
      writeBaseline: true,
      baselineContents: JSON.stringify(diskBaseline),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Wrote coverage baseline:/);
  });

  await t.test("an absent baseline in a repository is a first write", async () => {
    const fixtureCase = await coverageWriterFixture({ config, records });
    await createScratchHead(fixtureCase.root);
    await installOxfmt(fixtureCase.root, "success");
    const result = await runCoverageCli(fixtureCase.root, {
      config,
      lcov: fixtureCase.lcov,
      writeBaseline: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Wrote coverage baseline:/);
    assert.deepEqual(
      JSON.parse(await readFile(join(fixtureCase.root, "scratch-baseline.json"), "utf8")).areas
        .utilities.lines,
      { covered: 9, total: 18 },
    );
  });
});

test("baseline writer refuses git lookup failures without touching the baseline", async (t) => {
  const config = writerConfig();
  const records = writerLcov({
    utilities: baselineMetrics(
      { covered: 1, total: 1 },
      { covered: 1, total: 1 },
      { covered: 1, total: 1 },
    ),
  });
  const priorText = JSON.stringify(
    baselineFor(config, {
      utilities: baselineMetrics(
        { covered: 1, total: 1 },
        { covered: 1, total: 1 },
        { covered: 1, total: 1 },
      ),
    }),
  );
  const cases = [
    {
      name: "rev-parse fails outside the not-a-repository case",
      setup: async (root) =>
        installGitShim(root, {
          command: "rev-parse",
          stderr: "fatal: simulated repository metadata error",
        }),
      message:
        /git rev-parse --is-inside-work-tree: status=37; stderr="fatal: simulated repository metadata error/,
    },
    {
      name: "git executable cannot be spawned",
      setup: async (root) => {
        const emptyPath = join(root, "empty-path");
        await mkdir(emptyPath, { recursive: true });
        return emptyPath;
      },
      message:
        /git rev-parse --is-inside-work-tree: status=null; stderr=""; error\.code=ENOENT; error\.message=/,
    },
  ];
  for (const failureCase of cases) {
    await t.test(failureCase.name, async () => {
      const fixtureCase = await coverageWriterFixture({ config, records, baseline: priorText });
      const extraPath = await failureCase.setup(fixtureCase.root);
      const result = await runCoverageCli(fixtureCase.root, {
        config,
        lcov: fixtureCase.lcov,
        writeBaseline: true,
        baselineContents: priorText,
        extraEnv: { PATH: extraPath },
      });
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, failureCase.message);
      await assertScratchBaselineUnchanged(fixtureCase.root, priorText);
    });
  }

  await t.test("ls-tree fails for an unborn HEAD", async () => {
    const fixtureCase = await coverageWriterFixture({ config, records, baseline: priorText });
    await gitInScratch(fixtureCase.root, ["init", "--quiet"]);
    const result = await runCoverageCli(fixtureCase.root, {
      config,
      lcov: fixtureCase.lcov,
      writeBaseline: true,
      baselineContents: priorText,
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /git ls-tree --full-name HEAD -- scratch-baseline\.json/);
    assert.match(result.stderr, /stderr="fatal:/);
    await assertScratchBaselineUnchanged(fixtureCase.root, priorText);
  });

  await t.test("ls-tree returning multiple entries refuses the ambiguous prior", async () => {
    const fixtureCase = await coverageWriterFixture({ config, records, baseline: priorText });
    await createScratchHead(fixtureCase.root);
    const path = await installGitShim(fixtureCase.root, {
      command: "ls-tree",
      status: 0,
      stdout:
        "100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tscratch-baseline.json\n" +
        "100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tscratch-baseline.json\n",
      stderr: "",
    });
    const result = await runCoverageCli(fixtureCase.root, {
      config,
      lcov: fixtureCase.lcov,
      writeBaseline: true,
      baselineContents: priorText,
      extraEnv: { PATH: path },
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /git ls-tree --full-name HEAD -- scratch-baseline\.json/);
    assert.match(result.stderr, /expected one tracked file entry; stderr=/);
    await assertScratchBaselineUnchanged(fixtureCase.root, priorText);
  });

  await t.test("ls-tree output without an entry delimiter refuses the prior", async () => {
    const fixtureCase = await coverageWriterFixture({ config, records, baseline: priorText });
    await createScratchHead(fixtureCase.root);
    const path = await installGitShim(fixtureCase.root, {
      command: "ls-tree",
      status: 0,
      stdout: "malformed ls-tree output\n",
      stderr: "",
    });
    const result = await runCoverageCli(fixtureCase.root, {
      config,
      lcov: fixtureCase.lcov,
      writeBaseline: true,
      baselineContents: priorText,
      extraEnv: { PATH: path },
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /git ls-tree --full-name HEAD -- scratch-baseline\.json/);
    assert.match(result.stderr, /expected one tracked file entry; stderr=/);
    await assertScratchBaselineUnchanged(fixtureCase.root, priorText);
  });

  await t.test(
    "show failure for a committed baseline refuses instead of falling back",
    async () => {
      const fixtureCase = await coverageWriterFixture({ config, records, baseline: priorText });
      await createScratchHead(fixtureCase.root, { "scratch-baseline.json": priorText });
      const path = await installGitShim(fixtureCase.root, {
        command: "show",
        status: 38,
        stderr: "fatal: simulated committed object failure",
      });
      const result = await runCoverageCli(fixtureCase.root, {
        config,
        lcov: fixtureCase.lcov,
        writeBaseline: true,
        baselineContents: priorText,
        extraEnv: { PATH: path },
      });
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /git show HEAD:scratch-baseline\.json/);
      assert.match(result.stderr, /stderr="fatal: simulated committed object failure/);
      await assertScratchBaselineUnchanged(fixtureCase.root, priorText);
    },
  );
});

test("scopeSignature normalises exclude through excludePatterns", () => {
  const source = {
    id: "backend",
    root: "src-tauri/src",
    include: ["src-tauri/src/**/*.rs"],
    exclude: ["src-tauri/src/db/schema.rs", { pattern: "src-tauri/src/**/mod.rs" }],
  };
  const signature = scopeSignature({
    sources: [source],
    areas: [{ id: "infra", source: "backend", paths: ["src-tauri/src/infra/**"] }],
  });
  assert.deepEqual(signature.sources[0].exclude, [
    "src-tauri/src/**/mod.rs",
    "src-tauri/src/db/schema.rs",
  ]);
});

test("scopeSignature omits absent statementFree and sorts declared paths without reasons", () => {
  const withoutStatementFree = JSON.stringify(scopeSignature(config));
  assert.doesNotMatch(withoutStatementFree, /statementFree/);
  const statementFreeConfig = withStatementFree(["src/utils/z.ts", "src/utils/a.ts"]);
  const signature = scopeSignature(statementFreeConfig);
  assert.deepEqual(signature.sources[0].statementFree, ["src/utils/a.ts", "src/utils/z.ts"]);
  assert.doesNotMatch(JSON.stringify(signature), /Fixture declaration/);
});

test("scopeSignature records test-only Rust exclusion and rejects an older scope", () => {
  const withoutExclusion = rustConfig({ exclusion: false });
  const withExclusion = rustConfig();
  const oldScope = scopeSignature(withoutExclusion);
  const nextScope = scopeSignature(withExclusion);
  assert.equal(oldScope.sources[0].excludeTestOnlyItems, undefined);
  assert.equal(nextScope.sources[0].excludeTestOnlyItems, true);
  assert.doesNotMatch(JSON.stringify(oldScope), /excludeTestOnlyItems/);
  assert.throws(
    () => assertBaseline({}, { version: 1, scope: oldScope, areas: {} }, withExclusion),
    /Coverage measurement scope changed/,
  );
});

async function branchCoverageFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "rust-branch-coverage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "src-tauri/target/llvm-cov-target");
  const dependencies = join(target, "debug/deps");
  const source = join(root, "src-tauri/src/example.rs");
  const executable = join(
    dependencies,
    `chessriddle_studio-deadbeef${process.platform === "win32" ? ".exe" : ""}`,
  );
  await mkdir(dependencies, { recursive: true });
  await mkdir(dirname(source), { recursive: true });
  await mkdir(join(root, "backend-coverage"));
  await writeFile(source, "pub fn example() {}\n");
  await writeFile(executable, "fixture executable", { mode: 0o755 });
  await writeFile(
    join(root, "backend-coverage-areas.json"),
    JSON.stringify({ sources: [{ exclude: [] }] }),
  );
  const calls = [];
  const freshProfile = join(target, "fresh.profraw");
  const runAttempt = (command, args) => {
    calls.push([command, ...args]);
    if (command === "rustup") {
      return {
        status: 0,
        stdout: args.at(-1) === "sysroot" ? root : "host: x86_64-unknown-linux-gnu\n",
      };
    }
    if (command === "cargo") writeFileSync(freshProfile, "this run");
    return {
      status: 0,
      stdout: args[0] === "export" ? `SF:${source}\nBRDA:1,0,0,1\nend_of_record\n` : "",
    };
  };
  return {
    root,
    target,
    source,
    executable,
    freshProfile,
    calls,
    options: { projectRoot: root, runAttempt },
  };
}

const listRawProfiles = (directory) => filesBelow(directory, (path) => path.endsWith(".profraw"));

async function recordBranchRejection(t, promise, expected) {
  await assert.rejects(promise, (error) => {
    if (expected instanceof RegExp) assert.match(error.message, expected);
    else if (typeof expected === "function") expected(error);
    else assert.equal(error, expected);
    t.diagnostic(`staged: rejected promise; ${error.message}`);
    return true;
  });
}

function recordBranchThrow(t, call, expected) {
  assert.throws(call, (error) => {
    if (expected instanceof RegExp) assert.match(error.message, expected);
    else assert.equal(error, expected);
    t.diagnostic(`staged: synchronous throw; ${error.message}`);
    return true;
  });
}

test("clearStaleRawProfiles removes nested regular profiles and preserves siblings and symlinks", async (t) => {
  const { root, target } = await branchCoverageFixture(t);
  const nested = join(target, "nested/stale.profraw");
  const sibling = join(target, "nested/incremental.o");
  const outside = join(root, "outside");
  await mkdir(dirname(nested));
  await mkdir(outside);
  await writeFile(nested, "stale");
  await writeFile(sibling, "keep");
  await writeFile(join(outside, "keep.profraw"), "outside");
  let symlinkCreated = false;
  try {
    await symlink(outside, join(target, "linked"), "dir");
    await symlink(join(outside, "keep.profraw"), join(target, "linked.profraw"), "file");
    symlinkCreated = true;
  } catch (error) {
    if (error.code !== "EPERM") throw error;
    t.diagnostic("EPERM creating symlink: only the symlink non-follow assertion is skipped");
  }
  await clearStaleRawProfiles(target);
  assert.equal(existsSync(nested), false);
  assert.equal(await readFile(sibling, "utf8"), "keep");
  if (symlinkCreated) {
    assert.equal(await readFile(join(outside, "keep.profraw"), "utf8"), "outside");
    assert.equal(lstatSync(join(target, "linked")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(target, "linked.profraw")).isSymbolicLink(), true);
  }
});

test("runBranchCoverage clears and refuses before Cargo, and merges only fresh profiles", async (t) => {
  const fixtureCase = await branchCoverageFixture(t);
  const { target, options, calls, freshProfile } = fixtureCase;
  const stale = join(target, "nested/stale.profraw");
  await mkdir(dirname(stale));
  await writeFile(stale, "old counts");
  await runBranchCoverage({
    ...options,
    runAttempt: (command, args, runnerOptions) => {
      if (command === "cargo") {
        assert.deepEqual(
          readdirSync(target, { recursive: true }).filter((path) => path.endsWith(".profraw")),
          [],
        );
        assert.equal(existsSync(stale), false);
        assert.equal(existsSync(freshProfile), false);
        assert.ok(args.includes("llvm-cov"));
        assert.ok(args.includes("--no-report"));
        assert.ok(!args.includes("clean"));
      }
      return options.runAttempt(command, args, runnerOptions);
    },
  });
  const merge = calls.find((call) => call[1] === "merge");
  assert.deepEqual(merge.slice(5), [freshProfile]);
  assert.match(
    await readFile(join(fixtureCase.root, "backend-coverage/lcov.info"), "utf8"),
    /^SF:/,
  );
  const script = await readFile(new URL("./rust-branch-coverage.mjs", import.meta.url), "utf8");
  assert.match(script, /async function main\(\)\s*\{\s*await runBranchCoverage\(\);\s*\}/);
});

test("runBranchCoverage rejects a survivor without starting Cargo", async (t) => {
  const { target, options, calls } = await branchCoverageFixture(t);
  const survivor = join(target, "survivor.profraw");
  let walks = 0;
  await recordBranchRejection(
    t,
    runBranchCoverage({ ...options, listProfiles: () => (++walks === 1 ? [] : [survivor]) }),
    (error) => {
      assert.match(error.message, /^Rust coverage left stale raw profiles:/);
      assert.ok(error.message.includes(survivor));
    },
  );
  assert.equal(walks, 2);
  assert.equal(
    calls.some(([command]) => command === "cargo"),
    false,
  );
  assert.ok(resolve(survivor) === survivor);
});

test("assertNoStaleRawProfiles reports all absolute survivors in sorted order without deleting", async (t) => {
  const { target } = await branchCoverageFixture(t);
  const paths = [join(target, "z.profraw"), join(target, "a.profraw")];
  for (const path of paths) await writeFile(path, "keep");
  await assert.rejects(assertNoStaleRawProfiles(target), {
    message: `Rust coverage left stale raw profiles: ${[...paths].sort().join(", ")}`,
  });
  for (const path of paths) assert.equal(await readFile(path, "utf8"), "keep");
});

test("a missing coverage root succeeds on both pre-Cargo walks and still reaches Cargo", async (t) => {
  const { target, options, calls } = await branchCoverageFixture(t);
  await rm(target, { recursive: true });
  await clearStaleRawProfiles(target);
  await assertNoStaleRawProfiles(target);
  const stoppedAtCargo = new Error("missing root reached cargo llvm-cov");
  await recordBranchRejection(
    t,
    runBranchCoverage({
      ...options,
      runAttempt: (command, args) => {
        if (command === "cargo") {
          calls.push([command, ...args]);
          throw stoppedAtCargo;
        }
        return options.runAttempt(command, args);
      },
    }),
    stoppedAtCargo,
  );
  assert.ok(calls.some(([command, ...args]) => command === "cargo" && args.includes("llvm-cov")));
});

test("nested readdir ENOENT rejects on the clear and refusal walks without starting Cargo", async (t) => {
  for (const failedWalk of [1, 2]) {
    await t.test(`walk ${failedWalk}`, async (t) => {
      const { target, options, calls } = await branchCoverageFixture(t);
      const nested = join(target, "disappeared");
      await mkdir(nested);
      await rm(nested, { recursive: true });
      let walks = 0;
      await recordBranchRejection(
        t,
        runBranchCoverage({
          ...options,
          listProfiles: (directory) => {
            assert.equal(directory, target);
            // Stage the readdir error from a descendant that disappeared after
            // enumeration, using the real walker on that now-missing directory.
            return ++walks === failedWalk ? listRawProfiles(nested) : listRawProfiles(directory);
          },
        }),
        /ENOENT:.*scandir/,
      );
      assert.equal(walks, failedWalk);
      assert.equal(existsSync(target), true);
      assert.equal(
        calls.some(([command]) => command === "cargo"),
        false,
      );
    });
  }
});

test("removal and unreadable pre-Cargo walks record filesystem messages and rejections", async (t) => {
  for (const mode of ["unlink", "clear walk", "refusal walk"]) {
    await t.test(mode, async (t) => {
      const { target, options, calls } = await branchCoverageFixture(t);
      await writeFile(join(target, "stale.profraw"), "stale");
      let walks = 0;
      if (mode === "unlink") await chmod(target, 0o555);
      else if (mode === "clear walk") await chmod(target, 0);
      try {
        await recordBranchRejection(
          t,
          runBranchCoverage({
            ...options,
            listProfiles: async (directory) => {
              if (mode === "refusal walk" && ++walks === 2) await chmod(directory, 0);
              return listRawProfiles(directory);
            },
          }),
          mode === "unlink" ? /EACCES:.*unlink/ : /EACCES:.*scandir/,
        );
        assert.equal(
          calls.some(([command]) => command === "cargo"),
          false,
        );
      } finally {
        await chmod(target, 0o755);
      }
    });
  }
});

test("entrypoint tool-resolution failure exits 1 and leaves the planted profile set unchanged", async (t) => {
  const scratchRoot = await mkdtemp(join(tmpdir(), "coverage-no-rustup-"));
  t.after(() => rm(scratchRoot, { recursive: true, force: true }));
  const emptyPath = join(scratchRoot, "empty-path");
  const coverageTarget = resolve(scratchRoot, "src-tauri/target/llvm-cov-target");
  await mkdir(emptyPath);
  await mkdir(coverageTarget, { recursive: true });
  const entrypoint = await copyRustCoverageEntrypoint(scratchRoot);
  const planted = join(coverageTarget, "staged-tool-failure.profraw");
  const plantedBytes = Buffer.from("staged input");
  // Exclusive creation ensures this scratch root owns precisely the planted file.
  await writeFile(planted, plantedBytes, { flag: "wx" });
  const before = (await listRawProfiles(coverageTarget)).sort();
  assert.deepEqual(before, [planted]);
  const result = spawnSync(process.execPath, [entrypoint], {
    cwd: scratchRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: emptyPath },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /spawnSync rustup ENOENT/);
  assert.deepEqual((await listRawProfiles(coverageTarget)).sort(), before);
  assert.deepEqual(await readFile(planted), plantedBytes);
  t.diagnostic(
    "staged: copied entrypoint exit 1; spawnSync rustup ENOENT; private profile set and bytes unchanged",
  );
});

test("command failures are staged through runBranchCoverage's command runner", async (t) => {
  for (const stage of ["rustup", "cargo", "merge"]) {
    for (const failure of ["spawn", "signal", "status"]) {
      await t.test(`${stage}: ${failure}`, async (t) => {
        const { options } = await branchCoverageFixture(t);
        const spawnError = new Error(`spawn ${stage} ENOENT`);
        const result =
          failure === "spawn"
            ? { status: null, error: spawnError }
            : failure === "signal"
              ? { status: null, signal: "SIGTERM" }
              : { status: 23, stderr: `staged ${stage} stderr\n` };
        await recordBranchRejection(
          t,
          runBranchCoverage({
            ...options,
            runAttempt: (command, args) => {
              if ((stage === "merge" && args[0] === "merge") || command === stage) return result;
              return options.runAttempt(command, args);
            },
          }),
          failure === "spawn"
            ? spawnError
            : failure === "signal"
              ? /died with SIGTERM:/
              : /exited with status 23/,
        );
      });
    }
  }
});

test("runBranchCoverage stages every filesystem, config, and evidence refusal", async (t) => {
  const cases = [
    [
      "no raw profiles",
      /^Rust coverage produced no raw profiles$/,
      async (f) => ({
        runAttempt: (command, args) =>
          command === "cargo" ? { status: 0 } : f.options.runAttempt(command, args),
      }),
    ],
    [
      "post-Cargo walk",
      /ENOTDIR:.*scandir/,
      async (f) => {
        const notDirectory = join(f.root, "not-directory");
        await writeFile(notDirectory, "file");
        let walks = 0;
        return {
          listProfiles: (directory) =>
            ++walks === 3 ? listRawProfiles(notDirectory) : listRawProfiles(directory),
        };
      },
    ],
    [
      "dependencies readdir",
      /ENOENT:.*scandir/,
      async (f) => ({ dependencies: join(f.target, "missing-deps") }),
    ],
    [
      "executable stat",
      /EACCES:.*stat/,
      async (f) => {
        // Directory names remain readable, but looking up an entry requires search permission.
        await chmod(dirname(f.executable), 0o444);
        return {};
      },
    ],
    [
      "missing executable",
      /^Rust coverage test executable was not found$/,
      async (f) => {
        await unlinkFile(f.executable);
        return {};
      },
    ],
    [
      "config read",
      /ENOENT:.*open/,
      async (f) => ({ coverageConfigPath: join(f.root, "missing-config.json") }),
    ],
    [
      "config JSON",
      /JSON|property name/,
      async (f) => {
        await writeFile(join(f.root, "backend-coverage-areas.json"), "{ invalid");
        return {};
      },
    ],
    [
      "source walk",
      /ENOENT:.*scandir/,
      async (f) => {
        await rm(dirname(f.source), { recursive: true });
        return {};
      },
    ],
    [
      "empty sources",
      /^Rust coverage found no sources to export$/,
      async (f) => {
        await unlinkFile(f.source);
        return {};
      },
    ],
    [
      "empty export",
      /^Rust branch coverage export was empty$/,
      async (f) => ({
        runAttempt: (command, args) =>
          args[0] === "export" ? { status: 0, stdout: "" } : f.options.runAttempt(command, args),
      }),
    ],
    [
      "output write",
      /ENOENT:.*open/,
      async (f) => ({ outputPath: join(f.root, "absent/lcov.info") }),
    ],
    [
      "no branches",
      /^Rust coverage export contains no branch data$/,
      async (f) => ({
        runAttempt: (command, args) =>
          args[0] === "export"
            ? { status: 0, stdout: `SF:${f.source}\n` }
            : f.options.runAttempt(command, args),
      }),
    ],
  ];
  for (const [name, expected, setup] of cases) {
    await t.test(name, async (t) => {
      const fixtureCase = await branchCoverageFixture(t);
      const overrides = await setup(fixtureCase);
      try {
        await recordBranchRejection(
          t,
          runBranchCoverage({ ...fixtureCase.options, ...overrides }),
          expected,
        );
      } finally {
        if (name === "executable stat") await chmod(dirname(fixtureCase.executable), 0o755);
      }
    });
  }
  for (const contents of [
    null,
    {},
    { sources: {} },
    { sources: [null] },
    { sources: [{}] },
    { sources: [{ exclude: {} }] },
    { sources: [{ exclude: [null] }] },
    { sources: [{ exclude: [{}] }] },
  ]) {
    await t.test(`config shape ${JSON.stringify(contents)}`, async (t) => {
      const fixtureCase = await branchCoverageFixture(t);
      await writeFile(
        join(fixtureCase.root, "backend-coverage-areas.json"),
        JSON.stringify(contents),
      );
      await recordBranchRejection(
        t,
        runBranchCoverage(fixtureCase.options),
        /Cannot read properties|is not a function/,
      );
    });
  }
});

test("exportLcovOrDiagnose stages spawn, exit-status, and undiagnosed signal throws", (t) => {
  const spawnError = new Error("spawn llvm-cov ENOENT");
  for (const [result, expected] of [
    [{ status: null, error: spawnError }, spawnError],
    [
      { status: 23, stderr: "staged llvm-cov stderr\n" },
      /llvm-cov died with status 23 while exporting LCOV/,
    ],
    [{ status: null, signal: "SIGSEGV" }, /llvm-cov died with SIGSEGV while exporting LCOV/],
  ]) {
    let calls = 0;
    recordBranchThrow(
      t,
      () =>
        exportLcovOrDiagnose(
          () => (++calls === 1 ? result : { status: 0 }),
          "llvm-cov",
          "/tmp/profile",
          "/tmp/executable",
          ["source.rs"],
        ),
      expected,
    );
  }
});

test("coverage tools follow the pinned compiler host, including Windows tool suffixes", () => {
  for (const host of [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "aarch64-apple-darwin",
    "x86_64-pc-windows-msvc",
  ]) {
    const sysroot = resolve("toolchain with spaces");
    const calls = [];
    const tools = coverageTools((command, args) => {
      calls.push([command, ...args]);
      return args.at(-1) === "sysroot"
        ? `${sysroot}\n`
        : `rustc 1.89.0-nightly\r\nhost: ${host}\r\nrelease: 1.89.0-nightly\r\n`;
    });
    const suffix = host.includes("-windows-") ? ".exe" : "";
    assert.deepEqual(tools, {
      llvmProfdata: resolve(sysroot, "lib/rustlib", host, "bin", `llvm-profdata${suffix}`),
      llvmCov: resolve(sysroot, "lib/rustlib", host, "bin", `llvm-cov${suffix}`),
    });
    assert.deepEqual(calls, [
      ["rustup", "run", RUST_COVERAGE_TOOLCHAIN, "rustc", "--print", "sysroot"],
      ["rustup", "run", RUST_COVERAGE_TOOLCHAIN, "rustc", "-vV"],
    ]);
  }
});

test("coverage tools refuse invalid metadata and propagate command errors", (t) => {
  for (const version of [
    "rustc 1.89.0",
    "host: ",
    "host: ../../other",
    "host: aarch64-apple-darwin extra",
  ]) {
    recordBranchThrow(
      t,
      () => coverageTools((_command, args) => (args.at(-1) === "sysroot" ? "/rust" : version)),
      /Cannot determine sysroot and host/,
    );
  }
  recordBranchThrow(t, () => coverageTools(() => ""), /Cannot determine sysroot and host/);
  recordBranchThrow(
    t,
    () =>
      coverageTools((_command, args) =>
        args.at(-1) === "sysroot" ? "\n" : "host: x86_64-unknown-linux-gnu\n",
      ),
    /Cannot determine sysroot and host/,
  );
  const failure = new Error("pinned toolchain missing");
  recordBranchThrow(
    t,
    () =>
      coverageTools(() => {
        throw failure;
      }),
    failure,
  );
});

test("coverage executable selection respects native naming and file types", () => {
  const file = { isFile: () => true, mode: 0o644 };
  assert.equal(isCoverageExecutable("chessriddle_studio-deadbeef.exe", file, "win32"), true);
  assert.equal(isCoverageExecutable("chessriddle_studio-deadbeef", file, "linux"), false);
  assert.equal(
    isCoverageExecutable("chessriddle_studio-deadbeef", { ...file, mode: 0o755 }, "linux"),
    true,
  );
  for (const name of [
    "chessriddle_studio-deadbeef.d",
    "chessriddle_studio-deadbeef.pdb",
    "chessriddle_studio-deadbeef.exe",
  ]) {
    assert.equal(isCoverageExecutable(name, { ...file, mode: 0o755 }, "linux"), false);
  }
  assert.equal(
    isCoverageExecutable(
      "chessriddle_studio-deadbeef.exe",
      { ...file, isFile: () => false },
      "win32",
    ),
    false,
  );
});

test("bulk llvm-cov export and the crash probe share one argument builder", () => {
  const profilePath = "/tmp/src-tauri.profdata";
  const executable = "/tmp/chessriddle_studio-deadbeef";
  const sources = ["/repo/src-tauri/src/chess.rs", "/repo/src-tauri/src/game.rs"];
  const bulk = llvmCovExportArgs(profilePath, executable, sources);
  const probe = llvmCovExportArgs(profilePath, executable, [sources[0]]);
  assert.deepEqual(bulk.slice(0, 5), [
    "export",
    "-format=lcov",
    `-instr-profile=${profilePath}`,
    executable,
    "-sources",
  ]);
  assert.deepEqual(bulk.slice(0, 5), probe.slice(0, 5));
  assert.deepEqual(bulk.slice(5), sources);
  assert.deepEqual(probe.slice(5), [sources[0]]);
});

test("bulk export diagnoses crashes with the shared argv", (t) => {
  const profilePath = "/tmp/src-tauri.profdata";
  const executable = "/tmp/chessriddle_studio-deadbeef";
  const sources = ["src-tauri/src/chess.rs", "src-tauri/src/db/schema.rs"];
  const calls = [];
  const attempt = (_command, argumentsList) => {
    calls.push(argumentsList);
    const exportedSources = argumentsList.slice(argumentsList.indexOf("-sources") + 1);
    if (exportedSources.includes("src-tauri/src/db/schema.rs")) {
      return { signal: "SIGSEGV", status: null };
    }
    return { signal: null, status: 0, stdout: "SF:ok\n" };
  };
  recordBranchThrow(
    t,
    () => exportLcovOrDiagnose(attempt, "llvm-cov", profilePath, executable, sources),
    /llvm-cov segfaulted while exporting these sources:\n  src-tauri\/src\/db\/schema\.rs/,
  );
  assert.deepEqual(calls[0], llvmCovExportArgs(profilePath, executable, sources));
});

test("signal diagnostic names the crashing source without a retracted cause", () => {
  const attempt = (_command, argumentsList) => {
    const source = argumentsList.at(-1);
    return source === "src-tauri/src/db/schema.rs"
      ? { signal: "SIGSEGV", status: null }
      : { signal: null, status: 0 };
  };
  const sources = ["src-tauri/src/chess.rs", "src-tauri/src/db/schema.rs"];
  const offenders = probeCrashingSources(
    attempt,
    "llvm-cov",
    "/tmp/src-tauri.profdata",
    "/tmp/chessriddle_studio-deadbeef",
    sources,
  );
  assert.deepEqual(offenders, ["src-tauri/src/db/schema.rs"]);
  const message = formatExportCrashMessage(offenders, (source) => source);
  assert.match(message, /src-tauri\/src\/db\/schema\.rs/);
  assert.match(message, /llvm\/llvm-project#119558/);
  assert.doesNotMatch(message, /no coverage records/);
});

test("matches exclude entries as globs, not as exact paths", () => {
  // Both coverage-report.mjs and rust-branch-coverage.mjs honour these as globs
  // through coverage-scope.mjs. A literal-path comparison would silently exclude
  // nothing, and the file would reach llvm-cov -sources.
  const source = { exclude: [{ pattern: "src-tauri/src/**/mod.rs" }] };
  assert.equal(excluded("src-tauri/src/infra/mod.rs", source), true);
  assert.equal(excluded("src-tauri/src/db/mod.rs", source), true);
  assert.equal(excluded("src-tauri/src/chess.rs", source), false);
});

test("accepts exclude entries written as bare strings or as objects", () => {
  assert.deepEqual(excludePatterns({ exclude: ["a/b.rs", { pattern: "c/**" }] }), [
    "a/b.rs",
    "c/**",
  ]);
  assert.equal(excluded("c/d/e.rs", { exclude: ["a/b.rs", { pattern: "c/**" }] }), true);
});

test("anchors globs and keeps a single star inside one path segment", () => {
  assert.equal(globToRegExp("src/*.ts").test("src/a.ts"), true);
  assert.equal(globToRegExp("src/*.ts").test("src/nested/a.ts"), false);
  assert.equal(globToRegExp("src/**/a.ts").test("src/a.ts"), true);
  assert.equal(matches("src/a.ts", ["nope/**", "src/*.ts"]), true);
  assert.equal(matches("src/a.ts", []), false);
});

test("normalises paths to repo-relative POSIX form for matching", () => {
  const root = sep === "/" ? "/tmp/repo" : "C:\\repo";
  assert.equal(normalisePath(join(root, "src", "a.ts"), root), "src/a.ts");
  assert.equal(normalisePath("src/a.ts", root), "src/a.ts");
});
