const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readdirSync, readFileSync, writeFileSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { Telemetry } = require("../out/telemetry/Telemetry.js");

const now = () => new Date("2026-10-25T12:00:00Z");
const synthesis = { type: "synth", model: "inworld-tts-2-flash", voice: "Jason", language: "en", doc: "spec.md", charsSent: 100, charsBilled: 100, costUsd: 1, cacheHit: false, totalMs: 1, audioMs: 1 };

test("two windows retain each other's spend before and after restarting", () => {
    const dir = mkdtempSync(join(tmpdir(), "markdown-reader-"));
    const first = new Telemetry(dir, now);
    const second = new Telemetry(dir, now);
    first.record(synthesis);
    assert.equal(second.monthSpend().charsBilled, 100);
    second.record(synthesis);
    first.record(synthesis);
    assert.deepEqual(first.monthSpend(), { charsBilled: 300, costUsd: 3, requests: 3, cacheHits: 0 });
    assert.deepEqual(second.monthSpend(), first.monthSpend(), "a previously read writer file must be refreshed after it grows");
    assert.deepEqual(new Telemetry(dir, now).monthSpend(), first.monthSpend());
    assert.equal(first.sessionSpend().requests, 2);
    assert.equal(second.sessionSpend().requests, 1);
    assert.equal(readdirSync(join(dir, "spend")).length, 2, "each writer owns its own dated journal");
});

test("new spend journals retain the legacy ledger as an unchanged baseline", () => {
    const dir = mkdtempSync(join(tmpdir(), "markdown-reader-"));
    const baseline = JSON.stringify({ "2026-10-01": { oldModel: { charsBilled: 400, costUsd: 4, requests: 4, cacheHits: 2 } } });
    writeFileSync(join(dir, "spend.json"), baseline);
    const telemetry = new Telemetry(dir, now);
    telemetry.record(synthesis);
    telemetry.record({ ...synthesis, charsBilled: 0, costUsd: 0, cacheHit: true });
    assert.deepEqual(new Telemetry(dir, now).monthSpend(), { charsBilled: 500, costUsd: 5, requests: 5, cacheHits: 3 });
    assert.equal(readFileSync(join(dir, "spend.json"), "utf8"), baseline);
});

test("month selection uses dated journals and diagnostic retention never deletes spend", () => {
    const dir = mkdtempSync(join(tmpdir(), "markdown-reader-"));
    let date = new Date("2026-09-01T12:00:00Z");
    const telemetry = new Telemetry(dir, () => date);
    telemetry.record(synthesis);
    date = now();
    telemetry.record({ ...synthesis, charsBilled: 200 });
    const restarted = new Telemetry(dir, () => date);
    assert.equal(restarted.monthSpend().charsBilled, 200);
    assert.ok(!readdirSync(join(dir, "telemetry")).some((file) => file.startsWith("2026-09")));
    assert.ok(readdirSync(join(dir, "spend")).some((file) => file.startsWith("2026-09")));
    date = new Date("2026-09-02T12:00:00Z");
    assert.equal(restarted.monthSpend().charsBilled, 100);
});

test("an interrupted journal append does not hide completed records", () => {
    const dir = mkdtempSync(join(tmpdir(), "markdown-reader-"));
    const writer = new Telemetry(dir, now);
    writer.record(synthesis);
    const path = join(dir, "spend", readdirSync(join(dir, "spend"))[0]);
    appendFileSync(path, '{"model":');
    const reader = new Telemetry(dir, now);
    assert.equal(reader.monthSpend().charsBilled, 100);
    assert.equal(reader.monthSpend().charsBilled, 100);
    appendFileSync(path, '"recovered","charsBilled":50,"costUsd":0,"requests":1,"cacheHits":0}\n');
    assert.equal(reader.monthSpend().charsBilled, 150);
});
