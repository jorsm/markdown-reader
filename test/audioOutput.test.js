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
