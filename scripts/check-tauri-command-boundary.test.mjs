import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  NATIVE_EXPORT_ALLOWLIST,
  inspectCapability,
  inspectCsp,
  inspectSource,
  runTauriBoundaryCheck,
} from "./check-tauri-command-boundary.mjs";
import { listWorkingTreeFiles } from "./working-tree-files.mjs";

const REPOSITORY_ROOT = process.cwd();
const CHECKER = join(REPOSITORY_ROOT, "scripts/check-tauri-command-boundary.mjs");
const NATIVE_SOURCE = readFileSync(join(REPOSITORY_ROOT, "src/platform/native.ts"), "utf8");
const VALID_SECURITY_CONFIG = JSON.stringify({
  app: {
    security: {
      csp: "default-src self",
    },
  },
});
const temporaryRoots = [];
const UPDATER_SPECIFIER = "@tauri-apps/plugin-updater";
const TAURI_PATHS = ["components/probe.ts", "bindings/generated.ts"];
const REACH = ["direct @tauri-apps module access"];
const BROKEN_PARSE_MESSAGE =
  "Cannot parse src/broken.ts: Unexpected token (1:6)\n\n> 1 | const = ;\n    |       ^";

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function expectViolation(path, source, message, options) {
  expect(inspectSource(path, source, options)).toEqual(
    expect.arrayContaining([expect.stringMatching(message)]),
  );
}

function expectReach(path, source) {
  expect(inspectSource(path, source)).toEqual(REACH);
}

function expectSilent(path, source) {
  expect(inspectSource(path, source)).toEqual([]);
}

function expectUnresolvable(path, source) {
  const violations = inspectSource(path, source);
  expect(
    violations.some((message) => message.includes("module specifier is not statically resolvable")),
  ).toBe(true);
  expect(violations).not.toContain("direct @tauri-apps module access");
}

describe("module reference positions", () => {
  test.each([
    ["named import", `import { check } from "${UPDATER_SPECIFIER}";`],
    ["type-only import", `import type { Update } from "${UPDATER_SPECIFIER}";`],
    ["side-effect import", `import "${UPDATER_SPECIFIER}";`],
    ["export from", `export { check } from "${UPDATER_SPECIFIER}";`],
    ["import equals require", `import x = require("${UPDATER_SPECIFIER}");`],
    ["import type equals require", `import type x = require("${UPDATER_SPECIFIER}");`],
    ["dynamic import", `await import("${UPDATER_SPECIFIER}");`],
    ["require", `require("${UPDATER_SPECIFIER}");`],
    ["typeof import", `type T = typeof import("${UPDATER_SPECIFIER}");`],
    ["vi.mock string", `vi.mock("${UPDATER_SPECIFIER}");`],
    ["vi.doMock string", `vi.doMock("${UPDATER_SPECIFIER}");`],
    ["vi.unmock string", `vi.unmock("${UPDATER_SPECIFIER}");`],
    ["vi.doUnmock string", `vi.doUnmock("${UPDATER_SPECIFIER}");`],
    ["vi.importActual string", `vi.importActual("${UPDATER_SPECIFIER}");`],
    ["vi.importMock string", `vi.importMock("${UPDATER_SPECIFIER}");`],
    ["vi.mock module-promise", `vi.mock(import("${UPDATER_SPECIFIER}"));`],
    ["wrapped vi.mock", `(vi as any).mock("${UPDATER_SPECIFIER}");`],
    ["computed vi.mock", `vi["mock"]("${UPDATER_SPECIFIER}");`],
    ["dynamic import comment", `await import(/* c */ "${UPDATER_SPECIFIER}");`],
    ["require template", `require(\`${UPDATER_SPECIFIER}\`);`],
    ["require comment", `require(/* c */ "${UPDATER_SPECIFIER}");`],
    ["vi.mock template", `vi.mock(\`${UPDATER_SPECIFIER}\`);`],
    ["vi.mock comment", `vi.mock(/* c */ "${UPDATER_SPECIFIER}");`],
    ["dynamic import CR comment", `const m = await import(// c\r"${UPDATER_SPECIFIER}");`],
    ["side-effect import comment", `import /* c */ "${UPDATER_SPECIFIER}";`],
    ["from comment", `import { check } from /* c */ "${UPDATER_SPECIFIER}";`],
    ["require between tokens", `const m = require /* c */ ("${UPDATER_SPECIFIER}");`],
    ["import between tokens", `const m = await import /* c */ ("${UPDATER_SPECIFIER}");`],
    ["vi.mock between tokens", `vi.mock /* c */ ("${UPDATER_SPECIFIER}");`],
    ["import newline comment", `const m = await import\n// c\n("${UPDATER_SPECIFIER}");`],
    ["vi comment member", `vi /* c */ .mock("${UPDATER_SPECIFIER}");`],
    ["vi spaced member", `vi . mock("${UPDATER_SPECIFIER}");`],
    ["substitution-free import template", `await import(\`${UPDATER_SPECIFIER}\`);`],
  ])("%s reaches on both paths", (_name, source) => {
    for (const path of TAURI_PATHS) expectReach(path, source);
  });
});

