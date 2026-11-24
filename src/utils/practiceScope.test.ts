import { expect, test } from "vitest";
import { isInPracticeScope, isUserToMove } from "./practiceScope";

test("practice scope includes only non-root positions or the Start subtree", () => {
    expect(isInPracticeScope([], [])).toBe(false);
    expect(isInPracticeScope([1], [])).toBe(true);
    expect(isInPracticeScope([1, 0], [1, 0])).toBe(true);
    expect(isInPracticeScope([1, 0, 0], [1, 0])).toBe(true);
    expect(isInPracticeScope([1], [1, 0])).toBe(false);
    expect(isInPracticeScope([1, 1], [1, 0])).toBe(false);
});

test("own turn is half-move parity against the practised side", () => {
    expect(isUserToMove(0, "white")).toBe(true);
    expect(isUserToMove(1, "white")).toBe(false);
    expect(isUserToMove(0, "black")).toBe(false);
    expect(isUserToMove(1, "black")).toBe(true);
});
