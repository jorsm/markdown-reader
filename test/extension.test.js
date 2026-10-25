const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

let current;
const vscode = {
    Uri: { joinPath: (base, ...parts) => ({ fsPath: join(base.fsPath, ...parts) }) },
    window: {
        activeTextEditor: undefined,
        visibleTextEditors: [],
        createOutputChannel: () => ({ info() {}, dispose() {} }),
        showInputBox: async () => current.input,
        showErrorMessage: async (message) => {
            current.errors.push(message);
        },
        showWarningMessage: async (message) => {
            current.warnings.push(message);
        },
    },
    commands: {
        registerCommand: (name, run) => {
            current.commands.set(name, run);
            return { dispose() {} };
        },
    },
    workspace: {
        getConfiguration: () => ({ get: (key, fallback) => current.settings[key] ?? fallback }),
        openTextDocument: async (uri) => {
            current.openedUris.push(uri);
            return current.document;
        },
    },
};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === "vscode" ? "vscode" : resolveFilename.call(this, request, ...rest);
};
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscode };
const { activate } = require("../out/extension.js");
const { ReaderPanel } = require("../out/reader/ReaderPanel.js");
const { NativePlayer } = require("../out/reader/NativePlayer.js");

const OLD_KEY = Buffer.from("previous:working-secret").toString("base64");
const NEW_KEY = Buffer.from("candidate:new-secret").toString("base64");

function setup(t, input, answer) {
    current = { input, key: OLD_KEY, settings: {}, errors: [], warnings: [], requests: [], openedUris: [], commands: new Map() };
    const state = current;
    t.mock.method(globalThis, "fetch", async (url, init) => {
        state.requests.push({ url, method: init.method, authorization: init.headers.Authorization });
        return answer();
    });
    const context = {
        subscriptions: [],
        secrets: {
            get: async () => state.key,
            store: async (_name, key) => {
                state.key = key;
            },
        },
    };
    activate(context);
    return { state, context, enter: () => state.commands.get("markdownReader.setApiKey")() };
}

test("desktop VS Code must run the reader in the local UI host, including for SSH workspaces", () => {
    const manifest = require("../package.json");
    assert.deepEqual(manifest.extensionKind, ["ui"], "allowing the workspace host would launch ffplay on the SSH server");
});

for (const platform of [
    "win32",
    "linux",
    "darwin",
]) {
    for (const output of [
        undefined,
        "webview",
        "auto",
    ]) {
        test(`${platform}/${output ?? "default"} opens webview audio without probing ffplay`, async (t) => {
            const manifest = require("../package.json");
            assert.equal(manifest.contributes.configuration.properties["markdownReader.audioOutput"].default, "webview");
            t.mock.property(process, "platform", platform);
            t.mock.method(NativePlayer, "find", async () => {
                assert.fail("webview playback must not probe or require ffplay");
            });
            const { state, context } = setup(t);
            state.settings.audioOutput = output;
            const uri = { scheme: "file", path: "/work/spec.md" };
            state.document = { uri, languageId: "markdown" };
            context.globalStorageUri = { fsPath: mkdtempSync(join(tmpdir(), "markdown-reader-output-")) };
            let opened = false;
            t.mock.method(ReaderPanel, "show", (_context, _document, deps) => {
                opened = true;
                assert.equal(deps.player, undefined, "the panel must use its own webview audio");
            });

            await state.commands.get("markdownReader.open")(uri);

            assert.ok(opened, `${platform}/${output ?? "default"} must open the reader`);
            assert.deepEqual(state.errors, []);
            assert.deepEqual(state.warnings, []);
        });
    }
}

