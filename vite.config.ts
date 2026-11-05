/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig, type Plugin } from "vite";
import * as os from "node:os";
import { vitestMaxWorkers } from "./scripts/gate-parallelism.mjs";

const isDebug = !!process.env.TAURI_ENV_DEBUG;
const host = process.env.TAURI_DEV_HOST;
const platform = os.platform();
const tsconfigText = readFileSync(resolve(import.meta.dirname, "tsconfig.json"), "utf8");

// Add tsconfig and resolved define inputs; Vitest hashes config contents and plugin names but omits both.
export function createVitestCacheKeyPlugin(configText: string, definedPlatform: string): Plugin {
    const cacheKey = `tsconfig.json:${configText}\nimport.meta.env.VITE_PLATFORM:${definedPlatform}`;

    return {
        name: "chessfable:vitest-cache-key",
        configureVitest(context) {
            context.experimental_defineCacheKeyGenerator(() => cacheKey);
        },
    };
}

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        createVitestCacheKeyPlugin(tsconfigText, platform),
        tanstackRouter({
            target: "react",
        }),
        react(),
        babel({
            presets: [reactCompilerPreset()],
        }),
    ],
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        hmr: host
            ? {
                  protocol: "ws",
                  host,
                  port: 1421,
              }
            : undefined,
        watch: {
            ignored: ["**/src-tauri/**"],
        },
    },
    build: {
        manifest: true,
        minify: isDebug ? false : "esbuild",
        sourcemap: isDebug ? "inline" : false,
        // Generated IPC bindings use bigint for Rust u64 values. ES2020 is the
        // minimum honest output contract for every supported WebView.
        target: "es2020",
        // The checked-in gzip graph budgets are the release gate; Vite's raw
        // per-file heuristic neither accounts for caching nor compressed transfer.
        chunkSizeWarningLimit: 1_300,
    },
    resolve: {
        alias: {
            "@": resolve(import.meta.dirname, "./src"),
        },
    },
    test: {
        environment: "jsdom",
        // Node 25+ enables its own Web Storage globals, which shadow jsdom's sessionStorage and
        // localStorage (undefined without --localstorage-file, and not jsdom's Storage class).
        // Keep jsdom's, on every Node version that knows the flag.
        execArgv: process.allowedNodeEnvironmentFlags.has("--no-experimental-webstorage")
            ? ["--no-experimental-webstorage"]
            : [],
        setupFiles: ["./src/tests/setup.ts"],
        include: ["src/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.test.mjs"],
        exclude: ["**/node_modules/**", ".stryker-tmp/**", "e2e/**"],
        // Size Vitest workers from the gate memory budget at one per two logical CPUs;
        // Stryker forces one worker per runner.
        maxWorkers: vitestMaxWorkers(),
        // Once warm, persistent transforms keep cold compilation out of timed tests (a cold cache still
        // transforms inside them; f-20260930-02): warm totals fell 112s → 2.45s, and the first tests fell
        // 2.3s → 0.26s. Stryker sandboxes have random roots, so cache copies
        // would accumulate per run. Vitest clears this on pnpm-lock.yaml changes; otherwise it holds
        // one entry per transformed module version (~20 MB for the full suite).
        experimental: { fsModuleCache: process.env.STRYKER_MEMORY_BYTES === undefined },
        coverage: {
            provider: "v8",
            reporter: ["text", "json-summary", "lcov"],
            all: true,
            include: ["src/**/*.ts", "src/**/*.tsx"],
            exclude: [
                "src/**/*.test.ts",
                "src/**/*.test.tsx",
                "src/**/*.spec.ts",
                "src/**/*.spec.tsx",
                "src/**/tests/**",
                "src/bindings/generated.ts",
                "src/routeTree.gen.ts",
                "src/vite-env.d.ts",
            ],
        },
    },
    define: {
        "import.meta.env.VITE_PLATFORM": JSON.stringify(platform),
    },
});
