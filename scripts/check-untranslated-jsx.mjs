import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isEntrypoint } from "./entrypoint.mjs";
import { parseTsSource } from "./parse-ts-source.mjs";
import { listWorkingTreeFiles } from "./working-tree-files.mjs";
const userFacingAttributes = new Set([
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "label",
  "placeholder",
  "description",
  "title",
  "alt",
  // Confirmation copy reaches the user identically whether it is written as a
  // JSX prop or as an object field, so both spellings are the same sink.
  "confirmLabel",
  "cancelLabel",
]);
const userFacingObjectProperties = new Set([
  "label",
  "title",
  "description",
  "placeholder",
  "alt",
  "noRecordsText",
  "message",
  "confirmLabel",
  "cancelLabel",
]);
const userFacingCalls = new Set(["ask", "message"]);

const technicalNotation =
  /^(?:FEN|PGN|ELO|UCI(?:_[A-Za-z]+)?|WDL|ACPL|n\/s|O-O(?:-O)?|\?|\?{4}\.\?{2}\.\?{2})$/u;
const namedAssetRegistries = new Set(["PiecesSelect.tsx", "SoundSelect.tsx", "SettingsPage.tsx"]);
const productIdentitySources = new Set([
  "About.tsx",
  "AccountCard.tsx",
  "Accounts.tsx",
  "LichessLogo.tsx",
  "WebsiteAccountSelector.tsx",
]);

/**
 * A literal with no letter in any script carries no translatable word: scale
 * marks, separators, punctuation and digits. JSX text has always been judged
 * this way; string and template literals are held to the same structural test so
 * the sink a value happens to sit in does not change whether it is copy.
 * Locale-dependent number shaping belongs to `Intl.NumberFormat`, not to a
 * catalogue key.
 */
function hasTranslatableWord(value) {
  return /\p{L}/u.test(value);
}

function isStructuredTechnicalLiteral(value, filename) {
  const basename = filename.split("/").at(-1);
  if (namedAssetRegistries.has(basename))
    return /^\d+%$|^\(\d+\)$/u.test(value) || /^[\p{L}\d .()]+$/u.test(value);
  return (
    productIdentitySources.has(basename) &&
    /^(?:ChessRiddle Studio|En Croissant|Lichess|Chess\.com|chess\.com|www\.encroissant\.org)$/u.test(
      value,
    )
  );
}

/**
 * Enumerate through the shared working-tree walker rather than recursing here,
 * so ignore, symlink and untracked handling cannot drift away from the other
 * gate checkers (`f-20260901-16`). An untracked or symlinked component is
 * scanned rather than silently skipped.
 */
export function listSourceFiles(workspaceRoot = process.cwd()) {
  return listWorkingTreeFiles({ workspaceRoot, pathspec: "src" })
    .filter((path) => /\.tsx$/u.test(path) && !/\.test\.tsx$/u.test(path))
    .sort();
}

function isTranslationCall(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "t"
  );
}

function isUserFacingCall(node) {
  if (node?.type !== "CallExpression") return false;
  if (node.callee?.type === "Identifier") return userFacingCalls.has(node.callee.name);
  return (
    node.callee?.type === "MemberExpression" &&
    node.callee.object?.type === "Identifier" &&
    node.callee.object.name === "notifications" &&
    node.callee.property?.type === "Identifier" &&
    node.callee.property.name === "show"
  );
}