describe("non-code text is silent", () => {
  test.each([
    ["line comment", `// we do not use ${UPDATER_SPECIFIER} here`],
    ["block comment", `/* import { check } from "${UPDATER_SPECIFIER}" */`],
    ["string literal", `const msg = "install ${UPDATER_SPECIFIER}";`],
    ["template literal", "const msg = `install @tauri-apps/plugin-updater`;"],
    ["regex literal", "const pattern = /@tauri-apps\\/plugin-updater/;"],
    ["includes probe", 'source.includes("@tauri-apps/plugin-updater")'],
  ])("%s", (_name, source) => {
    for (const path of TAURI_PATHS) expectSilent(path, source);
  });

  test("JSX text on a .tsx path is silent", () => {
    expectSilent(
      "components/probe.tsx",
      `export default function Probe() { return <div>${UPDATER_SPECIFIER}</div>; }`,
    );
  });
});

describe("parse scope", () => {
  test("a .jsx path holding JSX and no Tauri reference is silent", () => {
    expectSilent(
      "components/probe.jsx",
      "export default function Probe() { return <div>hello</div>; }",
    );
  });
});

describe("specifier resolution", () => {
  test.each([
    ["concatenation", 'await import("@tauri-apps/" + "plugin-updater")'],
    ["interpolated template", 'await import(`${"@tauri-apps/plugin-updater"}`)'],
    ["const binding", `const p = "${UPDATER_SPECIFIER}"; import(p)`],
    ["const as const", `const p = "${UPDATER_SPECIFIER}" as const; import(p)`],
    ["two-step alias", `const a = "${UPDATER_SPECIFIER}"; const b = a; import(b)`],
    [
      "repeated const in concatenation",
      'const a = "a"; import("@t" + a + "uri-" + a + "pps/plugin-updater")',
    ],
  ])("%s reaches on both paths", (_name, source) => {
    for (const path of TAURI_PATHS) expectReach(path, source);
  });

  test("constant-bound non-Tauri imports are silent", () => {
    expectSilent("foo.ts", 'const p = "@/platform/native" as const; import(p)');
    expectSilent("foo.ts", 'const p = "../translation/x.json"; import(p)');
  });
});

