const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { WebviewOutput } = require("../out/reader/AudioOutput.js");

function audioFile() {
    const file = join(mkdtempSync(join(tmpdir(), "markdown-reader-")), "unit.mp3");
    writeFileSync(file, "ID3 fake audio");
    return file;
}

/** Resolves with the first result, or with "pending" if the promise has not settled after a few event-loop turns. */
async function settled(promise) {
    const timeout = new Promise((resolve) => setTimeout(() => resolve("pending"), 50));
    return Promise.race([
        promise,
        timeout,
    ]);
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

test("a unit sent to a closed panel ends as stopped instead of waiting forever for the panel", async () => {
    // A closed panel's webview takes no messages, so no "ended" will ever come back.
    const output = new WebviewOutput(async () => false);
    assert.equal(await settled(output.play(audioFile(), 1)), "stopped");
});