export function findLiterals(source, filename = "source.tsx") {
  const literals = [];
  const ast = parseTsSource(source, filename);

  function visit(node, userFacing = false, classConfiguration = false) {
    if (!node || typeof node !== "object") return;
    if (isTranslationCall(node)) return;
    if (node.type === "JSXText" && !classConfiguration) {
      const value = node.value.trim();
      if (
        value &&
        hasTranslatableWord(value) &&
        !technicalNotation.test(value) &&
        !isStructuredTechnicalLiteral(value, filename)
      )
        literals.push(value);
    }
    if (node.type === "StringLiteral" && userFacing && !classConfiguration) {
      const value = node.value.trim();
      if (
        value &&
        hasTranslatableWord(value) &&
        !technicalNotation.test(value) &&
        !isStructuredTechnicalLiteral(value, filename)
      )
        literals.push(value);
      return;
    }
    if (node.type === "TemplateLiteral" && userFacing && !classConfiguration) {
      for (const quasi of node.quasis) {
        const value = quasi.value.cooked?.trim() ?? "";
        if (
          value &&
          hasTranslatableWord(value) &&
          !technicalNotation.test(value) &&
          !isStructuredTechnicalLiteral(value, filename)
        )
          literals.push(value);
      }
      return;
    }
    if (node.type === "ConditionalExpression") {
      // The condition is application state; only the two rendered outcomes are copy.
      visit(node.test, false, classConfiguration);
      visit(node.consequent, userFacing, classConfiguration);
      visit(node.alternate, userFacing, classConfiguration);
      return;
    }
    if (node.type === "JSXExpressionContainer") {
      visit(node.expression, userFacing, classConfiguration);
      return;
    }
    if (node.type === "JSXElement" || node.type === "JSXFragment") {
      for (const child of node.children ?? []) visit(child, false, classConfiguration);
      if (node.openingElement) visit(node.openingElement, false, classConfiguration);
      return;
    }
    const key =
      node.type === "JSXAttribute"
        ? node.name
        : node.type === "ObjectProperty"
          ? node.key
          : undefined;
    const propertyName = key?.type === "StringLiteral" ? key.value : key?.name;
    // Class-slot names can overlap copy fields. Keep their entire value in CSS
    // configuration context, including conditional branches and nested objects.
    if (propertyName === "classNames" || propertyName === "className") {
      visit(node.value, false, true);
      return;
    }
    const isAttribute =
      node.type === "JSXAttribute" &&
      node.name?.type === "JSXIdentifier" &&
      userFacingAttributes.has(node.name.name);
    const isObjectProperty =
      node.type === "ObjectProperty" &&
      ((node.key?.type === "Identifier" && userFacingObjectProperties.has(node.key.name)) ||
        (node.key?.type === "StringLiteral" && userFacingObjectProperties.has(node.key.value)));
    if (node.type === "ObjectProperty") {
      visit(node.key, false, classConfiguration);
      // A recognized field is a UI sink, but its nested object is not. This keeps
      // `{ label: { fontWeight: "normal" } }` from mistaking CSS configuration for copy.
      visit(node.value, isObjectProperty, classConfiguration);
      return;
    }
    if (isUserFacingCall(node)) {
      for (const argument of node.arguments)
        visit(
          argument,
          node.callee?.type === "Identifier" && userFacingCalls.has(node.callee.name),
          classConfiguration,
        );
      return;
    }
    const nextUserFacing = userFacing || isAttribute;
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        value.forEach((child) => visit(child, nextUserFacing, classConfiguration));
      else visit(value, nextUserFacing, classConfiguration);
    }
  }
  visit(ast);
  return literals;
}

export async function checkUntranslatedJsx(workspaceRoot = process.cwd()) {
  const violations = [];
  for (const file of listSourceFiles(workspaceRoot)) {
    const source = await readFile(resolve(workspaceRoot, file), "utf8");
    for (const literal of findLiterals(source, file))
      violations.push(`${file}: ${JSON.stringify(literal)}`);
  }
  return violations;
}

async function main() {
  const violations = await checkUntranslatedJsx();
  if (violations.length === 0) return 0;
  console.error(
    "Untranslated UI literals found. Use t()/Trans; allowed technical exceptions are documented in this script.",
  );
  for (const violation of violations) console.error(violation);
  return 1;
}

if (isEntrypoint(import.meta.url)) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 2;
    });
}
