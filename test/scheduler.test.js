const test = require("node:test");
const assert = require("node:assert/strict");
const { Scheduler, NotWantedError } = require("../out/reader/Scheduler.js");

/** A run whose units finish when the test says so. */
function controllable() {
    const pending = new Map();
    const calls = [];
    const run = (id, signal) =>
        new Promise((resolve, reject) => {
            calls.push(id);
            pending.set(id, { resolve: () => resolve(`${id}.mp3`), reject });
            signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
    return { run, pending, calls };
}

test("a unit dropped from the window rejects its waiters instead of leaving them hanging", async () => {
    const { run } = controllable();
    const scheduler = new Scheduler(() => 1, run);
    scheduler.want([
        "a",
        "b",
    ]);
    const waiting = scheduler.ready("b");
    scheduler.want(["c"]);
    await assert.rejects(waiting, NotWantedError);
});

test("units are prepared in window order, at most `concurrency` at a time", async () => {
    const { run, pending, calls } = controllable();
    const scheduler = new Scheduler(() => 2, run);
    scheduler.want([
        "a",
        "b",
        "c",
    ]);
    assert.deepEqual(calls, [
        "a",
        "b",
    ]);
    pending.get("a").resolve();
    assert.equal(await scheduler.ready("a"), "a.mp3");
    assert.deepEqual(calls, [
        "a",
        "b",
        "c",
    ]);
    assert.ok(scheduler.isReady("a"));
});

test("a unit that failed is tried again when it is wanted again", async () => {
    const { run, pending, calls } = controllable();
    const scheduler = new Scheduler(() => 1, run);
    scheduler.want(["a"]);
    pending.get("a").reject(new Error("Inworld 500"));
    await assert.rejects(scheduler.ready("a"), /Inworld 500/);
    scheduler.want(["a"]);
    assert.deepEqual(calls, [
        "a",
        "a",
    ]);
});
