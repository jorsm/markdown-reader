const test = require("node:test");
const assert = require("node:assert/strict");
const { InworldClient, InworldError } = require("../out/tts/InworldClient.js");

const REQUEST = { text: "A non-empty sentence.", voiceId: "Jason", modelId: "inworld-tts-2-flash", language: "en", context: [] };

test("a truncated successful response fails instead of returning empty audio", async () => {
    const client = new InworldClient(
        async () => "fake",
        async () => new Response('{"audioContent":', { status: 200 }),
    );
    await assert.rejects(client.synthesize(REQUEST), /unreadable JSON response/);
});

test("a successful response without decodable audio fails even when the input text is non-empty", async () => {
    for (const audioContent of [
        undefined,
        null,
        123,
        "",
        "  ",
        "!!!",
    ]) {
        const client = new InworldClient(
            async () => "fake",
            async () => new Response(JSON.stringify({ audioContent }), { status: 200 }),
        );
        await assert.rejects(client.synthesize(REQUEST), /returned no audio/);
    }
});

test("a non-JSON rejected response still reports the authentication status", async () => {
    const client = new InworldClient(
        async () => "fake",
        async () => new Response("Unauthorized", { status: 401 }),
    );
    await assert.rejects(client.listVoices(), (error) => error instanceof InworldError && error.status === 401);
});

test("cancelling while a successful body is read remains an abort instead of a JSON or audio failure", async () => {
    const controller = new AbortController();
    const client = new InworldClient(
        async () => "fake",
        async () => ({
            ok: true,
            json: async () => {
                controller.abort();
                throw controller.signal.reason;
            },
        }),
    );
    await assert.rejects(client.synthesize(REQUEST, controller.signal), { name: "AbortError" });
});
