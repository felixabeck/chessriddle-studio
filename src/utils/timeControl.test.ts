import { expect, test } from "vitest";
import { getTimeControl } from "./timeControl";

test.each([
    ["179", "bullet"],
    ["180", "blitz"],
    ["599", "blitz"],
    ["600", "rapid"],
    ["540", "blitz"],
    ["480+2", "blitz"],
    ["180+10", "blitz"],
    ["120+12", "rapid"],
    ["300+5", "blitz"],
    ["1/86400", "daily"],
] as const)("classifies Chess.com time control %s as %s", (timeControl, expected) => {
    expect(getTimeControl("Chess.com", timeControl)).toBe(expected);
});