describe("known limits", () => {
  test.each([
    ["parameter", "function load(s) { return import(s); }"],
    ["defaulted parameter", 'function load(s = "./local") { return import(s); }'],
    [
      "alias of a defaulted parameter",
      'function load(s = "./local") { const p = s; return import(p); }',
    ],
    ["interpolated Tauri template", "import(`@tauri-apps/${name}`)"],
    ["concatenation with a name", 'import("@tauri-" + name)'],
    ["reassigned let", `let p = "${UPDATER_SPECIFIER}"; p = "other"; import(p)`],
  ])("%s is unresolvable on both paths", (_name, source) => {
    for (const path of TAURI_PATHS) expectUnresolvable(path, source);
  });

  test("a zero-argument require reports the call text and line", () => {
    expect(inspectSource("components/probe.ts", "require()")).toEqual([
      "module specifier is not statically resolvable: require() (line 1)",
    ]);
  });

  test("a zero-argument vi.mock reports the call text and line", () => {
    expect(inspectSource("components/probe.ts", "vi.mock()")).toEqual([
      "module specifier is not statically resolvable: vi.mock() (line 1)",
    ]);
  });

  test("a parameter specifier reports the exact unresolvable message", () => {
    expect(inspectSource("components/probe.ts", "function load(s) { return import(s); }")).toEqual([
      "module specifier is not statically resolvable: s (line 1)",
    ]);
  });

  test("an unresolvable specifier on line 2 reports that line", () => {
    expect(inspectSource("components/probe.ts", "const x = 1;\nimport(s)")).toEqual([
      "module specifier is not statically resolvable: s (line 2)",
    ]);
  });

  test.each([
    ["self-referential concatenation", 'var p = p + "x"; import(p)'],
    ["self-referential template", "const p = `${p}/x`; import(p)"],
    ["mutual concatenation", 'let a = b + "x"; let b = a + "y"; import(a)'],
  ])("%s is unresolvable and does not throw", (_name, source) => {
    expect(() => inspectSource("components/probe.ts", source)).not.toThrow();
    expectUnresolvable("components/probe.ts", source);
  });

  test("a locale translation import is silent", () => {
    expectSilent("foo.ts", "import(`../translation/${locale}.json`)");
  });

  test("an unresolved relative bindings path is the generated-rule known limit", () => {
    const source = "import(`../bindings/${name}`)";
    expectSilent("foo.ts", source);
    expectSilent("bindings/generated.ts", source);
  });
});

