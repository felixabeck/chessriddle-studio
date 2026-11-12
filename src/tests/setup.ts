import { afterAll, afterEach } from "vitest";
import type { TabStorageRepository } from "@/state/store/tabStorage";
import { installFileTimerFence } from "@/utils/tests/fileTimerFence";
import { createTabStorageCleanup } from "@/utils/tests/tabStorageCleanup";

// Setup's afterAll runs after file hooks, stopping timers before jsdom removes window.
const fence = installFileTimerFence(globalThis);
fence.open();
afterAll(() => fence.close());

// Register only scheduled repositories. Do not preload tabStorage or its platform
// imports here, so each suite's hoisted mocks still apply to the first import.
const cleanup = createTabStorageCleanup();
(
    globalThis as typeof globalThis & {
        __chessfableTrackTabStorage?: (repository: TabStorageRepository) => void;
    }
).__chessfableTrackTabStorage = cleanup.track;

afterEach(() => cleanup.drain());
