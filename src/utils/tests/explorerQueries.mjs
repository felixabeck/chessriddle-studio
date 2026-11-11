import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Keep the Node harness in JS because the renderer project has no Node type declarations.
/** @param {string} timezone */
export function getExplorerQueriesInTimezone(timezone) {
  // Start with TZ set before loading Date or the real TypeScript query builders.
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import { runnerImport } from "vite";
          import { INITIAL_FEN } from "chessops/fen";
          const { module: explorer } = await runnerImport(process.argv[1]);
          // Match the panels' conversion of picker calendar strings to Dates.
          const since = new Date("2024-01-01");
          const until = new Date("2024-02-01");
          console.log(JSON.stringify({
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            lichess: explorer.getLichessGamesQueryParams(
              INITIAL_FEN, { since, until, color: "white" },
            ),
            masters: explorer.getMasterGamesQueryParams(INITIAL_FEN, { since, until }),
          }));
        `,
        resolve(import.meta.dirname, "../lichess/explorer.ts"),
      ],
      { env: { ...process.env, TZ: timezone }, encoding: "utf8", timeout: 10_000 },
    ),
  );
}