describe("source boundary forms", () => {
  test.each([
    ["from a plugin", "foo.ts", 'import { platform } from "@tauri-apps/plugin-os"', /@tauri-apps/],
    ["from the root API", "foo.ts", 'import { event } from "@tauri-apps/api"', /@tauri-apps/],
    ["dynamic import", "foo.ts", 'await import("@tauri-apps/api/core")', /@tauri-apps/],
    ["require", "foo.ts", 'require("@tauri-apps/api/event")', /@tauri-apps/],
    ["side-effect import", "foo.ts", 'import "@tauri-apps/plugin-os"', /@tauri-apps/],
    ["Vitest mock", "foo.test.ts", 'vi.mock("@tauri-apps/plugin-os", () => ({}))', /@tauri-apps/],
    [
      "generated type import",
      "foo.ts",
      'import type { Score } from "@/bindings/generated"',
      /bindings\/generated/,
    ],
    [
      "generated dynamic import",
      "foo.ts",
      'await import("@/bindings/generated")',
      /bindings\/generated/,
    ],
    [
      "generated side-effect import",
      "foo.ts",
      'import "@/bindings/generated"',
      /bindings\/generated/,
    ],
    ["generated require", "foo.ts", 'require("@/bindings/generated")', /bindings\/generated/],
    [
      "commands barrel import",
      "foo.ts",
      'import { commands } from "@/bindings"',
      /commands\/events/,
    ],
    [
      "mixed commands barrel import",
      "foo.ts",
      'import { commands, type events } from "@/bindings"',
      /commands\/events/,
    ],
    ["bare listen", "foo.ts", 'listen("x", cb)', /raw listen/],
    ["object listen", "foo.ts", "events.foo.listen(cb)", /raw \.listen/],
    ["computed listen", "foo.ts", 'obj["listen"](cb)', /raw \.listen/],
    ["optional object listen", "foo.ts", "events.foo?.listen(cb)", /raw \.listen/],
    ["optional listen method", "foo.ts", "events.foo.listen?.(cb)", /raw \.listen/],
    ["optional bare listen", "foo.ts", 'listen?.("x", cb)', /raw listen/],
    ["tauriEvents", "foo.ts", "tauriEvents.foo", /tauriEvents/],
    ["optional tauriEvents", "foo.ts", "tauriEvents?.foo", /tauriEvents/],
    [
      "Tauri facade native import",
      "platform/tauri.ts",
      'import { anything } from "@tauri-apps/plugin-fs"',
      /@tauri-apps/,
    ],
    [
      "generated typeof import",
      "foo.ts",
      'type T = typeof import("@/bindings/generated")',
      /bindings\/generated/,
    ],
  ])("rejects %s", (_name, path, source, message) => {
    expectViolation(path, source, message);
  });

  test.each([
    [
      "Tauri facade generated bindings and listeners",
      "platform/tauri.ts",
      'import { commands, events } from "@/bindings/generated"; events.foo.listen(cb)',
    ],
    [
      "generated binding Tauri imports and event proxy listeners",
      "bindings/generated.ts",
      'import { invoke } from "@tauri-apps/api/core";\n' +
        'import { listen as eventListen } from "@tauri-apps/api/event";\n' +
        'import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";\n' +
        "window.listen(name, arg);\nTAURI_API_EVENT.listen(name, arg);",
    ],
    [
      "a dependency-name string",
      "platform/fork-updater.test.ts",
      'source.includes("@tauri-apps/plugin-updater")',
    ],
    ["a type-only barrel import", "foo.ts", 'import type { Score } from "@/bindings"'],
    ["a WebviewWindow listener", "components/TopBar.tsx", "appWindow.onResized(() => {})"],
    [
      "a generated-bindings mock",
      "foo.test.ts",
      'vi.mock("@/bindings/generated", () => ({ commands: {}, events: {} }))',
    ],
    [
      "a generated-bindings module-promise mock",
      "foo.test.ts",
      'vi.mock(import("@/bindings/generated"))',
    ],
    ["a listen declaration", "foo.ts", "function listen() {}"],
    ["listen in a comment", "foo.ts", "// listen(\nconst x = 1;"],
    ["listen in a string", "foo.ts", 'const msg = "listen(cb)";'],
    [".listen in a comment", "foo.ts", "// foo.listen(\nconst x = 1;"],
    [".listen in a string", "foo.ts", 'const msg = ".listen(cb)";'],
    ["tauriEvents in a comment", "foo.ts", "// tauriEvents.foo\nconst x = 1;"],
    ["tauriEvents in a string", "foo.ts", 'const msg = "tauriEvents.foo";'],
  ])("allows %s", (_name, path, source) => {
    expect(inspectSource(path, source)).toEqual([]);
  });
});