test("an unavailable explicit ffplay selection reports the problem and opens the webview fallback", async (t) => {
    const { state, context } = setup(t);
    state.settings.audioOutput = "ffplay";
    const uri = { scheme: "file", path: "/work/spec.md" };
    state.document = { uri, languageId: "markdown" };
    context.globalStorageUri = { fsPath: mkdtempSync(join(tmpdir(), "markdown-reader-output-")) };
    t.mock.method(NativePlayer, "find", async () => ({ error: "ffplay is not installed" }));
    let opened = false;
    t.mock.method(ReaderPanel, "show", (_context, _document, deps) => {
        opened = true;
        assert.equal(deps.player, undefined);
    });

    await state.commands.get("markdownReader.open")(uri);

    assert.ok(opened);
    assert.match(state.errors[0], /ffplay can't be used, so audio plays in the panel/);
});

test("Read Aloud opens the explicitly selected remote URI instead of an unrelated active editor", async (t) => {
    const { state, context } = setup(t, undefined, () => {
        throw new Error("opening a reader must not synthesize");
    });
    state.settings.audioOutput = "ffplay";
    const uri = {
        scheme: "vscode-remote",
        authority: "ssh-remote+test-host",
        path: "/work/spec.md",
        get fsPath() {
            throw new Error("a remote document path must never be read as a local file");
        },
    };
    state.document = { uri, languageId: "markdown", getText: () => "Unsaved remote document contents." };
    context.globalStorageUri = { fsPath: mkdtempSync(join(tmpdir(), "markdown-reader-local-")) };
    t.mock.property(vscode.window, "activeTextEditor", { document: { languageId: "markdown", getText: () => "An unrelated document." } });
    const player = { play: async () => "ended", pause() {}, resume() {}, stop() {} };
    t.mock.method(NativePlayer, "find", async () => ({ player }));
    let opened;
    t.mock.method(ReaderPanel, "show", (_context, document, deps) => {
        opened = { document, player: deps.player };
    });

    await state.commands.get("markdownReader.open")(uri);

    assert.deepEqual(state.openedUris, [uri]);
    assert.equal(opened.document, state.document);
    assert.equal(opened.document.getText(), "Unsaved remote document contents.");
    assert.equal(opened.player, player);
    assert.deepEqual(state.requests, []);
    assert.deepEqual(state.warnings, []);
});

test("Read Aloud keeps the active remote document when invoked without a URI", async (t) => {
    const { state, context } = setup(t, undefined, () => {
        throw new Error("opening a reader must not synthesize");
    });
    const document = { uri: { scheme: "vscode-remote", path: "/work/active.md" }, languageId: "markdown", getText: () => "Current unsaved text." };
    context.globalStorageUri = { fsPath: mkdtempSync(join(tmpdir(), "markdown-reader-local-")) };
    t.mock.property(vscode.window, "activeTextEditor", { document });
    t.mock.method(NativePlayer, "find", async () => ({ error: "No local ffplay in this test" }));
    let shown;
    t.mock.method(ReaderPanel, "show", (_context, selected) => {
        shown = selected;
    });

    await state.commands.get("markdownReader.open")();

    assert.equal(shown, document);
    assert.deepEqual(state.openedUris, [], "the active document must not be reopened through a local path");
    assert.deepEqual(state.requests, []);
});

test("a malformed replacement key preserves the working key without contacting Inworld", async (t) => {
    const { state, enter } = setup(t, "not a Basic credential", () => {
        throw new Error("validation must not make a request");
    });
    await enter();
    assert.equal(state.key, OLD_KEY);
    assert.deepEqual(state.requests, []);
    assert.match(state.errors[0], /previous API key is still being used/);
});

test("an Inworld rejection preserves the working key and explicitly says it is still being used", async (t) => {
    for (const status of [
        401,
        403,
    ]) {
        const { state, enter } = setup(t, NEW_KEY, () => new Response(JSON.stringify({ message: "Rejected" }), { status }));
        await enter();
        assert.equal(state.key, OLD_KEY);
        assert.match(state.errors[0], /rejected the new API key/);
        assert.match(state.errors[0], /previous API key is still being used/);
        assert.ok(
            state.requests.every((request) => request.method === "GET" && request.url.endsWith("/voices")),
            "validation must list voices, never synthesize",
        );
    }
});

test("an accepted key is trimmed and saved only after the free voice-list request succeeds", async (t) => {
    const { state, enter } = setup(t, `  ${NEW_KEY}  `, () => {
        assert.equal(state.key, OLD_KEY, "the working key must remain stored while validation is in progress");
        return new Response(JSON.stringify({ voices: [] }), { status: 200 });
    });
    await enter();
    assert.equal(state.key, NEW_KEY);
    assert.deepEqual(state.requests, [{ url: "https://api.inworld.ai/tts/v1/voices", method: "GET", authorization: `Basic ${NEW_KEY}` }]);
    assert.deepEqual(state.errors, []);
    assert.deepEqual(state.warnings, []);
});

test("an offline key validation saves the candidate with the warning required by the spec", async (t) => {
    const { state, enter } = setup(t, NEW_KEY, () => {
        throw new TypeError("Network unavailable");
    });
    await enter();
    assert.equal(state.key, NEW_KEY);
    assert.match(state.warnings[0], /saved, but it could not be verified/);
    assert.deepEqual(state.errors, []);
});

test("a rejected first key does not claim that a previous key is still being used", async (t) => {
    const { state, enter } = setup(t, NEW_KEY, () => new Response("Unauthorized", { status: 401 }));
    state.key = undefined;
    await enter();
    assert.equal(state.key, undefined);
    assert.match(state.errors[0], /No API key was saved/);
    assert.ok(!state.errors[0].includes("previous"));
});
