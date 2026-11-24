import { expect, test } from "vitest";

import tauriConfigText from "../../src-tauri/tauri.conf.json?raw";
import capabilityText from "../../src-tauri/capabilities/main.json?raw";
import publicKeyFile from "../../src-tauri/keys/release.minisign.pub?raw";
import releaseWorkflow from "../../.github/workflows/release.yml?raw";
import changelog from "../../CHANGELOG.md?raw";
import packageManifest from "../../package.json";
import { main, releaseNotes } from "../../scripts/release-notes.mjs";

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
            "updater:allow-download",
            "updater:allow-install",
            "process:allow-restart",
        ]),
    );
    expect(permissions).not.toContain("updater:default");
    expect(
        permissions.filter((p) => typeof p === "string" && p.startsWith("updater:")).sort(),
    ).toEqual(["updater:allow-check", "updater:allow-download", "updater:allow-install"]);
});

test("release.yml builds on tags into one draft and publishes only a complete matrix", () => {
    expect(releaseWorkflow).not.toMatch(/^\s+branches:/m);

    const createRelease = jobBlock("create-release");
    expect(createRelease).toContain(
        "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
    );
    expect(createRelease).toMatch(/contents: write/);
    expect(createRelease).toMatch(/release_id:/);
    expect(createRelease).toContain("draft: true");
    // The id must come from the create response, never from a follow-up listing (run 42286539160).
    expect(createRelease).toContain("--jq .id)");
    expect(createRelease).not.toMatch(/gh api "repos\/\$GITHUB_REPOSITORY\/releases" \\\n/);

    const build = jobBlock("release");
    expect(build).toMatch(/needs: create-release/);
    expect(build).toMatch(/fail-fast: false/);
    expect(build).toContain("releaseId: ${{ needs.create-release.outputs.release_id }}");
    expect(build).toMatch(/includeUpdaterJson: true/);
    expect(build).not.toMatch(/releaseDraft: false/);
    for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
        // The updater needs the app bundle's .app.tar.gz; dmg alone leaves darwin out of latest.json.
        expect(build).toContain(`--target ${target} --bundles app,dmg`);
    }
    expect(build).toMatch(/platform: 'ubuntu-/);
    expect(build).toMatch(/platform: 'windows-/);

    const publish = jobBlock("publish");
    expect(publish).toMatch(
        /needs: \[?create-release, release\]?|needs:\n\s+- create-release\n\s+- release/,
    );
    expect(publish).toContain(
        "if: success() && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
    );
    expect(publish).toMatch(/contents: write/);
    expect(publish).toMatch(/gh release download/);
    expect(publish).toMatch(/latest\.json/);
    for (const platform of ["linux-x86_64", "darwin-aarch64", "darwin-x86_64", "windows-x86_64"]) {
        expect(publish).toContain(platform);
    }
    expect(publish).toMatch(/--draft=false/);
});

test("release.yml never lets a macOS bundle out that is not a notarized Developer ID build", () => {
    const build = jobBlock("release");
    const appleSecrets = [
        "APPLE_CERTIFICATE",
        "APPLE_CERTIFICATE_PASSWORD",
        "APPLE_SIGNING_IDENTITY",
        "APPLE_API_KEY",
        "APPLE_API_ISSUER",
    ];
    // Every secret is required before the build: an empty one means an ad-hoc signed bundle.
    for (const secret of [...appleSecrets, "APPLE_API_KEY_P8"]) {
        expect(build).toContain(`          ${secret}: \${{ secrets.${secret} }}\n`);
    }
    expect(build).toContain(
        '[ -n "${!name}" ] || { echo "::error::secret $name is empty"; missing=1; }',
    );
    expect(build).toContain(
        "      - name: Require the Apple secrets and write the notarization key (macOS only)\n" +
            "        if: runner.os == 'macOS'\n",
    );
    expect(build).toContain(
        "for name in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY \\\n" +
            "            APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_P8; do\n",
    );
    expect(build).toContain('[ "$missing" -eq 0 ] || exit 1\n');
    expect(build).toContain('echo "APPLE_API_KEY_PATH=$key_path" >> "$GITHUB_ENV"');
    // The build receives them on the macOS legs only.
    for (const secret of appleSecrets) {
        expect(build).toContain(
            `${secret}: \${{ runner.os == 'macOS' && secrets.${secret} || '' }}`,
        );
    }
    // The leg fails, and with it the publish job, unless Gatekeeper names the notarized build.
    expect(build).toContain('codesign --verify --deep --strict --verbose=2 "$app"');
    expect(build).toContain('xcrun stapler validate "$app"');
    expect(build).toContain(
        'assessment=$(spctl --assess --type execute --verbose=4 "$app" 2>&1) || { echo "$assessment"; exit 1; }',
    );
    expect(build).toContain('*"source=Notarized Developer ID"*) ;;');
    expect(build).toMatch(
        /^ {12}\*\) echo "::error::Gatekeeper accepted the app, .*"; exit 1 ;;$/m,
    );
    expect(build).toContain('codesign --verify --strict --verbose=2 "$dmg"');
    // Tauri only signs the disk image; the workflow notarizes it and Gatekeeper has to agree.
    // The step carries the key id and issuer itself, on the macOS legs only.
    expect(build).toContain(
        [
            "      - name: Verify signature and notarization (macOS only)",
            "        if: runner.os == 'macOS'",
            "        shell: bash",
            "        env:",
            "          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}",
            "          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}",
            "        run: |",
        ].join("\n"),
    );
    expect(build).toContain(
        'xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait\n',
    );
    expect(build).toContain(
        'dmg_assessment=$(spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg" 2>&1) || { echo "$dmg_assessment"; exit 1; }',
    );
    expect(build).toMatch(
        /case "\$dmg_assessment" in\n {12}\*"source=Notarized Developer ID"\*\) ;;\n {12}\*\) echo "::error::Gatekeeper accepted the disk image, .*"; exit 1 ;;$/m,
    );
});

