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
    const editorsShown = [];
    const watchers = [];
    const documentsByUri = new Map();
    const openedUris = [];
    const saveListeners = new Set();
    const changeListeners = new Set();
    const openListeners = new Set();
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
        TextEditorRevealType: { InCenter: 0 },
        Position: class {
            constructor(line, character) {
                this.line = line;
                this.character = character;
            }
        },
        Selection: class {
            constructor(anchor, active) {
                this.anchor = anchor;
                this.active = active;
            }
        },
        Range: class {
            constructor(start, end) {
                this.start = start;
                this.end = end;
            }
        },
        ThemeIcon: class {},
        RelativePattern: class {
            constructor(baseUri, pattern) {
                this.baseUri = baseUri;
                this.pattern = pattern;
            }
        },
        Uri: { joinPath: (base, ...parts) => ({ fsPath: join(base.fsPath, ...parts) }) },
        window: {
            createWebviewPanel,
            showTextDocument: async (document) => {
                const editor = {
                    document,
                    revealRange: (range) => {
                        editor.revealedRange = range;
                    },
                };
                editorsShown.push(editor);
                return editor;
            },
            showErrorMessage: async (message) => {
                errorsShown.push(message);
                return undefined;
            },
        },
        workspace: {
            asRelativePath: (uri) => uri.path,
            getConfiguration: () => ({ get: (_key, fallback) => fallback, update: async () => {} }),
            fs: { isWritableFileSystem: (scheme) => (scheme === "file" || scheme === "vscode-remote" ? true : undefined) },
            onDidSaveTextDocument: event(saveListeners),
            onDidChangeTextDocument: event(changeListeners),
            onDidOpenTextDocument: event(openListeners),
            openTextDocument: async (uri) => {
                openedUris.push(uri);
                const document = documentsByUri.get(uri.toString());
                if (!document || document.isClosed) {
                    throw new Error("Document unavailable");
                }
                fire(openListeners, document);
                return document;
            },
            createFileSystemWatcher: (pattern, ignoreCreateEvents = false, ignoreChangeEvents = false, ignoreDeleteEvents = false) => {
                const changes = new Set();
                const creates = new Set();
                const deletes = new Set();
                const watcher = {
                    pattern,
                    ignoreCreateEvents,
                    ignoreChangeEvents,
                    ignoreDeleteEvents,
                    disposed: false,
                    onDidChange: event(changes),
                    onDidCreate: event(creates),
                    onDidDelete: event(deletes),
                    change: (uri) => fire(changes, uri),
                    create: (uri) => fire(creates, uri),
                    dispose() {
                        this.disposed = true;
                        changes.clear();
                        creates.clear();
                        deletes.clear();
                    },
                };
                watchers.push(watcher);
                return watcher;
            },
        },
        commands: { executeCommand: async () => {} },
    };
    return {
        vscode,
        panels,
        listenerErrors,
        errorsShown,
        editorsShown,
        watchers,
        documentsByUri,
        openedUris,
        save: (document) => fire(saveListeners, document),
        change: (document) => fire(changeListeners, { document }),
        open: (document) => fire(openListeners, document),
    };
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
    const document = { uri: { scheme: "file", path, toString: () => `file://${path}` }, isDirty: false, isClosed: false, getText: () => "# Title\n\nA first sentence. A second one.\n" };
    fake.documentsByUri.set(document.uri.toString(), document);
    const context = { extensionUri: { fsPath: dir }, globalState: memento(), workspaceState: memento() };
    return { document, context, deps: { client, player, synthesizer, telemetry } };
}

const voices = async () => new Response(JSON.stringify({ voices: [{ voiceId: "Jason", displayName: "Jason", description: "", languages: ["en"] }] }), { status: 200 });

const lastRender = (panel) => panel.posted.filter((message) => message.type === "render").at(-1);

