const test = require("node:test");
const assert = require("node:assert/strict");
const { NativePlayer } = require("../out/reader/NativePlayer.js");

test("Windows does not select a native player whose pause relies on unsupported POSIX signals", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    try {
        Object.defineProperty(process, "platform", { value: "win32" });
        const found = await NativePlayer.find("a-binary-that-must-not-be-probed");
        assert.ok(!("player" in found));
        assert.match(found.error, /Windows/);
        assert.match(found.error, /webview/);
    } finally {
        Object.defineProperty(process, "platform", platform);
    }
});
