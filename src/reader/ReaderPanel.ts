import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { Telemetry } from "../telemetry/Telemetry";
import { contextFor, renderDocument, type Unit } from "../text/units";
import { InworldError, type InworldClient, type Voice } from "../tts/InworldClient";
import { WebviewOutput, type AudioOutput } from "./AudioOutput";
import { NotWantedError, Scheduler } from "./Scheduler";
import { errorMessage, exists, type Synthesizer } from "./Synthesizer";

/** Inworld's tier-1 languages, English first. */
export const LANGUAGES: Record<string, string> = {
    en: "English",
    it: "Italiano",
    de: "Deutsch",
    es: "Español",
    fr: "Français",
    pt: "Português",
    nl: "Nederlands",
    pl: "Polski",
    ru: "Русский",
    ar: "العربية",
    he: "עברית",
    hi: "हिन्दी",
    zh: "中文",
    ja: "日本語",
    ko: "한국어",
};

/** The models of the `markdownReader.model` setting, as the toolbar names them. */
export const MODELS: Record<string, string> = { "inworld-tts-2-flash": "Flash", "inworld-tts-2": "TTS-2" };

const DEFAULT_VOICES: Record<string, string> = { en: "Jason", it: "Orietta" };
/** The speed range and step of the toolbar slider, and the speed before the owner picks one. */
const SPEED = { min: 0.75, max: 3, step: 0.05, initial: 1.5 };
/** Silence after each kind of unit at 1×, in milliseconds; divided by the speed. */
const PAUSE_MS: Record<string, number> = { heading: 650, sentence: 280, row: 200 };

type PlaybackState = "stopped" | "playing" | "paused";

interface Choice {
    language: string;
    voice: string;
}

/**
 * One reading panel per Markdown document. The panel is a view: this class renders the document,
 * prepares audio and runs the one playback sequence, on ffplay or on the panel's audio element.
 */
export class ReaderPanel {
    private static readonly panels = new Map<string, ReaderPanel>();

    private units: Unit[] = [];
    private byId = new Map<string, Unit>();
    private voices: Voice[] | undefined;
    private lastError: string | undefined;
    private choice: Choice;
    private readonly panel: vscode.WebviewPanel;
    private readonly scheduler: Scheduler;
    private readonly output: AudioOutput;
    private readonly webviewOutput: WebviewOutput | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    /** Bumped by every start and stop, so a superseded playback sequence ends quietly. */
    private session = 0;
    private state: PlaybackState = "stopped";
    private speed: number;
    private onResume: (() => void) | undefined;
    /** Set when the panel closes: VS Code throws on any use of a closed panel's webview. */
    private disposed = false;