describe("native facade contract", () => {
  test("accepts today's exact native facade", () => {
    expect(inspectSource("platform/native.ts", NATIVE_SOURCE)).toEqual([]);
  });

  test("accepts a comment after from in a native re-export", () => {
    const withComment = NATIVE_SOURCE.replace(
      'export { check, type Update } from "@tauri-apps/plugin-updater";',
      'export { check, type Update } from /* c */ "@tauri-apps/plugin-updater";',
    );
    expect(inspectSource("platform/native.ts", withComment)).toEqual([]);
  });

  test("accepts a commented-out listen re-export on the native facade", () => {
    expect(
      inspectSource(
        "platform/native.ts",
        `${NATIVE_SOURCE}\n// export { listen } from "@tauri-apps/api/event"\n`,
      ),
    ).toEqual([]);
  });

  test.each([
    ["listen re-export", 'export { listen } from "@tauri-apps/api/event"', /denylist.*listen/],
    ["dynamic import", 'await import("@tauri-apps/api/event")', /named Tauri re-exports/],
    ["require", 'require("@tauri-apps/api/event")', /named Tauri re-exports/],
    ["Vitest mock", 'vi.mock("@tauri-apps/plugin-os", () => ({}))', /named Tauri re-exports/],
    [
      "root API export",
      'export { event as tauriEvents } from "@tauri-apps/api"',
      /denylist.*event as tauriEvents/,
    ],
    ["export star", 'export * from "@tauri-apps/plugin-fs"', /export star.*plugin-fs/],
    [
      "namespaced export star",
      'export * as fs from "@tauri-apps/plugin-fs"',
      /export star.*plugin-fs/,
    ],
    [
      "namespaced menu export star",
      'export * as ns from "@tauri-apps/api/menu"',
      /export star.*@tauri-apps\/api\/menu/,
    ],
    [
      "aliased invoke",
      'export { invoke as convertFileSrc } from "@tauri-apps/api/core"',
      /denylist.*invoke as convertFileSrc/,
    ],
    [
      "invoke beside the allowed export",
      'export { invoke, convertFileSrc } from "@tauri-apps/api/core"',
      /denylist.*invoke/,
    ],
    ["dynamic plugin import", 'await import("@tauri-apps/plugin-os")', /named Tauri re-exports/],
  ])("rejects %s", (_name, source, message) => {
    expectViolation("platform/native.ts", source, message);
  });

  test("keeps the denylist independent from the allowlist", () => {
    const listen = {
      specifier: "@tauri-apps/api/event",
      exported: "listen",
      local: "listen",
    };
    expectViolation(
      "platform/native.ts",
      'export { listen } from "@tauri-apps/api/event"',
      /denylist.*listen/,
      { allowlist: [listen] },
    );
  });

  test("rejects a non-denylisted extra export", () => {
    expectViolation(
      "platform/native.ts",
      `${NATIVE_SOURCE}\nexport { installUpdate } from "@tauri-apps/plugin-updater";`,
      /not allowlisted.*installUpdate/,
    );
  });

  test("rejects an empty named re-export of a denylisted module", () => {
    expectViolation(
      "platform/native.ts",
      `${NATIVE_SOURCE}\nexport {} from "@tauri-apps/plugin-fs";\n`,
      /named Tauri re-exports/,
    );
  });

  test("rejects a missing allowlisted export", () => {
    const withoutExit = NATIVE_SOURCE.replace(
      'export { exit, relaunch } from "@tauri-apps/plugin-process";\n',
      'export { relaunch } from "@tauri-apps/plugin-process";\n',
    );
    expectViolation("platform/native.ts", withoutExit, /missing.*plugin-process:exit/);
  });

  test("parses type-as and renamed type exports exactly", () => {
    const osEntries = NATIVE_EXPORT_ALLOWLIST.filter(
      ({ specifier }) => specifier === "@tauri-apps/plugin-os",
    );
    expect(osEntries).toEqual(
      expect.arrayContaining([
        { specifier: "@tauri-apps/plugin-os", exported: "type", local: "osType" },
        { specifier: "@tauri-apps/plugin-os", exported: "version", local: "OSVersion" },
      ]),
    );
    expect(inspectSource("platform/native.ts", NATIVE_SOURCE)).toEqual([]);
  });
});

