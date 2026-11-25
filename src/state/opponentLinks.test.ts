import { describe, expect, test } from "vitest";
import {
    defaultOpponentFilter,
    findLinkWithAccount,
    findOpponentLink,
    isOpponentPlayerName,
    MAX_OPPONENT_ACCOUNTS,
    MAX_OPPONENT_LINKS,
    type OpponentLink,
    opponentDatabaseFilename,
    opponentDatabasePrefix,
    opponentLinksSchema,
    opponentSinceUnixSeconds,
    withOpponentAccount,
    withOpponentDatabase,
    withOpponentFilter,
    withOpponentLinkRenamed,
    withoutOpponentAccount,
    withoutOpponentLink,
} from "./opponentLinks";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function link(overrides: Partial<OpponentLink> = {}): OpponentLink {
    return {
        id: ID,
        playerName: "Carlsen, Magnus",
        accounts: [{ provider: "lichess", username: "DrNykterstein" }],
        filter: defaultOpponentFilter(),
        ...overrides,
    };
}

describe("opponentLinksSchema", () => {
    test("a valid stored list parses to itself", () => {
        const stored = [
            link({ database: `opponent-${ID}-0a1b2c3d.db3` }),
            link({ id: OTHER_ID, playerName: "Caruana, Fabiano" }),
        ];

        expect(opponentLinksSchema.parse(stored)).toEqual(stored);
    });

    test("anything that is not a list reads as no links", () => {
        for (const stored of [undefined, null, "links", { id: ID }, 7]) {
            expect(opponentLinksSchema.parse(stored)).toEqual([]);
        }
    });

    test("drops malformed entries and keeps the valid ones", () => {
        const valid = link();
        const stored = [
            { ...link({ id: OTHER_ID, playerName: "A" }), id: "not-a-uuid" },
            { ...link({ id: OTHER_ID, playerName: "B" }), accounts: [] },
            { ...link({ id: OTHER_ID, playerName: "C" }), extra: true },
            { ...link({ id: OTHER_ID, playerName: "D" }), database: "../games.db3" },
            {
                ...link({ id: OTHER_ID, playerName: "E" }),
                accounts: [{ provider: "lichess", username: "a/b" }],
            },
            {
                ...link({ id: OTHER_ID, playerName: "F" }),
                filter: { years: 2, timeControls: ["blitz"] },
            },
            {
                ...link({ id: OTHER_ID, playerName: "G" }),
                filter: { years: 3, timeControls: [] },
            },
            { ...link({ id: OTHER_ID }), playerName: "x".repeat(201) },
            valid,
        ];

        expect(opponentLinksSchema.parse(stored)).toEqual([valid]);
    });

    test("drops an entry repeating an earlier id or an earlier player name", () => {
        const first = link();
        const stored = [
            first,
            link({ playerName: "Somebody Else" }),
            link({ id: OTHER_ID, playerName: "  carlsen, magnus " }),
        ];

        expect(opponentLinksSchema.parse(stored)).toEqual([first]);
    });

    test("folds repeated accounts and repeated time controls", () => {
        const stored = [
            link({
                accounts: [
                    { provider: "lichess", username: "DrNykterstein" },
                    { provider: "lichess", username: "drnykterstein" },
                    { provider: "chesscom", username: "drnykterstein" },
                ],
                filter: { years: null, timeControls: ["rapid", "blitz", "rapid"] },
            }),
        ];

        expect(opponentLinksSchema.parse(stored)).toEqual([
            link({
                accounts: [
                    { provider: "lichess", username: "DrNykterstein" },
                    { provider: "chesscom", username: "drnykterstein" },
                ],
                filter: { years: null, timeControls: ["blitz", "rapid"] },
            }),
        ]);
    });

    test("keeps at most the bounded number of links and accounts", () => {
        const many = Array.from({ length: MAX_OPPONENT_LINKS + 5 }, (_, index) =>
            link({
                id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
                playerName: `Player ${index}`,
                accounts: Array.from({ length: MAX_OPPONENT_ACCOUNTS + 3 }, (_, account) => ({
                    provider: "lichess" as const,
                    username: `account${account}`,
                })),
            }),
        );

        const parsed = opponentLinksSchema.parse(many);

        expect(parsed).toHaveLength(MAX_OPPONENT_LINKS);
        expect(parsed[0].playerName).toBe("Player 5");
        expect(parsed.every((entry) => entry.accounts.length === MAX_OPPONENT_ACCOUNTS)).toBe(true);
    });
});

