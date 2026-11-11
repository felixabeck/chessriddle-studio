// @vitest-environment node

import { beforeAll, describe, expect, test } from "vitest";
import { getExplorerQueriesInTimezone } from "../tests/explorerQueries.mjs";

describe.each(["America/Los_Angeles", "Europe/Berlin"])("explorer queries in %s", (timezone) => {
    let queries: { timezone: string; lichess: string; masters: string };

    beforeAll(() => {
        queries = getExplorerQueriesInTimezone(timezone);
    });

    test("Lichess preserves January Since and February Until from picker calendar values", () => {
        expect(queries.timezone).toBe(timezone);
        const params = new URLSearchParams(queries.lichess);

        expect(params.get("since")).toBe("2024-01");
        expect(params.get("until")).toBe("2024-02");
    });

    test("Masters preserves the picker calendar year for both Since and Until", () => {
        expect(queries.timezone).toBe(timezone);
        const params = new URLSearchParams(queries.masters);

        expect(params.get("since")).toBe("2024");
        expect(params.get("until")).toBe("2024");
    });
});
