import * as vscode from "vscode";
import { NativePlayer } from "./reader/NativePlayer";
import { ReaderPanel, type Deps } from "./reader/ReaderPanel";
import { Synthesizer } from "./reader/Synthesizer";
import { Telemetry } from "./telemetry/Telemetry";
import { InworldClient } from "./tts/InworldClient";

const KEY_SECRET = "markdownReader.inworldApiKey";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const storage = context.globalStorageUri;
    const telemetry = new Telemetry(storage.fsPath);
    // Several units are prepared at once: they share one prompt when the key is missing.
    let asking: Promise<string | undefined> | undefined;
    const client = new InworldClient(async () => (await context.secrets.get(KEY_SECRET)) ?? (await (asking ??= askForKey(context).finally(() => (asking = undefined)))));
    const synthesizer = new Synthesizer(vscode.Uri.joinPath(storage, "audio").fsPath, client, telemetry, () => vscode.workspace.getConfiguration("markdownReader").get<Record<string, number>>("pricePerMillionCharacters", {}));
    // Metadata only, like telemetry: never document text or the key.
    const log = vscode.window.createOutputChannel("Markdown Reader", { log: true });
    context.subscriptions.push(log);
    const output = vscode.workspace.getConfiguration("markdownReader").get<string>("audioOutput", "auto");
    const found = output === "webview" ? { error: 'markdownReader.audioOutput is "webview"' } : await NativePlayer.find();
    const player = "player" in found ? found.player : undefined;
    log.info(player ? "Audio output: ffplay" : `Audio output: panel (${"error" in found ? found.error : ""}); PATH=${process.env.PATH ?? ""}`);
    if (output === "ffplay" && !player) {
        void vscode.window.showErrorMessage('Markdown Reader: ffplay can\'t be used, so audio plays in the panel. See the "Markdown Reader" output for why; install FFmpeg, or set markdownReader.audioOutput to "webview".');
    }
    const deps: Deps = { client, player, synthesizer, telemetry };

    context.subscriptions.push(
        vscode.commands.registerCommand("markdownReader.open", async (uri?: vscode.Uri) => {
            const document = await markdownDocument(uri);
            if (!document) {
                void vscode.window.showWarningMessage("Open a Markdown file to read it aloud.");
                return;
            }
            ReaderPanel.show(context, document, deps);
        }),
        vscode.commands.registerCommand("markdownReader.setApiKey", () => askForKey(context)),
    );
}

export function deactivate(): void {}

async function askForKey(context: vscode.ExtensionContext): Promise<string | undefined> {
    const key = await vscode.window.showInputBox({
        title: "Inworld API key",
        prompt: "The Base64 credential from the Inworld portal (API Keys → Basic). Stored in VS Code's secret storage.",
        password: true,
        ignoreFocusOut: true,
    });
    if (key?.trim()) {
        await context.secrets.store(KEY_SECRET, key.trim());
        return key.trim();
    }
    return undefined;
}

/** The document to read: the clicked file, the active Markdown editor, or the one behind the active Markdown preview. */
async function markdownDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    if (uri?.scheme === "file") {
        return vscode.workspace.openTextDocument(uri);
    }
    const active = vscode.window.activeTextEditor?.document;
    if (active?.languageId === "markdown") {
        return active;
    }
    return vscode.window.visibleTextEditors.map((e) => e.document).find((d) => d.languageId === "markdown");
}
