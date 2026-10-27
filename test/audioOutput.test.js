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

function panelScript() {
    const elements = new Map();
    const element = () => ({
        dataset: {},
        attributes: {},
        listeners: {},
        addEventListener(name, handler) {
            this.listeners[name] = handler;
        },
        setAttribute(name, value) {
            this.attributes[name] = value;
        },
        click() {
            this.listeners.click();
        },
    });
    const posted = [];
    let receive;
    let playCalls = 0;
    runInNewContext(readFileSync(join(__dirname, "../media/reader.js"), "utf8"), {
        acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(message) }),
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
    return { elements, posted, receive: (message) => receive({ data: message }), playCalls: () => playCalls };
}

test("the panel loads paused audio without playing it until the host sends resume", () => {
    const panel = panelScript();
    panel.receive({ type: "play", token: 1, data: new Uint8Array([1]), paused: true });
    assert.equal(panel.playCalls(), 0, "preparing paused audio must not start sound");
    panel.receive({ type: "resumeAudio" });
    assert.equal(panel.playCalls(), 1, "only an explicit resume starts sound");
});

test("the loading button remains a pause control and clears its spinner when ready, paused or stopped", () => {
    const panel = panelScript();
    const button = panel.elements.get("play");
    const status = panel.elements.get("status");
    panel.receive({ type: "state", state: "playing" });
    panel.receive({ type: "waiting", waiting: true });
    assert.equal(button.dataset.loading, "true");
    assert.equal(button.attributes["aria-busy"], "true");
    assert.match(button.attributes["aria-label"], /Pause.*preparing audio/);
    assert.equal(status.textContent, "Preparing audio…");
    button.click();
    assert.equal(panel.posted.at(-1).type, "pause", "the loading control must still be usable");

    panel.receive({ type: "state", state: "paused" });
    assert.equal(button.dataset.loading, "false");
    assert.equal(button.attributes["aria-busy"], "false");
    assert.equal(button.attributes["aria-label"], "Resume");
    button.click();
    assert.equal(panel.posted.at(-1).type, "resume");

    panel.receive({ type: "state", state: "playing" });
    assert.equal(button.dataset.loading, "true", "resuming an unfinished request still shows loading");
    panel.receive({ type: "waiting", waiting: false });
    assert.equal(button.dataset.loading, "false");
    assert.equal(button.attributes["aria-label"], "Pause");
    assert.equal(status.textContent, "");

    panel.receive({ type: "waiting", waiting: true });
    panel.receive({ type: "state", state: "stopped" });
    assert.equal(button.dataset.loading, "false");
    assert.equal(button.attributes["aria-busy"], "false");
    assert.equal(button.attributes["aria-label"], "Play");
    assert.equal(status.textContent, "");
    panel.receive({ type: "state", state: "playing" });
    assert.equal(button.dataset.loading, "false", "a stopped session must not leave loading behind");
});
