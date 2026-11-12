// Renderer module-reference gate (AST). Known limits, stated rather than implied complete:
// - An unresolved specifier whose known prefix rules out `@tauri-apps/` is allowed.
//   Accidental runtime assembly of a relative path to `bindings/generated` is not
//   flagged (the generated-rule known limit).
// - Out of scope (deliberate evasion): `eval`, `new Function`,
//   `globalThis["req" + "uire"]`, a destructured `const { mock } = vi`,
//   `require` reached through an alias or a sequence (`const r = require; r(...)`,
//   `(0, require)(...)`), `vi` imported or bound under another name,
//   `import.meta.glob`, `jest.mock`, reaching Tauri through
//   `window.__TAURI_INTERNALS__`, and a relative path into
//   `node_modules/@tauri-apps/…`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { traverse } from "@babel/core";
import { isEntrypoint } from "./entrypoint.mjs";
import { listWorkingTreeFiles } from "./working-tree-files.mjs";
import {
  cannotParseError,
  errorDetail,
  nodeLine,
  nodeText,
  parseTsSource,
  resolveChain,
  unwrap,
} from "./parse-ts-source.mjs";

// Exact required re-export set for platform/native.ts, not an optional permit
// list. `exported` is the name in the specifier module; `local` is the name
// this file re-exports (`export { exported as local } from`). There is no
// local binding.
export const NATIVE_EXPORT_ALLOWLIST = Object.freeze(
  [
    ["@tauri-apps/api/app", "getTauriVersion", "getTauriVersion"],
    ["@tauri-apps/api/app", "getVersion", "getVersion"],
    ["@tauri-apps/api/menu", "Menu", "Menu"],
    ["@tauri-apps/api/menu", "MenuItem", "MenuItem"],
    ["@tauri-apps/api/menu", "PredefinedMenuItem", "PredefinedMenuItem"],
    ["@tauri-apps/api/menu", "Submenu", "Submenu"],
    ["@tauri-apps/api/webviewWindow", "getCurrentWebviewWindow", "getCurrentWebviewWindow"],
    ["@tauri-apps/api/webviewWindow", "WebviewWindow", "WebviewWindow"],
    ["@tauri-apps/api/window", "getCurrentWindow", "getCurrentWindow"],
    ["@tauri-apps/plugin-cli", "getMatches", "getMatches"],
    ["@tauri-apps/plugin-dialog", "ask", "ask"],
    ["@tauri-apps/plugin-log", "error", "error"],
    ["@tauri-apps/plugin-log", "info", "info"],
    ["@tauri-apps/plugin-log", "warn", "warn"],
    ["@tauri-apps/plugin-os", "arch", "arch"],
    ["@tauri-apps/plugin-os", "platform", "platform"],
    ["@tauri-apps/plugin-os", "Platform", "Platform"],
    ["@tauri-apps/plugin-os", "type", "osType"],
    ["@tauri-apps/plugin-os", "version", "OSVersion"],
    ["@tauri-apps/plugin-process", "exit", "exit"],
    ["@tauri-apps/plugin-process", "relaunch", "relaunch"],
    ["@tauri-apps/plugin-updater", "check", "check"],
    ["@tauri-apps/plugin-updater", "Update", "Update"],
  ].map(([specifier, exported, local]) => Object.freeze({ specifier, exported, local })),
);

export const NATIVE_EXPORT_DENYLIST = Object.freeze(
  [
    { specifier: "@tauri-apps/api" },
    { specifier: "@tauri-apps/api/event" },
    { specifier: "@tauri-apps/api/core", exported: "invoke" },
    { specifier: "@tauri-apps/plugin-fs" },
    { specifier: "@tauri-apps/plugin-http" },
    { specifier: "@tauri-apps/plugin-shell" },
  ].map(Object.freeze),
);

