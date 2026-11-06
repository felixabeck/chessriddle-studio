import { describe, expect, test } from "vitest";
import { shippedCatalogues } from "@/tests/catalogues";
import { PRODUCT_NAME, REPOSITORY_URL } from "./product.json";
import config from "../../src-tauri/tauri.conf.json";
import cargoManifest from "../../src-tauri/Cargo.toml?raw";
import contributionGuide from "../../CONTRIBUTING.md?raw";
import bugForm from "../../.github/ISSUE_TEMPLATE/bug.yml?raw";
import indexDocument from "../../index.html?raw";
import artifactVerifier from "../../src-tauri/src/fs.rs?raw";
import releasePublicKey from "../../src-tauri/keys/release.minisign.pub?raw";

describe("product identity", () => {
    test("keeps independent native, document and renderer inputs consistent", () => {
        expect(PRODUCT_NAME).toBe("ChessRiddle Studio");
        expect(config.productName).toBe(PRODUCT_NAME);
        expect(config.mainBinaryName).toBe("chessriddle-studio");
        expect(config.bundle.publisher).toBe("Felix Beck");
        expect(config.app.windows[0].title).toBe(PRODUCT_NAME);
        expect(indexDocument).toContain(`<title>${PRODUCT_NAME}</title>`);
    });

    test("routes source, contribution and bug support to the fork", () => {
        expect(REPOSITORY_URL).toBe("https://github.com/felixabeck/chessriddle-studio");
        expect(cargoManifest).toContain(`repository = "${REPOSITORY_URL}"`);
        expect(contributionGuide).toContain(`${REPOSITORY_URL}/compare`);
        expect(bugForm).toContain(`${REPOSITORY_URL}/issues?q=`);
    });

    test("brands changed catalogue keys while preserving upstream attribution", () => {
        const brandedKeys = [
            "Engines.Remove.Message",
            "Menu.Application.About",
            "Menu.Application.Hide",
            "Menu.Application.Quit",
            "Settings.Version",
        ];
        for (const { translation } of shippedCatalogues()) {
            const brandedValues = brandedKeys.map((key) => translation[key]).join("\n");
            expect(brandedValues).not.toContain("En Croissant");
            expect(brandedValues).not.toContain("En-Croissant");
            expect(brandedValues).not.toContain("ChessFable");
            expect(translation["Error.ReportIssue"]).toMatch(/<github>[^<]+<\/github>/u);
            expect(translation["Error.ReportIssue"]).not.toContain("discord");
            expect(translation["About.ModificationNotice"]).toContain("En Croissant");
        }
    });

    test("trusts only the fork release key for artifact and catalog signatures", () => {
        const [comment, keyLine] = releasePublicKey.split("\n");
        expect(comment).toMatch(/^untrusted comment: minisign public key: [0-9A-F]{16}$/u);
        expect(keyLine).toMatch(/^RW[A-Za-z0-9+/]{54}$/u);
        expect(artifactVerifier).toContain('include_str!("../keys/release.minisign.pub")');
        expect(artifactVerifier).not.toContain("ARTIFACT_MANIFEST_PUBLIC_KEY");
        expect(artifactVerifier).not.toContain("RWSF3PMxhuaQf7613UytN4bdF7FQyBymLJVDIG3OE8xNa");
    });
});
