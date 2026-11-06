import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const supportedLocales = [
  "be-BY",
  "de-DE",
  "en-GB",
  "en-US",
  "es-ES",
  "fr-FR",
  "it-IT",
  "ko-KR",
  "nb-NO",
  "pl-PL",
  "pt-PT",
  "ru-RU",
  "tr-TR",
  "uk-UA",
  "zh-CN",
  "zh-TW",
];

/** Product names, chess notation, and technical identifiers may legitimately be unchanged. */
const untranslatedTechnicalTerm =
  /^(?:[A-Z][A-Za-z0-9.+-]*|[a-h][1-8](?:[a-h][1-8])?|O-O(?:-O)?|\?+|[0-9:./ -]+|\{\{[\w.]+\}\}|\{\{value\}\} s|ChessRiddle Studio v\{\{version\}\})$/u;

const pluralSuffix = /_(?:zero|one|two|few|many|other)$/u;

function pluralBase(key) {
  return key.replace(pluralSuffix, "");
}

function referenceKeyFor(key, reference) {
  if (Object.hasOwn(reference, key)) return key;
  const base = pluralBase(key);
  return `${base}_other`;
}

function contractTokens(value) {
  return [
    ...(value.match(/\{\{\s*[^}]+?\s*\}\}/gu) ?? []),
    ...(value.match(/<\/?[A-Za-z0-9]+(?:\s[^>]*)?>/gu) ?? []),
  ].sort();
}

function expectedKeysForLocale(referenceKeys, locale) {
  const expected = new Set(referenceKeys);
  const pluralBases = referenceKeys
    .filter((key) => key.endsWith("_one"))
    .map((key) => key.slice(0, -"_one".length))
    .filter((base) => referenceKeys.includes(`${base}_other`));
  const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  for (const base of pluralBases) {
    for (const key of [...expected])
      if (key.startsWith(`${base}_`) && pluralSuffix.test(key)) expected.delete(key);
    for (const category of categories) expected.add(`${base}_${category}`);
  }
  return expected;
}

export function checkCatalogues(catalogues) {
  const reference = catalogues["en-US"]?.translation;
  if (!reference) return ["en-US: missing translation namespace"];

  const referenceKeys = Object.keys(reference).sort();
  const errors = [];
  for (const locale of supportedLocales) {
    const translated = catalogues[locale]?.translation;
    if (!translated) {
      errors.push(`${locale}: missing translation namespace`);
      continue;
    }

    const keys = Object.keys(translated).sort();
    const expectedKeys = expectedKeysForLocale(referenceKeys, locale);
    for (const key of expectedKeys) {
      const value = translated[key];
      if (typeof value !== "string" || value.trim() === "")
        errors.push(`${locale}:${key}: missing translation`);
      else {
        const referenceKey = referenceKeyFor(key, reference);
        const referenceValue = reference[referenceKey];
        if (typeof referenceValue !== "string")
          errors.push(`${locale}:${key}: missing en-US reference contract`);
        else if (contractTokens(value).join("\0") !== contractTokens(referenceValue).join("\0"))
          errors.push(
            `${locale}:${key}: placeholder/tag contract differs from en-US:${referenceKey}`,
          );
        if (
          locale !== "en-US" &&
          locale !== "en-GB" &&
          value === reference[key] &&
          !untranslatedTechnicalTerm.test(value.trim())
        ) {
          errors.push(`${locale}:${key}: untranslated English fallback`);
        }
      }
    }
    for (const key of keys)
      if (!expectedKeys.has(key)) errors.push(`${locale}:${key}: obsolete key`);
  }
  return errors;
}

export async function loadCatalogues(catalogueDirectory) {
  const pairs = await Promise.all(
    supportedLocales.map(async (locale) => [
      locale,
      JSON.parse(await readFile(join(catalogueDirectory, `${locale}.json`), "utf8")),
    ]),
  );
  return Object.fromEntries(pairs);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const errors = checkCatalogues(await loadCatalogues(join(root, "src/translation")));
  if (errors.length) {
    console.error(`i18n completeness check failed with ${errors.length} issue(s):`);
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`i18n completeness check passed for ${supportedLocales.length} locales.`);
  }
}
