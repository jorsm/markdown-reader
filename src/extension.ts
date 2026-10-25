import * as vscode from "vscode";
import { NativePlayer } from "./reader/NativePlayer";
import { ReaderPanel, type Deps } from "./reader/ReaderPanel";
import { Synthesizer } from "./reader/Synthesizer";
import { Telemetry } from "./telemetry/Telemetry";
import { InworldClient, InworldError } from "./tts/InworldClient";

const KEY_SECRET = "markdownReader.inworldApiKey";

/** Registers the commands; the reader's shared services are built on first use, so activation never waits on them. */
export function activate(context: vscode.ExtensionContext): void {
    // Metadata only, like telemetry: never document text or the key.
    const log = vscode.window.createOutputChannel("Markdown Reader", { log: true });
    context.subscriptions.push(log);
    let deps: Promise<Deps> | undefined;

    context.subscriptions.push(
        vscode.commands.registerCommand("markdownReader.open", async (uri?: vscode.Uri) => {
            const document = await markdownDocument(uri);
            if (!document) {
                void vscode.window.showWarningMessage("Open a Markdown file to read it aloud.");
                return;
            }
            ReaderPanel.show(context, document, await (deps ??= createDeps(context, log)));
        }),
        vscode.commands.registerCommand("markdownReader.setApiKey", () => askForKey(context)),
        vscode.commands.registerCommand("markdownReader.clearCache", async () => clearCache((await (deps ??= createDeps(context, log))).synthesizer)),
    );
}

/** Stops ffplay, which would otherwise outlive the extension host (frozen, if it was paused). */
export function deactivate(): void {
    activePlayer?.stop();
}

let activePlayer: Deps["player"];

async function createDeps(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): Promise<Deps> {
    const settings = vscode.workspace.getConfiguration("markdownReader");
    const storage = context.globalStorageUri;
    const telemetry = new Telemetry(storage.fsPath);
    // Several units are prepared at once: they share one prompt when the key is missing.
    let asking: Promise<string | undefined> | undefined;
    const client = new InworldClient(async () => (await context.secrets.get(KEY_SECRET)) ?? (await (asking ??= askForKey(context).finally(() => (asking = undefined)))));
    const synthesizer = new Synthesizer(vscode.Uri.joinPath(storage, "audio").fsPath, client, telemetry, () => vscode.workspace.getConfiguration("markdownReader").get<Record<string, number>>("pricePerMillionCharacters", {}));
    const output = settings.get<string>("audioOutput", "auto");
    const found = output === "webview" ? { error: 'markdownReader.audioOutput is "webview"' } : await NativePlayer.find();
    const player = "player" in found ? found.player : undefined;
    activePlayer = player;
    log.info(player ? "Audio output: ffplay" : `Audio output: panel (${"error" in found ? found.error : ""}); PATH=${process.env.PATH ?? ""}`);
    if (output === "ffplay" && !player) {
        void vscode.window.showErrorMessage('Markdown Reader: ffplay can\'t be used, so audio plays in the panel. See the "Markdown Reader" output for why; install FFmpeg, or set markdownReader.audioOutput to "webview".');
    }
    return { client, player, synthesizer, telemetry };
}

/** Deletes all cached audio after confirmation; listening again re-synthesizes, and Inworld bills it again. */
async function clearCache(synthesizer: Synthesizer): Promise<void> {
    const { files, bytes } = await synthesizer.stats();
    if (!files) {
        void vscode.window.showInformationMessage("Markdown Reader: the audio cache is already empty.");
        return;
    }
    const answer = await vscode.window.showWarningMessage(`Delete ${files} cached audio files (${(bytes / 1_048_576).toFixed(1)} MB)?`, { modal: true, detail: "Every sentence you listen to again is synthesized again, and Inworld bills it again." }, "Delete");
    if (answer === "Delete") {
        await synthesizer.clear();
        void vscode.window.showInformationMessage(`Markdown Reader: deleted ${files} cached audio files.`);
    }
}

async function askForKey(context: vscode.ExtensionContext): Promise<string | undefined> {
    const key = await vscode.window.showInputBox({
        title: "Inworld API key",
        prompt: "The Base64 credential from the Inworld portal (API Keys → Basic). Stored in VS Code's secret storage.",
        password: true,
        ignoreFocusOut: true,
    });
    const candidate = key?.trim();
    if (!candidate) {
        return undefined;
    }
    const previous = await context.secrets.get(KEY_SECRET);
    const unchanged = previous ? "Your previous API key is still being used." : "No API key was saved.";
    if (!isBasicCredential(candidate)) {
        void vscode.window.showErrorMessage(`Enter the Base64 key:secret credential from Inworld's API Keys page. ${unchanged}`);
        return undefined;
    }
    try {
        await new InworldClient(async () => candidate).listVoices();
    } catch (error) {
        if (error instanceof InworldError && (error.status === 401 || error.status === 403)) {
            void vscode.window.showErrorMessage(`Inworld rejected the new API key (${error.status}). ${unchanged}`);
            return undefined;
        }
        await context.secrets.store(KEY_SECRET, candidate);
        void vscode.window.showWarningMessage("The Inworld API key was saved, but it could not be verified. It will be checked when you next use the reader.");
        return candidate;
    }
    await context.secrets.store(KEY_SECRET, candidate);
    await ReaderPanel.refreshVoices();
    return candidate;
}

function isBasicCredential(value: string): boolean {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        return false;
    }
    const decoded = Buffer.from(value, "base64");
    const canonical = decoded.toString("base64");
    if (value !== canonical && value !== canonical.replace(/=+$/, "")) {
        return false;
    }
    const credential = decoded.toString("utf8");
    const colon = credential.indexOf(":");
    return colon > 0 && colon < credential.length - 1;
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