test("an external clean-document reload refreshes the preview without synthesizing audio", async () => {
    const { document, context, deps } = setup((url) => {
        assert.ok(url.endsWith("/voices"), "refreshing an idle preview must not synthesize");
        return voices();
    });
    ReaderPanel.show(context, document, deps);
    const panel = fake.panels.at(-1);
    try {
        await panel.receive({ type: "ready" });
        const original = lastRender(panel);
        const text = document.getText();
        document.getText = () => `${text}\nExternally saved addition.`;
        fake.change(document);
        assert.ok(lastRender(panel).html.includes("Externally saved addition."));
        assert.ok(
            original.units.every((unit) => lastRender(panel).units.some((next) => next.id === unit.id)),
            "unchanged sentences retain their audio-cache identities",
        );
    } finally {
        panel.dispose();
    }
});

test("unsaved edits wait for save, and duplicate clean/save events do not render the same content again", async () => {
    const { document, context, deps } = setup(voices);
    ReaderPanel.show(context, document, deps);
    const panel = fake.panels.at(-1);
    const watcher = fake.watchers.at(-1);
    const opened = fake.openedUris.length;
    try {
        await panel.receive({ type: "ready" });
        const original = lastRender(panel);
        document.isDirty = true;
        document.getText = () => "An unsaved draft.";
        fake.change(document);
        watcher.change(document.uri);
        await new Promise(setImmediate);
        assert.equal(lastRender(panel), original, "typing or a disk event must not publish a dirty buffer");
        assert.deepEqual(fake.openedUris.slice(opened), [], "an open document refreshes through VS Code's reload events");
        document.isDirty = false;
        fake.save(document);
        const saved = lastRender(panel);
        assert.ok(saved.html.includes("An unsaved draft."));
        fake.change(document);
        fake.save(document);
        assert.equal(lastRender(panel), saved);
    } finally {
        panel.dispose();
    }
});

test("document and watcher events for another URI leave this preview alone", async () => {
    const { document, context, deps } = setup(voices);
    const other = setup(voices).document;
    ReaderPanel.show(context, document, deps);
    const panel = fake.panels.at(-1);
    const watcher = fake.watchers.at(-1);
    const opened = fake.openedUris.length;
    try {
        await panel.receive({ type: "ready" });
        const original = lastRender(panel);
        document.isClosed = true;
        fake.save(other);
        fake.change(other);
        fake.open(other);
        watcher.change(other.uri);
        watcher.create(other.uri);
        await new Promise(setImmediate);
        assert.equal(lastRender(panel), original);
        assert.deepEqual(fake.openedUris.slice(opened), []);
    } finally {
        panel.dispose();
    }
});

test("changed or recreated closed SSH files reopen by URI and refresh the preview and source navigation", async () => {
    const { document, context, deps } = setup(voices);
    document.uri = {
        scheme: "vscode-remote",
        path: "/work/spec [draft].md",
        toString: () => "vscode-remote://ssh-remote+test-host/work/spec%20%5Bdraft%5D.md",
        get fsPath() {
            throw new Error("remote file watching must use VS Code's URI APIs");
        },
    };
    ReaderPanel.show(context, document, deps);
    const panel = fake.panels.at(-1);
    const watcher = fake.watchers.at(-1);
    const opened = fake.openedUris.length;
    try {
        await panel.receive({ type: "ready" });
        assert.equal(watcher.pattern.baseUri, document.uri, "the watcher must retain the remote scheme and authority");
        let source = document;
        for (const event of [
            "change",
            "create",
        ]) {
            source.isClosed = true;
            source = { ...document, isClosed: false, getText: () => `# Saved ${event}\n\nNew source text.` };
            fake.documentsByUri.set(document.uri.toString(), source);
            watcher[event](document.uri);
            await new Promise(setImmediate);
            assert.ok(lastRender(panel).html.includes(`Saved ${event}`));
            await panel.receive({ type: "reveal", line: 2 });
            assert.equal(fake.editorsShown.at(-1).document, source, "navigation must use the reopened document, not the disposed one");
        }
        assert.deepEqual(fake.openedUris.slice(opened), [
            document.uri,
            document.uri,
        ]);
    } finally {
        panel.dispose();
    }
    assert.equal(watcher.disposed, true);
});