describe("findOpponentLink", () => {
    test("matches the name regardless of case, composition and surrounding blanks", () => {
        const links = [link({ playerName: "José Capablanca" })];

        for (const name of ["José Capablanca", "  JOSÉ capablanca  ", "josé CAPABLANCA"]) {
            expect(findOpponentLink(links, name)?.id).toBe(ID);
        }
    });

    test("finds nothing for another, an empty or an absent name", () => {
        const links = [link()];

        for (const name of ["Carlsen, M", "", "   ", null, undefined]) {
            expect(findOpponentLink(links, name)).toBeUndefined();
        }
    });
});

describe("findLinkWithAccount", () => {
    test("matches by provider and username case-insensitively", () => {
        const first = link();
        const second = link({
            id: OTHER_ID,
            playerName: "Caruana, Fabiano",
            accounts: [{ provider: "chesscom", username: "FabianoCaruana" }],
        });
        const links = [first, second];

        expect(
            findLinkWithAccount(links, { provider: "lichess", username: "drnykterstein" }),
        ).toEqual(first);
        expect(
            findLinkWithAccount(links, { provider: "chesscom", username: "fabianocaruana" }),
        ).toEqual(second);
        expect(
            findLinkWithAccount(links, { provider: "chesscom", username: "DrNykterstein" }),
        ).toBeUndefined();
        expect(
            findLinkWithAccount(links, { provider: "lichess", username: "nobody" }),
        ).toBeUndefined();
    });

    test("matches an account after the first one of a link", () => {
        const several = link({
            accounts: [
                { provider: "lichess", username: "DrNykterstein" },
                { provider: "chesscom", username: "MagnusCarlsen" },
            ],
        });

        expect(
            findLinkWithAccount([several], { provider: "chesscom", username: "magnuscarlsen" }),
        ).toEqual(several);
    });
});

