import type { EngineCompletion, EngineInstallIntent } from "@/bindings";
import { tauri } from "@/platform/tauri";
import type { DefaultEngine } from "./engines";

/** Installs or adopts a verified catalog artefact; shared with catalog upgrades. */
export async function installCatalogEngine(
    engine: DefaultEngine,
    progressId: string,
    ticket: string,
    intent: EngineInstallIntent = { kind: "add", engine_id: crypto.randomUUID() },
    operationId: string = crypto.randomUUID(),
): Promise<EngineCompletion> {
    const url = engine.downloadLink;
    if (!url) throw new Error("engine download link is required");
    const root = (await tauri.getEngineWorkspace()).root;
    return tauri.installEngineWorkflow(
        operationId,
        {
            intent,
            root,
            progressId,
            url,
            sha256: engine.sha256,
            signature: engine.signature,
            relativePath: engine.path,
            name: engine.name,
            version: engine.version,
            elo: engine.elo ?? null,
            downloadSize: engine.downloadSize ?? null,
        },
        ticket,
    );
}