test("reopening a source with a new TextDocument instance still refreshes on open and save", async () => {
    const { document, context, deps } = setup(voices);
    ReaderPanel.show(context, document, deps);
    const panel = fake.panels.at(-1);
    try {
        await panel.receive({ type: "ready" });
        document.isClosed = true;
        const reopened = { ...document, isClosed: false, getText: () => "Reopened source." };
        fake.open(reopened);
        assert.ok(lastRender(panel).html.includes("Reopened source."));
        reopened.getText = () => "Saved after reopening.";
        fake.save(reopened);
        assert.ok(lastRender(panel).html.includes("Saved after reopening."));
    } finally {
        panel.dispose();
    }
});

test("closing a panel disposes its watcher and drops a pending file reload", async (t) => {
    const { document, context, deps } = setup(voices);
    ReaderPanel.show(context, document, deps);
    const panel = fake.panels.at(-1);
    const watcher = fake.watchers.at(-1);
    await panel.receive({ type: "ready" });
    const original = lastRender(panel);
    document.isClosed = true;
    let complete;
    const opened = [];
    t.mock.method(fake.vscode.workspace, "openTextDocument", (uri) => {
        opened.push(uri);
        return new Promise((resolve) => (complete = resolve));
    });
    watcher.change(document.uri);
    panel.dispose();
    complete({ ...document, isClosed: false, getText: () => "A late saved result." });
    await new Promise(setImmediate);
    watcher.create(document.uri);
    assert.equal(watcher.disposed, true);
    assert.equal(lastRender(panel), original);
    assert.deepEqual(opened, [document.uri], "disposed file events must not reopen the document");
    assert.deepEqual(fake.listenerErrors, []);
});

test("a failed closed-source reload can be retried on the next file event", async () => {
    const { document, context, deps } = setup(voices);
    ReaderPanel.show(context, document, deps);
    const panel = fake.panels.at(-1);
    const watcher = fake.watchers.at(-1);
    try {
        await panel.receive({ type: "ready" });
        const original = lastRender(panel);
        document.isClosed = true;
        watcher.change(document.uri);
        await new Promise(setImmediate);
        assert.equal(lastRender(panel), original);
        assert.match(fake.errorsShown.at(-1), /Document unavailable/);
        fake.documentsByUri.set(document.uri.toString(), { ...document, isClosed: false, getText: () => "Available again." });
        watcher.create(document.uri);
        await new Promise(setImmediate);
        assert.ok(lastRender(panel).html.includes("Available again."));
    } finally {
        panel.dispose();
    }
});

test("a saved refresh preserves playback when the current sentence still exists", { timeout: 5000 }, async () => {
    const fetchImpl = async (url) => (url.endsWith("/voices") ? voices() : new Response(JSON.stringify({ audioContent: Buffer.from("audio").toString("base64"), usage: { processedCharactersCount: 12 } }), { status: 200 }));
    const { document, context, deps } = setup(fetchImpl);
    let started;
    const playing = new Promise((resolve) => (started = resolve));
    let settle;
    let stopped = false;
    deps.player = {
        play: () => {
            started();
            return new Promise((resolve) => (settle = resolve));
        },
        stop: () => {
            stopped = true;
            settle("stopped");
        },
        pause() {},
        resume() {},
    };
    ReaderPanel.show(context, document, deps);
    const panel = fake.panels.at(-1);
    try {
        await panel.receive({ type: "ready" });
        const original = lastRender(panel);
        await panel.receive({ type: "start", id: original.units[0].id });
        await playing;
        const text = document.getText();
        document.getText = () => `${text}\nA saved addition while listening.`;
        fake.change(document);
        assert.ok(lastRender(panel).html.includes("A saved addition while listening."));
        assert.equal(lastRender(panel).units[0].id, original.units[0].id);
        assert.equal(panel.posted.filter((message) => message.type === "state").at(-1).state, "playing");
        assert.equal(stopped, false);
    } finally {
        panel.dispose();
    }
});

test("reopening the panel after closing it throws Webview is disposed", async () => {
    const { document, context, deps } = setup(voices);
    const errors = fake.errorsShown.length;
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
    assert.deepEqual(fake.errorsShown.slice(errors), []);
});

test("an Inworld reply that arrives after the panel closes is dropped instead of throwing Webview is disposed", async () => {
    let answer;
    const { document, context, deps } = setup(() => new Promise((resolve) => (answer = resolve)));
    const errors = fake.errorsShown.length;
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
    assert.deepEqual(fake.errorsShown.slice(errors), []);
});

