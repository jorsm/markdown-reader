import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import type { Telemetry, TelemetryEvent } from "../telemetry/Telemetry";
import { contextFor, renderDocument, type Unit } from "../text/units";
import { InworldError, type InworldClient, type Voice } from "../tts/InworldClient";
import type { Synthesizer } from "./Synthesizer";
import type { NativePlayer } from "./NativePlayer";
import { Scheduler } from "./Scheduler";

/** Inworld's tier-1 languages, English first. */
export const LANGUAGES: [
    code: string,
    name: string,
][] = [
    [
        "en",
        "English",
    ],
    [
        "it",
        "Italiano",
    ],
    [
        "de",
        "Deutsch",
    ],
    [
        "es",
        "Español",
    ],
    [
        "fr",
        "Français",
    ],
    [
        "pt",
        "Português",
    ],
    [
        "nl",
        "Nederlands",
    ],
    [
        "pl",
        "Polski",
    ],
    [
        "ru",
        "Русский",
    ],
    [
        "ar",
        "العربية",
    ],
    [
        "he",
        "עברית",
    ],
    [
        "hi",
        "हिन्दी",
    ],
    [
        "zh",
        "中文",
    ],
    [
        "ja",
        "日本語",
    ],
    [
        "ko",
        "한국어",
    ],
];

const DEFAULT_VOICES: Record<string, string> = { en: "Elliot", it: "Orietta" };
/** Silence after each kind of unit at 1×, in milliseconds; divided by the speed. Mirrors `PAUSE_MS` in media/reader.js. */
const PAUSE_MS: Record<string, number> = { heading: 650, sentence: 280, row: 200 };

interface Choice {
    language: string;
    voice: string;
}

/** One reading panel per Markdown document. */
export class ReaderPanel {
    private static readonly panels = new Map<string, ReaderPanel>();

    private units: Unit[] = [];
    private byId = new Map<string, Unit>();
    private voices: Voice[] | undefined;
    private lastError: string | undefined;
    private choice: Choice;
    private readonly scheduler: Scheduler;
    private readonly disposables: vscode.Disposable[] = [];
    /** Native playback (ffplay): prepared audio files by unit id, and who waits for them. */
    private readonly files = new Map<string, string>();
    private readonly waiters = new Map<string, { resolve: (file: string) => void; reject: (error: unknown) => void }[]>();
    private session = 0;
    private speed = 1.5;
    private paused = false;
    private onResume: (() => void) | undefined;