test("a manual dispatch of release.yml rehearses the build and can never publish", () => {
    expect(releaseWorkflow).toMatch(/^ {2}workflow_dispatch:$/m);
    // The legs run without a draft, so tauri-action has no release to upload into.
    expect(jobBlock("release")).toContain(
        "if: ${{ !cancelled() && (needs.create-release.result == 'success' || (github.event_name == 'workflow_dispatch' && needs.create-release.result == 'skipped')) }}\n",
    );
});

test("CHANGELOG.md has release notes for the current version", () => {
    expect(releaseNotes(changelog, packageManifest.version)).toMatch(/^### /);
});

test("release notes are the version's section up to the next version", () => {
    const text = "# Changelog\n\n## 2.0.0\n\n- two\n\n## 1.0.0\n\n- one\n";
    expect(releaseNotes(text, "2.0.0")).toBe("- two\n");
    expect(releaseNotes(text, "1.0.0")).toBe("- one\n");
    expect(() => releaseNotes(text, "3.0.0")).toThrow('no section "## 3.0.0"');
    expect(() => releaseNotes("## 2.0.0\n\n## 1.0.0\n- one\n", "2.0.0")).toThrow("is empty");
    for (const html of ["<b>x</b>", "</p>", "<!-- note -->", "<!DOCTYPE html>", "<?xml?>"]) {
        expect(() => releaseNotes(`## 2.0.0\n- ${html}\n`, "2.0.0")).toThrow("raw HTML");
    }
    expect(releaseNotes("## 2.0.0\n- 3 < 4 and [link](https://x.y)\n", "2.0.0")).toBe(
        "- 3 < 4 and [link](https://x.y)\n",
    );
});

test("the release-notes command takes a v-tag and fails a bad or missing section", () => {
    const files: Record<string, string> = {
        "CHANGELOG.md": changelog,
        "test.md": "# Changelog\n\n## 2.0.0\n\n- two\n\n## 1.0.0\n",
    };
    const readText = (path: string) => {
        if (!(path in files)) throw new Error(`no file ${path}`);
        return files[path];
    };

    expect(main(["v2.0.0", "test.md"], readText)).toEqual({
        status: 0,
        stdout: "- two\n",
        stderr: "",
    });
    for (const tag of ["v3.0.0", "v1.0.0"]) {
        const failed = main([tag, "test.md"], readText);
        expect(failed).toMatchObject({ status: 1, stdout: "" });
        expect(failed.stderr).toMatch(/^::error::CHANGELOG\.md/);
    }
    expect(main([], readText)).toMatchObject({ status: 2, stdout: "" });
    expect(main([`v${packageManifest.version}`], readText)).toMatchObject({ status: 0 });
});

test("release.yml publishes the tag's notes as the draft's body", () => {
    const createRelease = jobBlock("create-release");
    expect(createRelease).toMatch(
        /sparse-checkout: \|\n\s+CHANGELOG\.md\n\s+scripts\/release-notes\.mjs\n/,
    );
    expect(createRelease).toContain(
        'run: node scripts/release-notes.mjs "$TAG" > "$RUNNER_TEMP/release-notes.md"',
    );
    expect(createRelease).toMatch(
        /- name: Extract the release notes\n\s+env:\n\s+TAG: \$\{\{ github\.ref_name \}\}\n/,
    );
    expect(createRelease).toContain('--rawfile body "$RUNNER_TEMP/release-notes.md"');
    expect(createRelease).toContain("body: $body}");
    expect(createRelease).toContain(
        'gh api --method POST "repos/$GITHUB_REPOSITORY/releases" --input - --jq .id',
    );
});
