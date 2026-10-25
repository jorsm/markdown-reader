const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { runInNewContext } = require("node:vm");
const { WebviewOutput } = require("../out/reader/AudioOutput.js");

function audioFile() {
    const file = join(mkdtempSync(join(tmpdir(), "markdown-reader-")), "unit.mp3");
    writeFileSync(file, "ID3 fake audio");
    return file;
}

/** Resolves with the promise's result, or "pending" if it has not settled within 50 ms. */
async function settled(promise) {
    let timer;
    const timeout = new Promise((resolve) => (timer = setTimeout(resolve, 50, "pending")));
    return Promise.race([
        promise,
        timeout,
    ]).finally(() => clearTimeout(timer));
}

test("a stop while the unit's file is read ends that unit instead of playing it", async () => {
    const posted = [];
    const output = new WebviewOutput(async (message) => {
        posted.push(message.type);
        return true;
    });
    const playing = output.play(audioFile(), 1);
    output.stop();
    assert.equal(await settled(playing), "stopped");
    assert.ok(!posted.includes("play"), `posted: ${posted.join(", ")}`);
});

test("pausing while a unit loads sends it to the webview paused, until resume is requested", async () => {
    const posted = [];
    let playingMessage;
    const sent = new Promise((resolve) => (playingMessage = resolve));
    const output = new WebviewOutput(async (message) => {
        posted.push(message);
        if (message.type === "play") {
            playingMessage(message);
        }
        return true;
    });
    const playing = output.play(audioFile(), 1);
    output.pause();
    const message = await sent;
    assert.equal(message.paused, true, "loading must not implicitly resume playback");
    output.resume();
    assert.equal(posted.at(-1).type, "resumeAudio");
    output.settle(message.token);
    assert.equal(await playing, "ended");
});

test("resume while a unit is still loading does not replay the previous audio", async () => {
    const posted = [];
    let playingMessage;
    const sent = new Promise((resolve) => (playingMessage = resolve));
    const output = new WebviewOutput(async (message) => {
        posted.push(message);
        if (message.type === "play") {
            playingMessage(message);
        }
        return true;
    });
    const playing = output.play(audioFile(), 1);
    output.pause();
    output.resume();
    assert.ok(!posted.some((message) => message.type === "resumeAudio"), "there is no current audio to resume before the file is loaded");
    const message = await sent;
    assert.equal(message.paused, false);
    output.settle(message.token);
    await playing;
});

test("the panel loads paused audio without playing it until the host sends resume", () => {
    const elements = new Map();
    const element = () => ({ addEventListener() {} });
    let receive;
    let playCalls = 0;
    runInNewContext(readFileSync(join(__dirname, "../media/reader.js"), "utf8"), {
        acquireVsCodeApi: () => ({ postMessage() {} }),
        document: {
            getElementById: (id) => {
                if (!elements.has(id)) {
                    elements.set(id, element());
                }
                return elements.get(id);
            },
            addEventListener() {},
        },
        window: {
            addEventListener: (_name, handler) => {
                receive = handler;
            },
        },
        Audio: class {
            addEventListener() {}
            play() {
                playCalls++;
                return Promise.resolve();
            }
        },
        URL: { createObjectURL: () => "blob:probe", revokeObjectURL() {} },
        Blob,
    });
    receive({ data: { type: "play", token: 1, data: new Uint8Array([1]), paused: true } });
    assert.equal(playCalls, 0, "preparing paused audio must not start sound");
    receive({ data: { type: "resumeAudio" } });
    assert.equal(playCalls, 1, "only an explicit resume starts sound");
});
