// Prints the release notes for one version: the body of CHANGELOG.md's `## <version>` section, up
// to the next `## ` heading. release.yml publishes them as the GitHub release text, and
// chessriddle.com/studio renders that text as Markdown with raw HTML turned off, so a section
// that is missing, empty or contains raw HTML is refused.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RAW_HTML = /<[!/?a-z]/i;

export function releaseNotes(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.indexOf(`## ${version}`);
  if (start === -1) throw new Error(`CHANGELOG.md has no section "## ${version}"`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const notes = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
  if (notes === "") throw new Error(`CHANGELOG.md section "## ${version}" is empty`);
  if (RAW_HTML.test(notes)) {
    throw new Error(`CHANGELOG.md section "## ${version}" contains raw HTML`);
  }
  return `${notes}\n`;
}

/** The command: `release-notes.mjs <tag or version> [changelog path]`; returns what to print. */
export function main(args, readText) {
  const [tag, path = "CHANGELOG.md"] = args;
  if (!tag) {
    return {
      status: 2,
      stdout: "",
      stderr: "usage: release-notes.mjs <tag or version> [changelog path]\n",
    };
  }
  try {
    return { status: 0, stdout: releaseNotes(readText(path), tag.replace(/^v/, "")), stderr: "" };
  } catch (error) {
    return { status: 1, stdout: "", stderr: `::error::${error.message}\n` };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = main(process.argv.slice(2), (path) => readFileSync(path, "utf8"));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status;
}
