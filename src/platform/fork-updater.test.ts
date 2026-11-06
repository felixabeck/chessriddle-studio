import { expect, test } from "vitest";

import tauriConfigText from "../../src-tauri/tauri.conf.json?raw";
import capabilityText from "../../src-tauri/capabilities/main.json?raw";
import publicKeyFile from "../../src-tauri/keys/release.minisign.pub?raw";
import releaseWorkflow from "../../.github/workflows/release.yml?raw";

const FORK_UPDATE_ENDPOINT =
    "https://github.com/felixabeck/chessriddle-studio/releases/latest/download/latest.json";
const RETIRED_UPSTREAM_KEY = "RWSF3PMxhuaQf7613UytN4bdF7FQyBymLJVDIG3OE8xNa+0fcs6KE6/J";

type JsonObject = Record<string, unknown>;

/** A minisign key line decodes to `Ed` + 8-byte key id + 32-byte Ed25519 key. */
function decodeKeyLine(line: string): { keyId: string; key: string } {
    const bytes = Uint8Array.from(atob(line.trim()), (character) => character.charCodeAt(0));
    expect(bytes.length).toBe(42);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe("Ed");
    const hex = (slice: Uint8Array) =>
        Array.from(slice, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { keyId: hex(bytes.slice(2, 10)), key: hex(bytes.slice(10)) };
}

function keyLineOf(pubFile: string): string {
    const line = pubFile.split("\n")[1];
    expect(line).toMatch(/^RW[A-Za-z0-9+/=]+$/);
    return line;
}

function updaterConfig(): JsonObject {
    const config = JSON.parse(tauriConfigText) as JsonObject;
    return (config.plugins as JsonObject).updater as JsonObject;
}

/** Top-level job block of release.yml, from its `  name:` line to the next job. */
function jobBlock(name: string): string {
    const match = new RegExp(`^  ${name}:\\n((?:(?:    .*)?\\n)+)`, "m").exec(releaseWorkflow);
    if (!match) throw new Error(`release.yml has no job ${name}`);
    return match[1];
}

test("updater endpoint is exactly this fork's latest release", () => {
    expect(updaterConfig().endpoints).toEqual([FORK_UPDATE_ENDPOINT]);
    const config = JSON.parse(tauriConfigText) as { bundle: JsonObject };
    expect(config.bundle.createUpdaterArtifacts).toBe(true);
});

test("updater pubkey decodes to the tracked release.minisign.pub key", () => {
    const updaterPubFile = atob(updaterConfig().pubkey as string);
    expect(updaterPubFile).toBe(publicKeyFile);
    expect(decodeKeyLine(keyLineOf(updaterPubFile))).toEqual(
        decodeKeyLine(keyLineOf(publicKeyFile)),
    );
    expect(updaterPubFile).not.toContain(RETIRED_UPSTREAM_KEY);
    expect(tauriConfigText).not.toContain(RETIRED_UPSTREAM_KEY);
});

test("capability grants exact updater permissions, never updater:default", () => {
    const permissions = (JSON.parse(capabilityText) as JsonObject).permissions as unknown[];
    expect(permissions).toEqual(
        expect.arrayContaining([
            "updater:allow-check",
            "updater:allow-download-and-install",
            "process:allow-restart",
        ]),
    );
    expect(permissions).not.toContain("updater:default");
    expect(
        permissions.filter((p) => typeof p === "string" && p.startsWith("updater:")).sort(),
    ).toEqual(["updater:allow-check", "updater:allow-download-and-install"]);
});

test("release.yml builds on tags into one draft and publishes only a complete matrix", () => {
    expect(releaseWorkflow).not.toMatch(/^\s+branches:/m);

    const createRelease = jobBlock("create-release");
    expect(createRelease).toContain("if: startsWith(github.ref, 'refs/tags/v')");
    expect(createRelease).toMatch(/contents: write/);
    expect(createRelease).toMatch(/release_id:/);
    expect(createRelease).toMatch(/--draft/);

    const build = jobBlock("release");
    expect(build).toMatch(/needs: create-release/);
    expect(build).toMatch(/fail-fast: false/);
    expect(build).toContain("releaseId: ${{ needs.create-release.outputs.release_id }}");
    expect(build).toMatch(/includeUpdaterJson: true/);
    expect(build).not.toMatch(/releaseDraft: false/);
    for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
        expect(build).toContain(`--target ${target}`);
    }
    expect(build).toMatch(/platform: 'ubuntu-/);
    expect(build).toMatch(/platform: 'windows-/);

    const publish = jobBlock("publish");
    expect(publish).toMatch(
        /needs: \[?create-release, release\]?|needs:\n\s+- create-release\n\s+- release/,
    );
    expect(publish).toContain("if: success() && startsWith(github.ref, 'refs/tags/v')");
    expect(publish).toMatch(/contents: write/);
    expect(publish).toMatch(/gh release download/);
    expect(publish).toMatch(/latest\.json/);
    for (const platform of ["linux-x86_64", "darwin-aarch64", "darwin-x86_64", "windows-x86_64"]) {
        expect(publish).toContain(platform);
    }
    expect(publish).toMatch(/--draft=false/);
});