const TAURI_SPECIFIER = /^@tauri-apps\/(?:api(?:\/.*)?|plugin-.+)$/;
const GENERATED_BINDINGS_IMPORT_ALLOWLIST = new Set([
  "@tauri-apps/api/core",
  "@tauri-apps/api/event",
  "@tauri-apps/api/webviewWindow",
]);
const VI_MODULE_METHODS = new Set([
  "mock",
  "doMock",
  "unmock",
  "doUnmock",
  "importActual",
  "importMock",
]);
const STOP_AT_PARAM = Object.freeze({ stopAtParam: true });

function isGeneratedBindings(specifier) {
  return /(?:^|\/)bindings\/generated(?:\.[^/]+)?$/.test(specifier);
}

function isBindingsBarrel(specifier) {
  return /(?:^|\/)bindings$/.test(specifier);
}

function isTauriSpecifier(specifier) {
  return TAURI_SPECIFIER.test(specifier);
}

function couldBeTauriPrefix(prefix) {
  return prefix === "" || "@tauri-apps/".startsWith(prefix) || prefix.startsWith("@tauri-apps/");
}

function nodeName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "StringLiteral") return node.value;
  return "";
}

function isMemberAccess(node) {
  return node?.type === "MemberExpression" || node?.type === "OptionalMemberExpression";
}

function dynamicImportArgument(node) {
  const inner = unwrap(node);
  if (inner?.type === "ImportExpression") return inner.source;
  if (inner?.type === "CallExpression" && inner.callee?.type === "Import")
    return inner.arguments[0];
  return undefined;
}

function evaluateStatic(node, scope, { coerceNumber = false, seen = new Set() } = {}) {
  node = unwrap(node);
  if (!node) return { resolved: false, prefix: "" };

  if (node.type === "StringLiteral") return { resolved: true, value: node.value };
  if (node.type === "NumericLiteral") {
    // coerceNumber mirrors JS string coercion inside a template or `+`; a bare
    // numeric specifier stays unresolved.
    if (coerceNumber) return { resolved: true, value: String(node.value) };
    return { resolved: false, prefix: "" };
  }
  if (node.type === "TemplateLiteral") {
    let value = "";
    for (let i = 0; i < node.quasis.length; i++) {
      value += node.quasis[i].value.cooked ?? "";
      if (i < node.expressions.length) {
        const inner = evaluateStatic(node.expressions[i], scope, { coerceNumber: true, seen });
        if (!inner.resolved) return { resolved: false, prefix: value };
        value += inner.value;
      }
    }
    return { resolved: true, value };
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = evaluateStatic(node.left, scope, { coerceNumber: true, seen });
    if (!left.resolved) return { resolved: false, prefix: left.prefix };
    const right = evaluateStatic(node.right, scope, { coerceNumber: true, seen });
    if (!right.resolved) return { resolved: false, prefix: left.value };
    return { resolved: true, value: left.value + right.value };
  }
  if (node.type === "Identifier") {
    const pathSeen = new Set(seen);
    const result = resolveChain(node, scope, pathSeen, STOP_AT_PARAM);
    if (
      !result.node ||
      result.node.type === "Identifier" ||
      result.node.type === "ImportSpecifier"
    ) {
      return { resolved: false, prefix: "" };
    }
    return evaluateStatic(result.node, result.scope, { coerceNumber, seen: pathSeen });
  }
  return { resolved: false, prefix: "" };
}

function staticPropertyName(member, scope) {
  if (!member.computed && member.property?.type === "Identifier") return member.property.name;
  if (member.computed) {
    const evaluated = evaluateStatic(member.property, scope);
    if (evaluated.resolved) return evaluated.value;
  }
  return undefined;
}

function isViModuleMethod(callee, scope) {
  if (!isMemberAccess(callee)) return false;
  const object = unwrap(callee.object);
  if (object?.type !== "Identifier" || object.name !== "vi") return false;
  return VI_MODULE_METHODS.has(staticPropertyName(callee, scope));
}