    /** Opens the panel for `document`, or reveals the one already open. */
    static show(context: vscode.ExtensionContext, document: vscode.TextDocument, deps: Deps): void {
        const existing = ReaderPanel.panels.get(document.uri.toString());
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.Beside);
            return;
        }
        ReaderPanel.panels.set(document.uri.toString(), new ReaderPanel(context, document, deps));
    }

    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly document: vscode.TextDocument,
        private readonly deps: Deps,
    ) {
        this.speed = context.globalState.get<number>("markdownReader.speed") ?? SPEED.initial;
        this.choice = context.workspaceState.get<Choice>(choiceKey(document)) ?? context.globalState.get<Choice>("markdownReader.lastChoice") ?? { language: "en", voice: DEFAULT_VOICES.en! };
        this.panel = vscode.window.createWebviewPanel(
            "markdownReader",
            `Read: ${vscode.workspace.asRelativePath(document.uri)}`,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")] },
        );
        this.panel.iconPath = new vscode.ThemeIcon("unmute");
        this.webviewOutput = deps.player ? undefined : new WebviewOutput((m) => this.post(m));
        this.output = deps.player ?? this.webviewOutput!;
        this.scheduler = new Scheduler(
            () => config().get<number>("concurrency", 3),
            (id, signal) => this.prepare(id, signal),
        );
        this.panel.webview.html = this.html();
        this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), undefined, this.disposables);
        this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
        this.disposables.push({ dispose: deps.synthesizer.onDidClear(() => this.resetPlayback()) });
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
        // First, so the next show() opens a new panel even if anything below fails.
        this.disposed = true;
        ReaderPanel.panels.delete(this.document.uri.toString());
        for (const d of this.disposables) {
            d.dispose();
        }
        this.resetPlayback();
        this.deps.telemetry.flush();
    }

    private async onMessage(message: any): Promise<void> {
        switch (message?.type) {
            case "ready":
                this.resetPlayback();
                this.render();
                await this.sendVoices();
                break;
            case "start":
                void this.playFrom(String(message.id));
                break;
            case "pause":
                this.pause();
                break;
            case "resume":
                this.resume();
                break;
            case "speed":
                // Remembered for every panel; ffplay applies it from the next unit, the panel's audio element at once.
                this.speed = Math.min(SPEED.max, Math.max(SPEED.min, Number(message.value) || this.speed));
                await this.context.globalState.update("markdownReader.speed", this.speed);
                break;
            case "ended":
                this.webviewOutput?.settle(Number(message.token));
                break;
            case "playError":
                this.webviewOutput?.settle(Number(message.token), String(message.message));
                break;
            case "reveal":
                await this.reveal(Number(message.line));
                break;
            case "choose":
                await this.choose({ language: String(message.language), voice: String(message.voice ?? "") });
                break;
            case "model":
                await this.chooseModel(String(message.value));
                break;
        }
    }

    private render(): void {
        const { html, units } = renderDocument(this.document.getText(), this.choice.language);
        this.units = units;
        this.byId = new Map(
            units.map(
                (u) =>
                    [
                        u.id,
                        u,
                    ] as const,
            ),
        );
        void this.post({ type: "render", html, units: units.map(({ id, line }) => ({ id, line })), choice: this.choice, languages: LANGUAGES, models: MODELS, model: model(), speed: this.speed, spend: this.spend() });
    }

    private async sendVoices(): Promise<void> {
        if (!(await this.loadVoices())) {
            return;
        }
        this.choice = { ...this.choice, voice: this.pickVoice(this.choice.language, this.choice.voice) };
        const voices = this.voicesFor(this.choice.language).map(({ voiceId, displayName, description }) => ({ voiceId, displayName, description }));
        await this.post({ type: "voices", choice: this.choice, voices });
    }

    private async loadVoices(): Promise<boolean> {
        try {
            this.voices ??= await this.deps.client.listVoices();
            return true;
        } catch (error) {
            this.notifyError(error);
            return false;
        }
    }

    private voicesFor(language: string): Voice[] {
        return (this.voices ?? []).filter((v) => v.languages.some((l) => l.startsWith(language)));
    }

    /** `wanted` if it speaks `language`, else the language's default voice, else its first one. Never empty. */
    private pickVoice(language: string, wanted: string): string {
        const available = this.voicesFor(language);
        if (!available.length) {
            return wanted || DEFAULT_VOICES[language] || this.choice.voice;
        }
        return (available.find((v) => v.voiceId === wanted) ?? available.find((v) => v.voiceId === DEFAULT_VOICES[language]) ?? available[0]!).voiceId;
    }

    /** Switches the Inworld model for every panel, like the setting it writes. Audio already made with either model stays cached. */
    private async chooseModel(value: string): Promise<void> {
        this.resetPlayback();
        await config().update("model", value, vscode.ConfigurationTarget.Global);
    }

    private async choose(next: Choice): Promise<void> {
        const languageChanged = next.language !== this.choice.language;
        await this.loadVoices();
        this.choice = { language: next.language, voice: this.pickVoice(next.language, next.voice) };
        this.resetPlayback();
        await this.context.workspaceState.update(choiceKey(this.document), this.choice);
        await this.context.globalState.update("markdownReader.lastChoice", this.choice);
        if (languageChanged) {
            this.render();
        }
        await this.sendVoices();
    }

    /** Synthesizes one unit (or takes it from the cache) for the scheduler. */
    private async prepare(id: string, signal: AbortSignal): Promise<string> {
        const unit = this.byId.get(id);
        if (!unit) {
            throw new NotWantedError();
        }
        try {
            const file = await this.deps.synthesizer.ensure(
                {
                    text: unit.spoken,
                    voiceId: this.choice.voice,
                    modelId: model(),
                    language: this.choice.language,
                    context: contextFor(this.units, unit),
                    doc: vscode.workspace.asRelativePath(this.document.uri),
                },
                signal,
            );
            void this.post({ type: "spend", spend: this.spend() });
            return file;
        } catch (error) {
            if (!signal.aborted) {
                this.notifyError(error);
            }
            throw error;
        }
    }

    /**
     * The playback sequence: plays from the unit `id` to the end of the document, a new start or a stop.
     * It follows unit ids, not positions, so a save while listening continues after the same sentence.
     */
    private async playFrom(id: string): Promise<void> {
        const session = this.restart();
        const clickedAt = performance.now();
        let played = 0;
        let stalls = 0;
        let unit = this.byId.get(id);
        try {
            while (unit && session === this.session) {
                this.scheduler.want(this.units.slice(unit.index, unit.index + config().get<number>("lookahead", 6) + 1).map((u) => u.id));
                void this.post({ type: "playing", id: unit.id });
                const cached = this.scheduler.isReady(unit.id);
                const waitStart = performance.now();
                if (!cached) {
                    void this.post({ type: "waiting" });
                }
                const file = await this.scheduler.ready(unit.id);
                if (!(await exists(file))) {
                    // The cache was cleared, perhaps from another window: prepare this unit again.
                    this.scheduler.forget(unit.id);
                    continue;
                }
                await this.whilePaused(session);
                if (session !== this.session) {
                    return;
                }
                if (played === 0) {
                    this.deps.telemetry.record({ type: "play_start", ms: Math.round(performance.now() - clickedAt), cacheHit: cached, speed: this.speed });
                } else if (!cached) {
                    stalls++;
                    this.deps.telemetry.record({ type: "stall", waitMs: Math.round(performance.now() - waitStart), speed: this.speed });
                }
                if ((await this.output.play(file, this.speed)) === "stopped") {
                    return;
                }
                played++;
                await new Promise((resolve) => setTimeout(resolve, (PAUSE_MS[unit!.kind] ?? 250) / this.speed));
                await this.whilePaused(session);
                const line = unit.line;
                const current = this.byId.get(unit.id);
                unit = current ? this.units[current.index + 1] : this.units.find((u) => u.line > line);
            }
            if (session === this.session) {
                this.setState("stopped");
            }
        } catch (error) {
            if (session === this.session && !(error instanceof NotWantedError)) {
                this.notifyError(error);
                this.setState("stopped");
            }
        } finally {
            if (played) {
                this.deps.telemetry.record({ type: "session_end", unitsPlayed: played, stalls, speed: this.speed });
            }
        }
    }

    /** Ends any playback sequence and starts a new session in the playing state. */
    private restart(): number {
        this.stopPlayback();
        this.setState("playing");
        return this.session;
    }

    private async whilePaused(session: number): Promise<void> {
        while (this.state === "paused" && session === this.session) {
            await new Promise<void>((resolve) => (this.onResume = resolve));
        }
    }

    private pause(): void {
        if (this.state === "playing") {
            this.setState("paused");
            this.output.pause();
        }
    }

    private resume(): void {
        if (this.state === "paused") {
            this.setState("playing");
            this.output.resume();
            this.onResume?.();
        }
    }

    private stopPlayback(): void {
        this.session++;
        this.output.stop();
        this.setState("stopped");
        this.onResume?.();
    }

    /** Stops playback and forgets prepared audio: the voice, language or model changed, or the panel closes. */
    private resetPlayback(): void {
        this.stopPlayback();
        this.scheduler.reset();
    }

    private setState(state: PlaybackState): void {
        this.state = state;
        void this.post({ type: "state", state });
    }

    /**
     * Errors go to VS Code notifications, where they can't be missed. The same message is shown once
     * until another one comes, so a failure repeated by every prepared unit doesn't flood the screen.
     */
    private notifyError(error: unknown): void {
        const message = errorMessage(error);
        if (message === this.lastError) {
            return;
        }
        this.lastError = message;
        const keyRejected = error instanceof InworldError && (error.status === 401 || error.status === 403);
        void vscode.window.showErrorMessage(`Markdown Reader: ${message}`, ...(keyRejected ? ["Set API Key"] : [])).then((choice) => {
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

    /** Messages to a closed panel, such as from synthesis or playback that finishes late, are dropped. */
    private post(message: unknown): Thenable<boolean> {
        if (this.disposed) {
            return Promise.resolve(false);
        }
        return this.panel.webview.postMessage(message);
    }

    private html(): string {
        const webview = this.panel.webview;
        const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file));
        const nonce = randomBytes(16).toString("base64");
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
  <span class="speed"><button id="slower" title="Slower (-)">−</button><input type="range" id="speedSlider" min="${SPEED.min}" max="${SPEED.max}" step="${SPEED.step}" title="Speed"><span id="speed"></span><button id="faster" title="Faster (+)">+</button></span>
  <select id="language" title="Language"></select>
  <select id="voice" title="Voice"></select>
  <select id="model" title="Inworld model: Flash is faster and cheaper, TTS-2 sounds better"></select>
  <span id="spend" title="Estimated Inworld spend: this session · this month"></span>
  <span id="status"></span>
</header>
<main id="doc"></main>
<script nonce="${nonce}" src="${media("reader.js")}"></script>
</body>
</html>`;
    }
}

/** What every panel shares, built once at activation. */
export interface Deps {
    client: InworldClient;
    /** ffplay, when it can play here; otherwise each panel plays through its own audio element. */
    player: AudioOutput | undefined;
    synthesizer: Synthesizer;
    telemetry: Telemetry;
}

function config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("markdownReader");
}

function model(): string {
    return config().get<string>("model", "inworld-tts-2-flash");
}

function choiceKey(document: vscode.TextDocument): string {
    return `markdownReader.choice:${document.uri.toString()}`;
}