test("accepting a replacement key can reload voices in a panel whose first request was rejected", async () => {
    let accepted = false;
    const { document, context, deps } = setup(() => (accepted ? voices() : new Response("Unauthorized", { status: 401 })));
    ReaderPanel.show(context, document, deps);
    const panel = fake.panels.at(-1);
    try {
        await panel.receive({ type: "ready" });
        assert.ok(!panel.posted.some((message) => message.type === "voices"));
        accepted = true;
        await ReaderPanel.refreshVoices();
        const available = panel.posted.find((message) => message.type === "voices");
        assert.deepEqual(
            available.voices.map((voice) => voice.voiceId),
            ["Jason"],
        );
    } finally {
        panel.dispose();
    }
});

test("opening or closing an idle panel leaves native playback alone; starting it hands ownership over", { timeout: 5000 }, async () => {
    const fetchImpl = async (url) => (url.endsWith("/voices") ? voices() : new Response(JSON.stringify({ audioContent: Buffer.from("audio").toString("base64"), usage: { processedCharactersCount: 12 } }), { status: 200 }));
    const { document, context, deps } = setup(fetchImpl);
    let pending;
    const plays = [];
    let stops = 0;
    deps.player = {
        play: (file) => {
            plays.push(file);
            return new Promise((resolve) => {
                pending = resolve;
            });
        },
        stop: () => {
            stops++;
            pending?.("stopped");
            pending = undefined;
        },
        pause() {},
        resume() {},
    };
    const open = async (doc) => {
        ReaderPanel.show(context, doc, deps);
        const panel = fake.panels.at(-1);
        await panel.receive({ type: "ready" });
        return panel;
    };
    const start = async (panel, expectedPlays) => {
        const id = panel.posted.find((message) => message.type === "render").units[0].id;
        await panel.receive({ type: "start", id });
        while (plays.length < expectedPlays) await new Promise(setImmediate);
    };
    const state = (panel) => panel.posted.filter((message) => message.type === "state").at(-1).state;
    const first = await open(document);
    let second;
    try {
        await start(first, 1);
        assert.equal(stops, 0);
        const idle = await open(setup(fetchImpl).document);
        idle.dispose();
        assert.equal(stops, 0, "initializing or closing an inactive panel must not stop the shared player");
        assert.equal(state(first), "playing");
        second = await open(setup(fetchImpl).document);
        await start(second, 2);
        assert.equal(stops, 1, "claiming playback stops the previous owner exactly once");
        assert.equal(state(first), "stopped");
        assert.equal(state(second), "playing");
        first.dispose();
        assert.equal(stops, 1, "the old owner can no longer stop the new owner's audio");
        second.dispose();
        assert.equal(stops, 2, "disposing the current owner stops its audio");
    } finally {
        first.dispose();
        second?.dispose();
    }
    assert.deepEqual(fake.listenerErrors.map(String), []);
});

test("a remote document renders its current text and source navigation returns to that document", async () => {
    const { document, context, deps } = setup(voices);
    document.uri = {
        scheme: "vscode-remote",
        path: "/work/remote-spec.md",
        toString: () => "vscode-remote://ssh-remote+test-host/work/remote-spec.md",
        get fsPath() {
            throw new Error("a remote document must be accessed through VS Code, not local files");
        },
    };
    document.getText = () => "# Remote draft\n\nUnsaved changes are visible here.";
    ReaderPanel.show(context, document, deps);
    const panel = fake.panels.at(-1);
    try {
        await panel.receive({ type: "ready" });
        const rendered = panel.posted.find((message) => message.type === "render");
        assert.ok(rendered.html.includes("Unsaved changes are visible here."));
        const line = rendered.units.find((unit) => unit.line === 2).line;
        await panel.receive({ type: "reveal", line });
        const editor = fake.editorsShown.at(-1);
        assert.equal(editor.document, document, "revealing the source must retain the original remote document identity");
        assert.equal(editor.selection.anchor.line, 2);
        assert.equal(editor.selection.active.line, 2);
        assert.equal(editor.revealedRange.start.line, 2);
    } finally {
        panel.dispose();
    }
});
