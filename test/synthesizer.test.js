const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readdirSync, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { Telemetry } = require("../out/telemetry/Telemetry.js");
const { InworldClient } = require("../out/tts/InworldClient.js");
const { Synthesizer } = require("../out/reader/Synthesizer.js");

const MARKER = "zebra-marker-7f3a";
const KEY = "c2VjcmV0LWtleS1mb3ItdGVzdHM=";

/** A fake Inworld: answers like the real unary endpoint and counts billed characters as sent. */
function fakeInworld() {
    const calls = [];
    const fetchImpl = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, body, auth: init.headers.Authorization });
        return new Response(JSON.stringify({ audioContent: Buffer.from("ID3 fake audio").toString("base64"), usage: { processedCharactersCount: body.text.length, modelId: body.modelId } }), { status: 200 });
    };
    return { calls, fetchImpl };
}

function setup() {
    const dir = mkdtempSync(join(tmpdir(), "markdown-reader-"));
    const { calls, fetchImpl } = fakeInworld();
    const telemetry = new Telemetry(dir);
    const synthesizer = new Synthesizer(join(dir, "audio"), new InworldClient(async () => KEY, fetchImpl), telemetry, () => ({ "inworld-tts-2-flash": 15 }));
    const job = { text: `This sentence carries ${MARKER}.`, voiceId: "Elliot", modelId: "inworld-tts-2-flash", language: "en", context: [`Earlier ${MARKER} context.`], doc: "docs/specs/x.md" };
    return { dir, calls, telemetry, synthesizer, job };
}

function allFiles(dir) {
    return readdirSync(dir, { recursive: true })
        .map((f) => join(dir, f))
        .filter((f) => statSync(f).isFile());
}

test("document text and the API key never reach telemetry or the spend ledger", async () => {
    const { dir, synthesizer, job } = setup();
    await synthesizer.ensure(job);
    await synthesizer.ensure(job);
    for (const file of allFiles(dir).filter((f) => !f.endsWith(".mp3"))) {
        const content = readFileSync(file, "utf8");
        assert.ok(!content.includes(MARKER), `${file} contains document text`);
        assert.ok(!content.includes(KEY), `${file} contains the API key`);
    }
});

test("spend uses Inworld's billed characters, and a cache hit costs nothing and makes no request", async () => {
    const { calls, telemetry, synthesizer, job } = setup();
    await synthesizer.ensure(job);
    await synthesizer.ensure(job);
    assert.equal(calls.length, 1);
    const month = telemetry.monthSpend();
    assert.equal(month.charsBilled, job.text.length);
    assert.equal(month.costUsd, (job.text.length * 15) / 1_000_000);
    assert.equal(month.requests, 1);
    assert.equal(month.cacheHits, 1);
});

test("a different voice is a different cache entry", async () => {
    const { calls, synthesizer, job } = setup();
    await synthesizer.ensure(job);
    await synthesizer.ensure({ ...job, voiceId: "Beatrice" });
    await synthesizer.ensure(job);
    assert.equal(calls.length, 2);
});

test("preceding text goes to Inworld as unspoken synthesis context, not as text to speak", async () => {
    const { calls, synthesizer, job } = setup();
    await synthesizer.ensure(job);
    assert.equal(calls[0].body.text, job.text);
    assert.deepEqual(calls[0].body.synthesisContext, { previousRequests: [{ text: job.context[0] }] });
    assert.equal(calls[0].auth, `Basic ${KEY}`);
});

test("the month total counts the first spend of the month once", async () => {
    const { telemetry, synthesizer, job } = setup();
    await synthesizer.ensure(job);
    assert.equal(telemetry.monthSpend().charsBilled, job.text.length);
    assert.equal(telemetry.sessionSpend().charsBilled, job.text.length);
});