function analyzeSource(ast, source) {
  const references = [];
  const mockPromiseImports = new Set();
  const flags = {
    barrelRuntime: false,
    rawDotListen: false,
    rawListen: false,
    rawTauriEvents: false,
  };

  function addReference(kind, specifierNode, path) {
    const evaluated = evaluateStatic(specifierNode, path.scope);
    const textNode = specifierNode ?? path.node;
    references.push({
      kind,
      node: path.node,
      specifier: evaluated.resolved ? evaluated.value : undefined,
      prefix: evaluated.resolved ? evaluated.value : (evaluated.prefix ?? ""),
      sourceText: nodeText(source, textNode),
      line: nodeLine(textNode),
    });
  }

  function visitCall(path) {
    const node = path.node;
    if (mockPromiseImports.has(node)) return;

    const callee = unwrap(node.callee);

    if (isViModuleMethod(callee, path.scope)) {
      const first = node.arguments[0];
      let specifierNode = first;
      const mockSpecifier = dynamicImportArgument(first);
      if (mockSpecifier !== undefined) {
        mockPromiseImports.add(unwrap(first));
        specifierNode = mockSpecifier;
      }
      addReference("mock", specifierNode, path);
      return;
    }

    if (callee?.type === "Import") {
      addReference("dynamic", node.arguments[0], path);
      return;
    }

    if (callee?.type === "Identifier" && callee.name === "require") {
      addReference("dynamic", node.arguments[0], path);
      return;
    }

    if (isMemberAccess(callee) && staticPropertyName(callee, path.scope) === "listen") {
      flags.rawDotListen = true;
    } else if (callee?.type === "Identifier" && callee.name === "listen") {
      flags.rawListen = true;
    }
  }

  function visitTauriEvents(node) {
    const object = unwrap(node.object);
    if (object?.type === "Identifier" && object.name === "tauriEvents") {
      flags.rawTauriEvents = true;
    }
  }

  traverse(ast, {
    ImportDeclaration(path) {
      addReference("static", path.node.source, path);
      const declaration = path.node;
      if (declaration.importKind === "type") return;
      const spec = declaration.source?.value;
      if (typeof spec !== "string" || !isBindingsBarrel(spec)) return;
      for (const specifier of declaration.specifiers) {
        if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue;
        const imported = nodeName(specifier.imported);
        if (imported === "commands" || imported === "events") flags.barrelRuntime = true;
      }
    },
    ExportNamedDeclaration(path) {
      if (path.node.source) addReference("static", path.node.source, path);
    },
    ExportAllDeclaration(path) {
      if (path.node.source) addReference("static", path.node.source, path);
    },
    TSImportEqualsDeclaration(path) {
      const moduleReference = path.node.moduleReference;
      if (moduleReference?.type === "TSExternalModuleReference") {
        addReference("static", moduleReference.expression, path);
      }
    },
    TSImportType(path) {
      addReference("type-query", path.node.argument, path);
    },
    ImportExpression(path) {
      if (mockPromiseImports.has(path.node)) return;
      addReference("dynamic", path.node.source, path);
    },
    CallExpression: visitCall,
    OptionalCallExpression: visitCall,
    MemberExpression(path) {
      visitTauriEvents(path.node);
    },
    OptionalMemberExpression(path) {
      visitTauriEvents(path.node);
    },
  });

  return { references, flags };
}

function tripleKey({ specifier, exported, local }) {
  return `${specifier}\0${exported}\0${local}`;
}

function describeTriple({ specifier, exported, local }) {
  return `${specifier}:${exported}${local === exported ? "" : ` as ${local}`}`;
}

