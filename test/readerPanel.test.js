const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

/**
 * A fake of the parts of the `vscode` API the panel uses. Its panels behave like VS Code's: once closed,
 * `webview` and `reveal` throw "Webview is disposed", the panel is marked disposed before `onDidDispose`
 * fires, and a listener that throws is reported (as VS Code logs it) instead of failing the close.
 */
function fakeVscode() {
    const panels = [];
    const listenerErrors = [];
    const errorsShown = [];
    const fire = (listeners, ...args) => {
        for (const listener of listeners) {
            try {
                listener(...args);
            } catch (error) {
                listenerErrors.push(error);
            }
        }
    };
    const event = (listeners) => (listener, thisArg, disposables) => {
        const bound = listener.bind(thisArg);
        listeners.add(bound);
        const disposable = { dispose: () => listeners.delete(bound) };
        disposables?.push(disposable);
        return disposable;
    };
    const createWebviewPanel = () => {
        let disposed = false;
        const disposeListeners = new Set();
        const messageListeners = new Set();
        const posted = [];
        const assertNotDisposed = () => {
            if (disposed) {
                throw new Error("Webview is disposed");
            }
        };
        const webview = {
            html: "",
            cspSource: "vscode-resource:",
            asWebviewUri: (uri) => uri,
            postMessage: async (message) => {
                posted.push(message);
                return true;
            },
            onDidReceiveMessage: event(messageListeners),
        };
        const panel = {
            posted,
            get webview() {
                assertNotDisposed();
                return webview;
            },
            reveal: () => assertNotDisposed(),
            onDidDispose: event(disposeListeners),
            /** What closing the panel's tab does. */
            dispose: () => {
                if (!disposed) {
                    disposed = true;
                    fire(disposeListeners);
                }
            },
            /** A message from the panel's script; resolves when the extension has handled it. */
            receive: (message) => Promise.all([...messageListeners].map((listener) => listener(message))),
        };
        panels.push(panel);
        return panel;
    };
    const vscode = {
        ViewColumn: { One: 1, Beside: -2 },
        ConfigurationTarget: { Global: 1 },
        ThemeIcon: class {},
        Uri: { joinPath: (base, ...parts) => ({ fsPath: join(base.fsPath, ...parts) }) },
        window: {
            createWebviewPanel,
            showErrorMessage: async (message) => {
                errorsShown.push(message);
                return undefined;
            },
        },
        workspace: {
            asRelativePath: (uri) => uri.path,
            getConfiguration: () => ({ get: (_key, fallback) => fallback, update: async () => {} }),
            onDidSaveTextDocument: event(new Set()),
        },
        commands: { executeCommand: async () => {} },
    };
    return { vscode, panels, listenerErrors, errorsShown };
}

const fake = fakeVscode();
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === "vscode" ? "vscode" : resolveFilename.call(this, request, ...rest);
};
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: fake.vscode };

const { ReaderPanel } = require("../out/reader/ReaderPanel.js");
const { Synthesizer } = require("../out/reader/Synthesizer.js");
const { Telemetry } = require("../out/telemetry/Telemetry.js");
const { InworldClient } = require("../out/tts/InworldClient.js");

function memento() {
    const values = new Map();
    return { get: (key) => values.get(key), update: async (key, value) => void values.set(key, value) };
}

let documents = 0;

/** A document, an extension context and the panel's shared services, with Inworld answering through `fetchImpl`. */
function setup(fetchImpl) {
    const dir = mkdtempSync(join(tmpdir(), "markdown-reader-"));
    const telemetry = new Telemetry(dir);
    const client = new InworldClient(async () => "a2V5", fetchImpl);
    const synthesizer = new Synthesizer(join(dir, "audio"), client, telemetry, () => ({}));
    const player = { play: async () => "ended", pause() {}, resume() {}, stop() {} };
    const path = `/docs/spec-${++documents}.md`;
    const document = { uri: { path, toString: () => `file://${path}` }, getText: () => "# Title\n\nA first sentence. A second one.\n" };
    const context = { extensionUri: { fsPath: dir }, globalState: memento(), workspaceState: memento() };
    return { document, context, deps: { client, player, synthesizer, telemetry } };
}

const voices = async () => new Response(JSON.stringify({ voices: [{ voiceId: "Jason", displayName: "Jason", description: "", languages: ["en"] }] }), { status: 200 });

test("reopening the panel after closing it throws Webview is disposed", async () => {
    const { document, context, deps } = setup(voices);
    const opened = fake.panels.length;
    for (let round = 1; round <= 3; round++) {
        assert.doesNotThrow(() => ReaderPanel.show(context, document, deps), `opening the panel, round ${round}`);
        assert.equal(fake.panels.length, opened + round, `round ${round} opens a new panel, not the closed one`);
        const panel = fake.panels.at(-1);
        await panel.receive({ type: "ready" });
        assert.ok(
            panel.posted.some((m) => m.type === "render"),
            `the panel of round ${round} shows the document`,
        );
        panel.dispose();
    }
    assert.deepEqual(fake.listenerErrors.map(String), []);
    assert.deepEqual(fake.errorsShown, []);
});

test("an Inworld reply that arrives after the panel closes is dropped instead of throwing Webview is disposed", async () => {
    let answer;
    const { document, context, deps } = setup(() => new Promise((resolve) => (answer = resolve)));
    ReaderPanel.show(context, document, deps);
    const panel = fake.panels.at(-1);
    const handled = panel.receive({ type: "ready" });
    while (!answer) {
        await new Promise(setImmediate);
    }
    panel.dispose();
    answer(await voices());
    await assert.doesNotReject(handled);
    assert.deepEqual(fake.listenerErrors.map(String), []);
    assert.deepEqual(fake.errorsShown, []);
});
