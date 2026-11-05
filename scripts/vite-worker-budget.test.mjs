// @vitest-environment node
import { readFileSync } from "node:fs";
import * as os from "node:os";
import { describe, expect, test, vi } from "vitest";
import {
  VITEST_BASE_BYTES,
  VITEST_LOGICAL_CPUS_PER_WORKER,
  VITEST_WORKER_BYTES,
  vitestMaxWorkers,
  workerCount,
} from "./gate-parallelism.mjs";

const TWO_GIB = 2 * 1024 ** 3;

async function withEnvironment(updates, run) {
  const keys = Object.keys(updates);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  }
}

describe("Vitest worker budget wiring", () => {
  test("vite.config.ts derives maxWorkers from the fixed gate memory budget", async () => {
    await withEnvironment(
      {
        GATE_MEMORY_BYTES: String(TWO_GIB),
        STRYKER_MEMORY_BYTES: undefined,
        VITEST: "true",
      },
      async () => {
        const { default: config } = await import("../vite.config.ts");
        expect(config.test.experimental.fsModuleCache).toBe(true);
        expect(config.test.maxWorkers).toBe(
          workerCount({
            perWorkerBytes: VITEST_WORKER_BYTES,
            baseBytes: VITEST_BASE_BYTES,
            budgetBytes: TWO_GIB,
            env: process.env,
          }),
        );
      },
    );
  });

  test("vite.config.ts applies the logical-CPU factor when memory does not bind", async () => {
    await withEnvironment(
      {
        GATE_MEMORY_BYTES: String(100 * 1024 ** 3),
        STRYKER_MEMORY_BYTES: undefined,
        GATE_CPU_SHARE: undefined,
        VITEST: "true",
      },
      async () => {
        const { default: config } = await import("../vite.config.ts");
        expect(config.test.maxWorkers).toBe(
          Math.max(1, Math.floor(os.availableParallelism() / VITEST_LOGICAL_CPUS_PER_WORKER)),
        );
      },
    );
  });

  test("vite.config.ts uses one worker under Stryker without a gate budget", async () => {
    await withEnvironment(
      {
        GATE_MEMORY_BYTES: undefined,
        STRYKER_MEMORY_BYTES: "256",
        VITEST: "true",
      },
      async () => {
        const { default: config } = await import("../vite.config.ts");
        expect(config.test.experimental.fsModuleCache).toBe(false);
        expect(config.test.maxWorkers).toBe(1);
      },
    );
  });

  test("Vitest cache key includes config-level transform inputs", async () => {
    await withEnvironment({ VITEST: "true" }, async () => {
      const { createVitestCacheKeyPlugin, default: config } = await import("../vite.config.ts");
      const plugin = config.plugins.find(
        (candidate) => candidate.name === "chessfable:vitest-cache-key",
      );
      let generateCacheKey;
      plugin.configureVitest({
        experimental_defineCacheKeyGenerator(generator) {
          generateCacheKey = generator;
        },
      });

      const tsconfigText = readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8");
      const platform = os.platform();
      const firstKey = generateCacheKey({
        environment: {},
        id: "/first/module.ts",
        sourceCode: "export const value = 1;",
      });
      const secondKey = generateCacheKey({
        environment: {},
        id: "/second/module.ts",
        sourceCode: "export const value = 2;",
      });

      expect(firstKey).toContain(tsconfigText);
      expect(firstKey).toContain(platform);
      expect(firstKey).toBe(secondKey);
      expect(config.define["import.meta.env.VITE_PLATFORM"]).toBe(JSON.stringify(platform));

      let changedCacheKey;
      createVitestCacheKeyPlugin(`${tsconfigText}\n`, platform).configureVitest({
        experimental_defineCacheKeyGenerator(generator) {
          changedCacheKey = generator;
        },
      });
      expect(changedCacheKey({ environment: {}, id: "/module.ts", sourceCode: "" })).not.toBe(
        firstKey,
      );
    });
  });

  test("the Stryker path does not read injected unreadable cgroup files", () => {
    let reads = 0;
    expect(
      vitestMaxWorkers({
        env: { VITEST: "true", STRYKER_MEMORY_BYTES: "256" },
        readFileSync() {
          reads += 1;
          throw new Error("cgroup is unreadable");
        },
        statSync() {
          reads += 1;
          throw new Error("cgroup is unreadable");
        },
      }),
    ).toBe(1);
    expect(reads).toBe(0);
  });
});