    static show(context: vscode.ExtensionContext, document: vscode.TextDocument, deps: Deps): void {
        const key = document.uri.toString();
        const existing = ReaderPanel.panels.get(key);
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.Beside);
            return;
        }
        ReaderPanel.panels.set(key, new ReaderPanel(context, document, deps));
    }

    private readonly panel: vscode.WebviewPanel;

    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly document: vscode.TextDocument,
        private readonly deps: Deps,
    ) {
        this.choice = context.workspaceState.get<Choice>(choiceKey(document)) ?? context.globalState.get<Choice>("markdownReader.lastChoice") ?? { language: "en", voice: DEFAULT_VOICES.en! };
        this.panel = vscode.window.createWebviewPanel(
            "markdownReader",
            `Read: ${vscode.workspace.asRelativePath(document.uri)}`,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
            },
        );
        this.panel.iconPath = new vscode.ThemeIcon("unmute");
        this.scheduler = new Scheduler(
            () => config().get<number>("concurrency", 3),
            (id, signal) => this.prepare(id, signal),
        );
        this.panel.webview.html = this.html();
        this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), undefined, this.disposables);
        this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
        vscode.workspace.onDidSaveTextDocument(
            (d) => {
                if (d === this.document) {
                    this.render();
                }
            },
            undefined,
            this.disposables,
        );
    }

    private dispose(): void {
        this.stopNative();
        this.scheduler.reset();
        ReaderPanel.panels.delete(this.document.uri.toString());
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    private async onMessage(message: any): Promise<void> {
        switch (message?.type) {
            case "ready":
                this.scheduler.reset();
                this.render();
                await this.sendVoices();
                break;
            case "want":
                this.scheduler.want((message.ids as string[]).filter((id) => this.byId.has(id)));
                break;
            case "reveal":
                await this.reveal(Number(message.line));
                break;
            case "choose":
                await this.choose({ language: String(message.language), voice: String(message.voice ?? "") });
                break;
            case "start": {
                this.speed = Number(message.speed) || this.speed;
                const index = this.units.findIndex((u) => u.id === message.id);
                if (index >= 0) {
                    void this.playFrom(index);
                }
                break;
            }
            case "pause":
                this.paused = true;
                this.deps.player?.pause();
                break;
            case "resume":
                this.paused = false;
                this.deps.player?.resume();
                this.onResume?.();
                break;
            case "model":
                await this.chooseModel(String(message.value));
                break;
            case "speed":
                // ffplay's tempo is fixed per process: the new speed applies from the next unit.
                this.speed = Number(message.value) || this.speed;
                break;
            case "playbackError":
                this.notifyError(`Markdown Reader: playback failed. ${String(message.message)}`);
                break;
            case "telemetry":
                this.deps.telemetry.record(message.event as TelemetryEvent);
                break;
        }
    }

    private render(): void {
        const { html, units } = renderDocument(this.document.getText(), this.choice.language);
        this.units = units;
        this.byId = new Map(
            units.map((u) => [
                u.id,
                u,
            ]),
        );
        void this.post({ type: "render", html, units: units.map(({ id, kind, line }) => ({ id, kind, line })), choice: this.choice, languages: LANGUAGES, spend: this.spend(), native: !!this.deps.player, model: config().get<string>("model", "inworld-tts-2-flash") });
    }

    private async sendVoices(): Promise<void> {
        try {
            this.voices ??= await this.deps.client.listVoices();
        } catch (error) {
            this.notifyError(error);
            return;
        }
        const forLanguage = this.voices.filter((v) => v.languages.some((l) => l.startsWith(this.choice.language)));
        if (forLanguage.length && !forLanguage.some((v) => v.voiceId === this.choice.voice)) {
            this.choice = { ...this.choice, voice: forLanguage.find((v) => v.voiceId === DEFAULT_VOICES[this.choice.language])?.voiceId ?? forLanguage[0]!.voiceId };
        }
        await this.post({ type: "voices", choice: this.choice, voices: forLanguage.map(({ voiceId, displayName, description }) => ({ voiceId, displayName, description })) });
    }

    /** Switches the Inworld model for every panel, like the setting it writes. Audio already made with either model stays cached. */
    private async chooseModel(model: string): Promise<void> {
        this.stopNative();
        this.scheduler.reset();
        this.files.clear();
        await config().update("model", model, vscode.ConfigurationTarget.Global);
        await this.post({ type: "reset" });
    }

    private async choose(next: Choice): Promise<void> {
        const languageChanged = next.language !== this.choice.language;
        this.choice = next;
        this.stopNative();
        this.scheduler.reset();
        this.files.clear();
        await this.context.workspaceState.update(choiceKey(this.document), next);
        await this.context.globalState.update("markdownReader.lastChoice", next);
        if (languageChanged) {
            this.render();
        }
        await this.sendVoices();
        await this.post({ type: "reset" });
    }

    private async prepare(id: string, signal: AbortSignal): Promise<void> {
        const unit = this.byId.get(id);
        if (!unit) {
            return;
        }
        try {
            const file = await this.deps.synthesizer.ensure(
                {
                    text: unit.spoken,
                    voiceId: this.choice.voice,
                    modelId: config().get<string>("model", "inworld-tts-2-flash"),
                    language: this.choice.language,
                    context: contextFor(this.units, unit),
                    doc: vscode.workspace.asRelativePath(this.document.uri),
                },
                signal,
            );
            this.files.set(id, file);
            for (const waiter of this.waiters.get(id) ?? []) {
                waiter.resolve(file);
            }
            this.waiters.delete(id);
            if (this.deps.player) {
                await this.post({ type: "audio", id, spend: this.spend() });
            } else {
                // The bytes go to the webview, which plays them from a Blob URL: no local-resource root is needed for the cache.
                await this.post({ type: "audio", id, data: new Uint8Array(await readFile(file)), spend: this.spend() });
            }
        } catch (error) {
            if (!signal.aborted) {
                for (const waiter of this.waiters.get(id) ?? []) {
                    waiter.reject(error);
                }
                this.waiters.delete(id);
                this.notifyError(error);
                await this.post({ type: "audioError", id });
            }
            throw error;
        }
    }

    /**
     * Native playback: plays units with ffplay from `start` until the end, a new start or a stop.
     * The webview only shows which unit plays; timings go to telemetry as in the webview player.
     */
    private async playFrom(start: number): Promise<void> {
        const player = this.deps.player;
        if (!player) {
            return;
        }
        const session = ++this.session;
        player.stop();
        this.paused = false;
        const clickedAt = performance.now();
        let played = 0;
        let stalls = 0;
        for (let i = start; i < this.units.length; i++) {
            const unit = this.units[i]!;
            this.scheduler.want(this.units.slice(i, i + config().get<number>("lookahead", 6) + 1).map((u) => u.id));
            await this.post({ type: "playing", id: unit.id });
            const ready = this.files.get(unit.id);
            const waitStart = performance.now();
            let file = ready;
            try {
                if (!file) {
                    await this.post({ type: "waiting" });
                    file = await this.waitForFile(unit.id);
                }
                if (session !== this.session) {
                    return;
                }
                if (i === start) {
                    this.deps.telemetry.record({ type: "play_start", ms: Math.round(performance.now() - clickedAt), cacheHit: !!ready, speed: this.speed });
                } else if (!ready) {
                    stalls++;
                    this.deps.telemetry.record({ type: "stall", waitMs: Math.round(performance.now() - waitStart), speed: this.speed });
                }
                if ((await player.play(file, this.speed)) === "stopped" || session !== this.session) {
                    return;
                }
            } catch (error) {
                if (session === this.session) {
                    this.notifyError(error);
                    await this.post({ type: "stopped" });
                }
                return;
            }
            played++;
            await new Promise((resolve) => setTimeout(resolve, (PAUSE_MS[unit.kind] ?? 250) / this.speed));
            while (this.paused && session === this.session) {
                await new Promise<void>((resolve) => (this.onResume = resolve));
            }
            if (session !== this.session) {
                return;
            }
        }
        this.deps.telemetry.record({ type: "session_end", unitsPlayed: played, stalls, speed: this.speed });
        await this.post({ type: "stopped" });
    }

    private waitForFile(id: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const list = this.waiters.get(id) ?? [];
            list.push({ resolve, reject });
            this.waiters.set(id, list);
        });
    }

    private stopNative(): void {
        this.session++;
        this.paused = false;
        this.onResume?.();
        this.deps.player?.stop();
    }

    /**
     * Errors go to VS Code notifications, where they can't be missed. The same message is shown once
     * until another one comes, so a failure repeated by every prepared unit doesn't flood the screen.
     */
    private notifyError(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        if (message === this.lastError) {
            return;
        }
        this.lastError = message;
        const keyRejected = error instanceof InworldError && (error.status === 401 || error.status === 403);
        const actions = keyRejected ? ["Set API Key"] : [];
        void vscode.window.showErrorMessage(message.startsWith("Markdown Reader") ? message : `Markdown Reader: ${message}`, ...actions).then((choice) => {
            this.lastError = undefined;
            if (choice === "Set API Key") {
                void vscode.commands.executeCommand("markdownReader.setApiKey");
            }
        });
    }

    private spend(): { session: number; month: number } {
        return { session: this.deps.telemetry.sessionSpend().costUsd, month: this.deps.telemetry.monthSpend().costUsd };
    }

    private async reveal(line: number): Promise<void> {
        const editor = await vscode.window.showTextDocument(this.document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
        const position = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }

    private post(message: unknown): Thenable<boolean> {
        return this.panel.webview.postMessage(message);
    }

    private html(): string {
        const webview = this.panel.webview;
        const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file));
        const nonce = randomBytes(16).toString("base64");
        const lookahead = config().get<number>("lookahead", 6);
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; media-src blob:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media("reader.css")}">
</head>
<body>
<header class="toolbar">
  <button id="play" title="Play / pause (Space)">▶</button>
  <span class="speed"><button id="slower" title="Slower (-)">−</button><span id="speed">1.0×</span><button id="faster" title="Faster (+)">+</button></span>
  <select id="language" title="Language"></select>
  <select id="voice" title="Voice"></select>
  <select id="model" title="Inworld model: Flash is faster and cheaper, TTS-2 sounds better"><option value="inworld-tts-2-flash">Flash</option><option value="inworld-tts-2">TTS-2</option></select>
  <span id="spend" title="Estimated Inworld spend: this session · this month"></span>
  <span id="status"></span>
</header>
<main id="doc"></main>
<script nonce="${nonce}">window.READER = { lookahead: ${lookahead} };</script>
<script nonce="${nonce}" src="${media("reader.js")}"></script>
</body>
</html>`;
    }
}

export interface Deps {
    client: InworldClient;
    /** Plays audio from the extension host; undefined when the webview plays it. */
    player: NativePlayer | undefined;
    synthesizer: Synthesizer;
    telemetry: Telemetry;
}

function config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("markdownReader");
}

function choiceKey(document: vscode.TextDocument): string {
    return `markdownReader.choice:${document.uri.toString()}`;
}