describe("parse failure", () => {
  test("runTauriBoundaryCheck throws Cannot parse for broken renderer source", () => {
    expect(() =>
      runTauriBoundaryCheck({
        workspaceRoot: "/fixture",
        listFiles: () => ["src/broken.ts", "src/platform/native.ts"],
        readFile: (path) => {
          if (path.endsWith("broken.ts")) return "const = ;";
          if (path.endsWith("native.ts")) return NATIVE_SOURCE;
          if (path.endsWith("main.json")) return '{"permissions":[]}';
          return VALID_SECURITY_CONFIG;
        },
      }),
    ).toThrow(
      /^Cannot parse src\/broken\.ts: Unexpected token \(1:6\)\n\n> 1 \| const = ;\n    \|       \^$/,
    );
  });

  test("does not relabel a non-parse error as Cannot parse", () => {
    let caught;
    try {
      runTauriBoundaryCheck({
        workspaceRoot: "/fixture",
        listFiles: () => ["src/probe.ts", "src/platform/native.ts"],
        readFile: (path) => {
          if (path.endsWith("probe.ts")) return 1;
          if (path.endsWith("native.ts")) return NATIVE_SOURCE;
          if (path.endsWith("main.json")) return '{"permissions":[]}';
          return VALID_SECURITY_CONFIG;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toMatch(/^Cannot inspect src\/probe\.ts: /);
    expect(caught.message).not.toMatch(/Cannot parse/);
    expect(caught.cause).toBeInstanceOf(TypeError);
  });
});

describe("capability and CSP boundaries", () => {
  test("rejects broad capability permissions", () => {
    expect(inspectCapability({ permissions: ["core:default", "fs:write-all"] })).toEqual(
      expect.arrayContaining([expect.stringMatching(/core:default.*fs:write-all/)]),
    );
  });

  test("rejects updater:default in favour of exact updater permissions", () => {
    expect(inspectCapability({ permissions: ["updater:default"] })).toEqual(
      expect.arrayContaining([expect.stringMatching(/updater:default/)]),
    );
    expect(
      inspectCapability({
        permissions: ["updater:allow-check", "updater:allow-download", "updater:allow-install"],
      }),
    ).toEqual([]);
  });

  test("rejects renderer filesystem permissions", () => {
    expect(inspectCapability({ permissions: ["fs:allow-read"] })).toEqual(
      expect.arrayContaining([expect.stringMatching(/fs:allow-read/)]),
    );
  });

  test("rejects wildcard HTTPS origins", () => {
    expect(inspectCsp("default-src 'self'; connect-src https://*")).toEqual([
      expect.stringMatching(/exact remote origins/),
    ]);
  });

  test("rejects the asset protocol scheme in any directive", () => {
    expect(inspectCsp("default-src 'self'; img-src asset:")).toEqual([
      expect.stringMatching(/asset protocol/),
    ]);
    expect(inspectCsp("default-src 'self'; media-src 'self' asset: http://127.0.0.1:*")).toEqual([
      expect.stringMatching(/asset protocol/),
    ]);
  });

  test("accepts a CSP without the asset scheme", () => {
    expect(inspectCsp("default-src 'self'; media-src 'self' http://127.0.0.1:*")).toEqual([]);
  });

  test("production CSP keeps loopback media-src for the sound server", () => {
    const config = JSON.parse(
      readFileSync(join(REPOSITORY_ROOT, "src-tauri/tauri.conf.json"), "utf8"),
    );
    expect(config.app.security.csp).toMatch(/media-src[^;]*http:\/\/127\.0\.0\.1:\*/);
    expect(config.app.security.csp).not.toMatch(/www\.encroissant\.org/);
  });
});

describe("native-location and asset-protocol boundaries", () => {
  function fixtureCase({ permissions = [], assetProtocol, csp } = {}) {
    const config = JSON.parse(VALID_SECURITY_CONFIG);
    if (csp !== undefined) config.app.security.csp = csp;
    if (assetProtocol === null) {
      delete config.app.security.assetProtocol;
    } else if (assetProtocol !== undefined) {
      config.app.security.assetProtocol = assetProtocol;
    }
    return () =>
      runTauriBoundaryCheck({
        workspaceRoot: "/fixture",
        listFiles: () => ["src/platform/native.ts"],
        readFile: (path) => {
          if (path.endsWith("native.ts")) return NATIVE_SOURCE;
          if (path.endsWith("main.json")) return JSON.stringify({ permissions });
          return JSON.stringify(config);
        },
      });
  }

  test.each(["core:path:allow-resolve", "core:path:allow-resolve-directory"])(
    "rejects %s through the full boundary runner",
    (permission) => {
      expect(fixtureCase({ permissions: [permission] })).toThrow(
        /renderer native-location authority is forbidden/,
      );
    },
  );

  test("allows core:path:allow-join through the full boundary runner", () => {
    expect(fixtureCase({ permissions: ["core:path:allow-join"] })).not.toThrow();
  });

  test.each([
    ["the old $RESOURCE scope while enabled", { enable: true, scope: ["$RESOURCE/**"] }],
    ["any other scope while enabled", { enable: true, scope: ["$APPDATA/**"] }],
  ])(
    "rejects an enabled asset protocol with %s through the full boundary runner",
    (_name, assetProtocol) => {
      expect(fixtureCase({ assetProtocol })).toThrow(/asset protocol must stay disabled/);
    },
  );

  test("allows an absent asset protocol block through the full boundary runner", () => {
    expect(fixtureCase()).not.toThrow();
    expect(fixtureCase({ assetProtocol: null })).not.toThrow();
  });

  test("allows a disabled asset protocol block through the full boundary runner", () => {
    expect(
      fixtureCase({ assetProtocol: { enable: false, scope: ["$RESOURCE/**"] } }),
    ).not.toThrow();
  });

  test("rejects a fixture CSP that still lists the asset scheme", () => {
    expect(
      fixtureCase({ csp: "default-src 'self'; media-src 'self' asset: http://127.0.0.1:*" }),
    ).toThrow(/asset protocol/);
  });
});

describe("working-tree enumeration and reads", () => {
  test("uses the exact untracked, tracked and deleted git argv and deduplicates", () => {
    const calls = [];
    const runGit = (command, args, options) => {
      calls.push([command, args, options]);
      const records = args.includes("--deleted") ? [] : ["src/foo.ts", "src/shared.ts"];
      const stdout = args.includes("-z") ? `${records.join("\0")}\0` : `${records.join("\n")}\n`;
      return { status: 0, stdout };
    };
    expect(listWorkingTreeFiles({ workspaceRoot: "/fixture", runGit })).toEqual([
      "src/foo.ts",
      "src/shared.ts",
    ]);
    expect(calls.map(([, args]) => args)).toEqual([
      ["ls-files", "--others", "--exclude-standard", "-z", "--", "src"],
      ["ls-files", "-z", "--", "src"],
      ["ls-files", "--deleted", "-z", "--", "src"],
    ]);
  });

  test("fails closed when git cannot start", () => {
    expect(() =>
      listWorkingTreeFiles({
        workspaceRoot: "/fixture",
        runGit: () => ({ error: new Error("git unavailable") }),
      }),
    ).toThrow(/git unavailable/);
  });

  test("fails closed when git exits non-zero", () => {
    expect(() =>
      listWorkingTreeFiles({
        workspaceRoot: "/fixture",
        runGit: () => ({ status: 1, stderr: "boom" }),
      }),
    ).toThrow(/boom/);
  });

  test("skips only an ENOENT working-tree source", () => {
    const readFile = (path) => {
      if (path.endsWith("missing.ts")) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (path.endsWith("native.ts")) return NATIVE_SOURCE;
      if (path.endsWith("main.json")) return '{"permissions":[]}';
      return VALID_SECURITY_CONFIG;
    };
    expect(
      runTauriBoundaryCheck({
        workspaceRoot: "/fixture",
        listFiles: () => ["src/missing.ts", "src/platform/native.ts"],
        readFile,
      }),
    ).toEqual(["src/missing.ts", "src/platform/native.ts"]);
  });

  test("rejects a missing native facade even when the listed path is ENOENT", () => {
    expect(() =>
      runTauriBoundaryCheck({
        workspaceRoot: "/fixture",
        listFiles: () => ["src/platform/native.ts"],
        readFile: (path) => {
          if (path.endsWith("native.ts")) {
            throw Object.assign(new Error("gone"), { code: "ENOENT" });
          }
          if (path.endsWith("main.json")) return '{"permissions":[]}';
          return VALID_SECURITY_CONFIG;
        },
      }),
    ).toThrow(/native facade is missing/);
  });

  test("names the file when capability JSON cannot be parsed", () => {
    expect(() =>
      runTauriBoundaryCheck({
        workspaceRoot: "/fixture",
        listFiles: () => ["src/platform/native.ts"],
        readFile: (path) => {
          if (path.endsWith("native.ts")) return NATIVE_SOURCE;
          if (path.endsWith("main.json")) return "{";
          return VALID_SECURITY_CONFIG;
        },
      }),
    ).toThrow(/capabilities\/main\.json/);
  });

  test("names a capability file that cannot be read", () => {
    let caught;
    try {
      runTauriBoundaryCheck({
        workspaceRoot: "/fixture",
        listFiles: () => ["src/platform/native.ts"],
        readFile: (path) => {
          if (path.endsWith("native.ts")) return NATIVE_SOURCE;
          if (path.endsWith("main.json")) {
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          }
          return VALID_SECURITY_CONFIG;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught.message).toMatch(/^Cannot read /);
    expect(caught.message).toMatch(/capabilities\/main\.json: EACCES: permission denied$/);
    expect(caught.cause.code).toBe("EACCES");
  });

  test("names a non-ENOENT working-tree read failure", () => {
    let caught;
    try {
      runTauriBoundaryCheck({
        workspaceRoot: "/fixture",
        listFiles: () => ["src/probe.ts"],
        readFile: (path) => {
          if (path.endsWith("probe.ts")) {
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          }
          if (path.endsWith("main.json")) return '{"permissions":[]}';
          return VALID_SECURITY_CONFIG;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught.message).toBe("Cannot read src/probe.ts: EACCES: permission denied");
    expect(caught.cause.code).toBe("EACCES");
  });
});

function createCliWorkspace({ nativeSource, untrackedSource } = {}) {
  const root = mkdtempSync(join(tmpdir(), "tauri-boundary-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "src/platform"), { recursive: true });
  mkdirSync(join(root, "src-tauri/capabilities"), { recursive: true });
  writeFileSync(join(root, "src/platform/native.ts"), nativeSource);
  writeFileSync(join(root, "src-tauri/capabilities/main.json"), '{"permissions":[]}\n');
  writeFileSync(join(root, "src-tauri/tauri.conf.json"), `${VALID_SECURITY_CONFIG}\n`);
  expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);
  expect(
    spawnSync("git", ["add", "src/platform/native.ts", "src-tauri"], { cwd: root }).status,
  ).toBe(0);
  if (untrackedSource) {
    writeFileSync(join(root, "src/leak.ts"), untrackedSource);
  }
  return root;
}

describe("CLI", () => {
  test("rejects a denylisted native re-export through the real CLI", () => {
    const result = spawnSync(process.execPath, [CHECKER], {
      cwd: createCliWorkspace({
        nativeSource: 'export { listen } from "@tauri-apps/api/event";\n',
      }),
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/listen.*api\/event|api\/event.*listen/);
  });

  test("scans untracked source files through the real CLI", () => {
    const result = spawnSync(process.execPath, [CHECKER], {
      cwd: createCliWorkspace({
        nativeSource: NATIVE_SOURCE,
        untrackedSource: 'import { readFile } from "@tauri-apps/plugin-fs";\n',
      }),
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/src\/leak\.ts.*@tauri-apps/);
  });

  test("exits 1 when a listed renderer file cannot be parsed", () => {
    const root = createCliWorkspace({ nativeSource: NATIVE_SOURCE });
    writeFileSync(join(root, "src/broken.ts"), "const = ;\n");
    const result = spawnSync(process.execPath, [CHECKER], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(BROKEN_PARSE_MESSAGE);
  });
});