function inspectNativeSource(references, allowlist, denylist) {
  const violations = [];
  const actual = [];

  for (const ref of references) {
    if (ref.specifier === undefined || !isTauriSpecifier(ref.specifier)) continue;
    const node = ref.node;
    if (node.type === "ExportAllDeclaration") {
      violations.push(`native export star is forbidden: ${ref.specifier}`);
      continue;
    }
    if (node.type === "ExportNamedDeclaration" && node.source) {
      const hasNamespace = node.specifiers.some(
        (specifier) => specifier.type === "ExportNamespaceSpecifier",
      );
      if (hasNamespace) {
        violations.push(`native export star is forbidden: ${ref.specifier}`);
        continue;
      }
      const namedSpecifiers = node.specifiers.filter(
        (specifier) => specifier.type === "ExportSpecifier",
      );
      if (namedSpecifiers.length === 0) {
        violations.push("native facade may only use named Tauri re-exports");
        continue;
      }
      for (const specifier of namedSpecifiers) {
        actual.push({
          specifier: ref.specifier,
          // Babel's ExportSpecifier.local is the module-side name (this file's exported) and Babel's exported is the re-exported name (this file's local).
          exported: nodeName(specifier.local),
          local: nodeName(specifier.exported),
        });
      }
      continue;
    }
    violations.push("native facade may only use named Tauri re-exports");
  }

  const actualKeys = new Set(actual.map(tripleKey));
  const allowedKeys = new Set(allowlist.map(tripleKey));

  for (const entry of actual) {
    if (
      denylist.some(
        (denied) =>
          denied.specifier === entry.specifier &&
          (denied.exported === undefined || denied.exported === entry.exported),
      )
    ) {
      violations.push(`native denylist forbids ${describeTriple(entry)}`);
    }
    if (!allowedKeys.has(tripleKey(entry))) {
      violations.push(`native export is not allowlisted: ${describeTriple(entry)}`);
    }
  }
  for (const entry of allowlist) {
    if (!actualKeys.has(tripleKey(entry))) {
      violations.push(`native export is missing: ${describeTriple(entry)}`);
    }
  }

  for (const ref of references) {
    if (ref.specifier === undefined && couldBeTauriPrefix(ref.prefix)) {
      violations.push("native facade may only use named Tauri re-exports");
    }
  }
  return violations;
}

export function inspectSource(
  path,
  source,
  { allowlist = NATIVE_EXPORT_ALLOWLIST, denylist = NATIVE_EXPORT_DENYLIST } = {},
) {
  const ast = parseTsSource(source, path);
  const { references, flags } = analyzeSource(ast, source);
  const violations = [];
  const isTauriFacade = path === "platform/tauri.ts";
  const isNativeFacade = path === "platform/native.ts";
  const isGeneratedBindingsPath = path === "bindings/generated.ts";

  if (isNativeFacade) {
    violations.push(...inspectNativeSource(references, allowlist, denylist));
  } else {
    for (const ref of references) {
      if (ref.specifier === undefined || !isTauriSpecifier(ref.specifier)) continue;
      if (
        isGeneratedBindingsPath &&
        ref.kind === "static" &&
        GENERATED_BINDINGS_IMPORT_ALLOWLIST.has(ref.specifier)
      ) {
        continue;
      }
      violations.push("direct @tauri-apps module access");
    }
  }

  for (const ref of references) {
    if (ref.specifier !== undefined || !couldBeTauriPrefix(ref.prefix)) continue;
    violations.push(
      `module specifier is not statically resolvable: ${ref.sourceText} (line ${ref.line})`,
    );
  }

  if (!isTauriFacade && !isGeneratedBindingsPath) {
    for (const ref of references) {
      if (ref.kind === "mock" || ref.specifier === undefined) continue;
      if (isGeneratedBindings(ref.specifier)) {
        violations.push("direct bindings/generated module access");
      }
    }
    if (flags.barrelRuntime) {
      violations.push("runtime commands/events import from bindings barrel");
    }
    if (flags.rawDotListen) violations.push("raw .listen() call");
    if (flags.rawTauriEvents) violations.push("raw tauriEvents access");
    if (flags.rawListen) violations.push("raw listen() call");
  }

  return [...new Set(violations)];
}