describe("link changes", () => {
    test("the first account creates the link with the default filter", () => {
        const links = withOpponentAccount(
            [],
            " Carlsen, Magnus ",
            { provider: "chesscom", username: "MagnusCarlsen" },
            ID,
        );

        expect(links).toEqual([
            {
                id: ID,
                playerName: "Carlsen, Magnus",
                accounts: [{ provider: "chesscom", username: "MagnusCarlsen" }],
                filter: {
                    years: 3,
                    timeControls: ["blitz", "rapid", "classical", "correspondence"],
                },
            },
        ]);
    });

    test("a further account joins the existing link, found by name, and keeps its id", () => {
        const links = withOpponentAccount(
            [link()],
            "CARLSEN, MAGNUS",
            { provider: "chesscom", username: "MagnusCarlsen" },
            OTHER_ID,
        );

        expect(links).toHaveLength(1);
        expect(links[0].id).toBe(ID);
        expect(links[0].accounts).toEqual([
            { provider: "lichess", username: "DrNykterstein" },
            { provider: "chesscom", username: "MagnusCarlsen" },
        ]);
    });

    test("an account the link already has, in any case, changes nothing", () => {
        const before = [link()];

        expect(
            withOpponentAccount(
                before,
                "Carlsen, Magnus",
                { provider: "lichess", username: "drnykterstein" },
                OTHER_ID,
            ),
        ).toEqual(before);
    });

    test("an account beyond the bound changes nothing", () => {
        const full = [
            link({
                accounts: Array.from({ length: MAX_OPPONENT_ACCOUNTS }, (_, index) => ({
                    provider: "lichess" as const,
                    username: `account${index}`,
                })),
            }),
        ];

        expect(
            withOpponentAccount(
                full,
                "Carlsen, Magnus",
                { provider: "chesscom", username: "x" },
                ID,
            ),
        ).toEqual(full);
    });

    test("a player name that would not read back from storage gets no link", () => {
        const account = { provider: "lichess", username: "someone" } as const;

        for (const name of ["", "   ", "x".repeat(201)]) {
            expect(isOpponentPlayerName(name)).toBe(false);
            expect(withOpponentAccount([link()], name, account, OTHER_ID)).toEqual([link()]);
        }
        expect(isOpponentPlayerName(null)).toBe(false);
        expect(isOpponentPlayerName(undefined)).toBe(false);

        const longest = "x".repeat(200);
        expect(isOpponentPlayerName(` ${longest} `)).toBe(true);
        const stored = withOpponentAccount([], ` ${longest} `, account, ID);
        expect(opponentLinksSchema.parse(stored)).toEqual(stored);
    });

    test("removing an account keeps the others, and the last account stays", () => {
        const both = [
            link({
                accounts: [
                    { provider: "lichess", username: "DrNykterstein" },
                    { provider: "chesscom", username: "MagnusCarlsen" },
                ],
            }),
        ];

        const one = withoutOpponentAccount(both, ID, {
            provider: "lichess",
            username: "drnykterstein",
        });

        expect(one[0].accounts).toEqual([{ provider: "chesscom", username: "MagnusCarlsen" }]);
        expect(withoutOpponentAccount(one, ID, one[0].accounts[0])).toEqual(one);
    });

    test("the filter is stored in the offered order and never without a time control", () => {
        const links = withOpponentFilter([link()], ID, {
            years: 5,
            timeControls: ["rapid", "bullet"],
        });

        expect(links[0].filter).toEqual({ years: 5, timeControls: ["bullet", "rapid"] });
        expect(withOpponentFilter(links, ID, { years: 1, timeControls: [] })).toEqual(links);
    });

    test("the database name is set, replaced and cleared without touching the accounts", () => {
        const first = `opponent-${ID}-00000001.db3`;
        const set = withOpponentDatabase([link()], ID, first);
        const cleared = withOpponentDatabase(set, ID, undefined);

        expect(set[0].database).toBe(first);
        expect(cleared).toEqual([link()]);
        expect("database" in cleared[0]).toBe(false);
    });

    test("unlinking removes exactly that link", () => {
        const other = link({ id: OTHER_ID, playerName: "Caruana, Fabiano" });

        expect(withoutOpponentLink([link(), other], ID)).toEqual([other]);
    });

    test("a change makes its link the most recently changed one", () => {
        const other = link({ id: OTHER_ID, playerName: "Caruana, Fabiano" });

        const links = withOpponentFilter([link(), other], ID, {
            years: 1,
            timeControls: ["blitz"],
        });

        expect(links.map((entry) => entry.id)).toEqual([OTHER_ID, ID]);
    });

    test("renaming trims the name, keeps everything else, and makes the link most recently changed", () => {
        const first = link({
            playerName: "DrNykterstein",
            database: `opponent-${ID}-0a1b2c3d.db3`,
        });
        const second = link({ id: OTHER_ID, playerName: "Caruana, Fabiano" });

        const renamed = withOpponentLinkRenamed([first, second], ID, "  Carlsen, Magnus  ");

        expect(renamed).toEqual([second, { ...first, playerName: "Carlsen, Magnus" }]);
    });

    test("renaming refuses an unknown id, an invalid name and another link's name, but takes its own name in another spelling", () => {
        const first = link({ playerName: "José Capablanca" });
        const second = link({ id: OTHER_ID, playerName: "Caruana, Fabiano" });
        const before = [first, second];

        expect(
            withOpponentLinkRenamed(before, "33333333-3333-4333-8333-333333333333", "New"),
        ).toEqual(before);
        for (const badName of ["", "   ", "x".repeat(201)]) {
            expect(withOpponentLinkRenamed(before, ID, badName)).toEqual(before);
        }
        expect(withOpponentLinkRenamed(before, ID, "  CARUANA, FABIANO ")).toEqual(before);

        const respelled = withOpponentLinkRenamed(before, ID, "  JOSE\u0301 CAPABLANCA  ");
        expect(respelled).toEqual([second, { ...first, playerName: "JOSE\u0301 CAPABLANCA" }]);
    });
});

describe("database names and period", () => {
    test("every file of a link shares its prefix and passes the stored-name check", () => {
        const filename = opponentDatabaseFilename(ID, "0a1b2c3d");

        expect(filename).toBe(`opponent-${ID}-0a1b2c3d.db3`);
        expect(filename.startsWith(opponentDatabasePrefix(ID))).toBe(true);
        expect(opponentLinksSchema.parse([link({ database: filename })])[0].database).toBe(
            filename,
        );
    });

    test("the period starts the chosen number of years before now, or nowhere", () => {
        const now = new Date("2026-11-22T12:00:00Z");

        expect(opponentSinceUnixSeconds({ years: 3, timeControls: ["blitz"] }, now)).toBe(
            Date.parse("2023-11-22T12:00:00Z") / 1000,
        );
        expect(opponentSinceUnixSeconds({ years: null, timeControls: ["blitz"] }, now)).toBeNull();
    });
});
