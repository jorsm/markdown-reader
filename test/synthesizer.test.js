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

test("clearing the cache tells listeners first, then deletes every audio file", async () => {
    const { dir, calls, synthesizer, job } = setup();
    await synthesizer.ensure(job);
    assert.deepEqual(await synthesizer.stats(), { files: 1, bytes: Buffer.from("ID3 fake audio").length });
    let filesWhenNotified;
    synthesizer.onDidClear(() => (filesWhenNotified = readdirSync(join(dir, "audio")).length));
    await synthesizer.clear();
    assert.equal(filesWhenNotified, 1, "listeners run before the files are deleted, so playback stops first");
    assert.deepEqual(await synthesizer.stats(), { files: 0, bytes: 0 });
    await synthesizer.ensure(job);
    assert.equal(calls.length, 2, "a cleared unit is synthesized again");
});

test("a truncated response leaves no cached audio, so a later attempt can synthesize the sentence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markdown-reader-"));
    let requests = 0;
    const client = new InworldClient(
        async () => KEY,
        async () => {
            requests++;
            return requests === 1 ? new Response('{"audioContent":', { status: 200 }) : new Response(JSON.stringify({ audioContent: Buffer.from("ID3 fake audio").toString("base64"), usage: { processedCharactersCount: 12 } }), { status: 200 });
        },
    );
    const synthesizer = new Synthesizer(join(dir, "audio"), client, new Telemetry(dir), () => ({}));
    const job = { text: "A real sentence.", voiceId: "Jason", modelId: "inworld-tts-2-flash", language: "en", context: [], doc: "probe.md" };
    await assert.rejects(synthesizer.ensure(job), /unreadable JSON response/);
    assert.deepEqual(readdirSync(join(dir, "audio")), [], "a failed response must not poison the audio cache");
    const file = await synthesizer.ensure(job);
    assert.equal(readFileSync(file, "utf8"), "ID3 fake audio");
    assert.equal(requests, 2, "the retry must reach the provider instead of finding an empty cache entry");
});

test("simultaneous requests for identical audio share one synthesis and record one bill", async () => {
    const { synthesizer, job, calls, telemetry, dir } = setup();
    const files = await Promise.all([
        synthesizer.ensure(job),
        synthesizer.ensure(job),
    ]);
    assert.equal(files[0], files[1]);
    assert.equal(calls.length, 1);
    assert.equal(telemetry.monthSpend().requests, 1);
    assert.equal(telemetry.monthSpend().cacheHits, 1);
    assert.equal(telemetry.monthSpend().charsBilled, job.text.length);
    assert.ok(!allFiles(dir).some((file) => file.endsWith(".part")));
});

test("cancelling one waiter leaves the shared synthesis running for the other panel", async () => {
    const { dir, telemetry, job } = setup();
    let complete;
    let providerSignal;
    const client = {
        synthesize: (_job, signal) => {
            providerSignal = signal;
            return new Promise((resolve) => {
                complete = resolve;
            });
        },
    };
    const synthesizer = new Synthesizer(join(dir, "audio"), client, telemetry, () => ({}));
    const abort = new AbortController();
    const first = synthesizer.ensure(job, abort.signal);
    const firstRejected = assert.rejects(first, { name: "AbortError" });
    const second = synthesizer.ensure(job);
    while (!complete) await new Promise(setImmediate);
    abort.abort();
    await firstRejected;
    assert.equal(providerSignal.aborted, false);
    complete({ audio: Buffer.from("audio"), charsBilled: job.text.length, totalMs: 1, audioMs: 1 });
    assert.equal(readFileSync(await second, "utf8"), "audio");
    assert.equal(telemetry.monthSpend().requests, 1);
});

test("cancelling every waiter aborts the provider and allows an immediate retry", async () => {
    const { dir, telemetry, job } = setup();
    let providerSignal;
    let requests = 0;
    const client = {
        synthesize: (_job, signal) => {
            requests++;
            providerSignal = signal;
            if (requests > 1) return Promise.resolve({ audio: Buffer.from("retry audio"), charsBilled: job.text.length, totalMs: 1, audioMs: 1 });
            return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        },
    };
    const synthesizer = new Synthesizer(join(dir, "audio"), client, telemetry, () => ({}));
    const abort = new AbortController();
    const first = synthesizer.ensure(job, abort.signal);
    const second = synthesizer.ensure(job, abort.signal);
    const rejected = Promise.all([
        assert.rejects(first, { name: "AbortError" }),
        assert.rejects(second, { name: "AbortError" }),
    ]);
    while (!providerSignal) await new Promise(setImmediate);
    abort.abort();
    await rejected;
    assert.equal(providerSignal.aborted, true);
    assert.equal(readFileSync(await synthesizer.ensure(job), "utf8"), "retry audio");
    assert.equal(requests, 2);
});

test("independent synthesizers cannot collide on a temporary cache file", async () => {
    const { dir, synthesizer, job, telemetry } = setup();
    const { fetchImpl } = fakeInworld();
    const second = new Synthesizer(join(dir, "audio"), new InworldClient(async () => KEY, fetchImpl), telemetry, () => ({}));
    const files = await Promise.all([
        synthesizer.ensure(job),
        second.ensure(job),
    ]);
    files.forEach((file) => assert.equal(readFileSync(file, "utf8"), "ID3 fake audio"));
    assert.ok(!allFiles(dir).some((file) => file.endsWith(".part")));
    assert.equal(telemetry.monthSpend().requests, 2, "separate hosts may synthesize twice, and both bills must be retained");
});