export function inspectCapability(capabilityJson) {
  const violations = [];
  const permissions = Array.isArray(capabilityJson?.permissions) ? capabilityJson.permissions : [];
  const broadPermission = /(?:^|:)(?:default|write-all)$/;
  const broadPermissions = permissions.filter(
    (permission) => typeof permission === "string" && broadPermission.test(permission),
  );
  if (broadPermissions.length) {
    violations.push(`capability must use exact permissions: ${broadPermissions.join(", ")}`);
  }
  const rendererAuthorityChecks = [
    {
      predicate: (identifier) =>
        typeof identifier === "string" &&
        (identifier.startsWith("fs:") ||
          identifier === "opener:allow-open-path" ||
          identifier === "opener:allow-open-url"),
      message: "renderer filesystem/opener authority is forbidden",
    },
    {
      predicate: (identifier) =>
        identifier === "core:path:allow-resolve" ||
        identifier === "core:path:allow-resolve-directory",
      message: "renderer native-location authority is forbidden",
    },
  ];
  for (const { predicate, message } of rendererAuthorityChecks) {
    const authorities = permissions
      .map((permission) => (typeof permission === "string" ? permission : permission?.identifier))
      .filter(predicate);
    if (authorities.length) {
      violations.push(`${message}: ${authorities.join(", ")}`);
    }
  }
  return violations;
}

export function inspectAssetProtocol(assetProtocol) {
  // The loopback sound server serves every platform, so the asset protocol has no consumer:
  // only an absent block or an explicitly disabled one is acceptable, at any scope.
  if (!assetProtocol || assetProtocol.enable !== true) return [];
  return [`asset protocol must stay disabled: ${JSON.stringify(assetProtocol)}`];
}

export function inspectCsp(csp) {
  if (typeof csp !== "string") return ["CSP must enumerate exact remote origins"];
  const violations = [];
  if (/https?:\/\/\*/.test(csp)) {
    violations.push("CSP must enumerate exact remote origins");
  }
  // `asset:` names the deleted asset-protocol scheme; a CSP that still lists it re-grants media
  // and images the unification removed, whatever directive it sits in.
  if (/(?:^|[\s;])asset:/.test(csp)) {
    violations.push("CSP must not grant the asset protocol");
  }
  return violations;
}

function readJsonFile(readFile, path) {
  let source;
  try {
    source = readFile(path);
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${errorDetail(error)}`, { cause: error });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${errorDetail(error)}`);
  }
}

export function runTauriBoundaryCheck({
  workspaceRoot = process.cwd(),
  listFiles = (root) => listWorkingTreeFiles({ workspaceRoot: root }),
  readFile = (path) => readFileSync(path, "utf8"),
} = {}) {
  const violations = [];
  const paths = listFiles(workspaceRoot);
  let nativeInspected = false;
  for (const listedPath of paths) {
    if (!/^src\/.*\.[jt]sx?$/.test(listedPath)) continue;
    let source;
    try {
      source = readFile(resolve(workspaceRoot, listedPath));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`Cannot read ${listedPath}: ${errorDetail(error)}`, { cause: error });
    }
    const sourcePath = listedPath.replace(/^src\//, "");
    if (sourcePath === "platform/native.ts") nativeInspected = true;
    try {
      for (const message of inspectSource(sourcePath, source)) {
        violations.push(`${listedPath}: ${message}`);
      }
    } catch (error) {
      if (error?.code === "BABEL_PARSE_ERROR") {
        throw cannotParseError(error, listedPath, sourcePath);
      }
      throw new Error(`Cannot inspect ${listedPath}: ${errorDetail(error)}`, { cause: error });
    }
  }
  if (!nativeInspected) {
    violations.push("src/platform/native.ts: native facade is missing");
  }

  const capabilityPath = resolve(workspaceRoot, "src-tauri/capabilities/main.json");
  const configPath = resolve(workspaceRoot, "src-tauri/tauri.conf.json");
  const capability = readJsonFile(readFile, capabilityPath);
  const tauriConfig = readJsonFile(readFile, configPath);
  violations.push(...inspectCapability(capability));
  violations.push(...inspectCsp(tauriConfig?.app?.security?.csp));
  violations.push(...inspectAssetProtocol(tauriConfig?.app?.security?.assetProtocol));

  if (violations.length) {
    throw new Error(
      `Tauri commands, events, plugins, and listeners may only cross platform facades:\n${violations.join("\n")}`,
    );
  }
  return paths;
}

if (isEntrypoint(import.meta.url)) {
  try {
    runTauriBoundaryCheck();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
