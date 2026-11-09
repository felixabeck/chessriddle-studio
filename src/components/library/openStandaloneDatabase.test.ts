import { expect, test, vi } from "vitest";
import type { SuccessDatabaseInfo } from "@/utils/db";
import { openStandaloneDatabase } from "./openStandaloneDatabase";

const mocks = vi.hoisted(() => ({
    setDatabase: vi.fn(),
    target: { to: "/databases/$databaseId", params: { databaseId: "db" } },
}));
vi.mock("@/state/store/database", () => ({
    activeDatabaseViewStore: { getState: () => ({ setDatabase: mocks.setDatabase }) },
}));
vi.mock("@/components/databases/databaseRoute", () => ({
    databaseRouteTarget: () => mocks.target,
}));
test("uses the shared table-opening admission and navigates only when admitted", () => {
    const database = {
        type: "success",
        file: { kind: "database", id: { id: "db" } },
    } as SuccessDatabaseInfo;
    const navigate = vi.fn();
    mocks.setDatabase.mockReturnValue(false);
    expect(openStandaloneDatabase(database, navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    mocks.setDatabase.mockReturnValue(true);
    expect(openStandaloneDatabase(database, navigate)).toBe(true);
    expect(mocks.setDatabase).toHaveBeenLastCalledWith(database);
    expect(navigate).toHaveBeenCalledWith(mocks.target);
});
