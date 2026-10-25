const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

let current;
const vscode = {
    window: {
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
};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === "vscode" ? "vscode" : resolveFilename.call(this, request, ...rest);
};
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscode };
const { activate } = require("../out/extension.js");

const OLD_KEY = Buffer.from("previous:working-secret").toString("base64");
const NEW_KEY = Buffer.from("candidate:new-secret").toString("base64");

function setup(t, input, answer) {
    current = { input, key: OLD_KEY, errors: [], warnings: [], requests: [], commands: new Map() };
    const state = current;
    t.mock.method(globalThis, "fetch", async (url, init) => {
        state.requests.push({ url, method: init.method, authorization: init.headers.Authorization });
        return answer();
    });
    activate({
        subscriptions: [],
        secrets: {
            get: async () => state.key,
            store: async (_name, key) => {
                state.key = key;
            },
        },
    });
    return { state, enter: () => state.commands.get("markdownReader.setApiKey")() };
}

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
