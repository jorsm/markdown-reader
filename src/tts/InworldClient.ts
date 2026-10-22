const API = "https://api.inworld.ai/tts/v1";
const MP3_BIT_RATE = 64000;
/** A request that takes longer has hung: it fails instead of holding a scheduler slot forever. */
const REQUEST_TIMEOUT_MS = 20_000;

/** What Inworld is asked to say, and how. */
export interface SynthRequest {
    text: string;
    voiceId: string;
    modelId: string;
    language: string;
    /** Preceding text, used by Inworld for intonation; neither spoken nor billed. */
    context: string[];
}

/** Inworld's answer with what telemetry and spend need. */
export interface SynthResult {
    /** MP3 audio, constant bit rate. */
    audio: Buffer;
    charsBilled: number;
    totalMs: number;
    audioMs: number;
}

/** An Inworld voice, as its voice list describes it. */
export interface Voice {
    voiceId: string;
    displayName: string;
    description: string;
    languages: string[];
}

/** A request Inworld answered with an error status; 401 and 403 mean the key is wrong. */
export class InworldError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

/** Inworld TTS over its REST API. The key is the portal's Base64 credential, sent as Basic auth. */
export class InworldClient {
    constructor(
        private readonly apiKey: () => Promise<string | undefined>,
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    /** Synthesizes one unit as MP3; `signal` aborts it. */
    async synthesize(request: SynthRequest, signal?: AbortSignal): Promise<SynthResult> {
        const started = performance.now();
        const body: Record<string, unknown> = {
            text: request.text,
            voiceId: request.voiceId,
            modelId: request.modelId,
            language: request.language,
            // MP3, not Ogg Opus: VS Code's webview cannot decode Opus (tested in VS Code 1.142).
            audioConfig: { audioEncoding: "MP3", bitRate: MP3_BIT_RATE },
        };
        if (request.context.length) {
            body.synthesisContext = { previousRequests: request.context.map((text) => ({ text })) };
        }
        const json = await this.call("/voice", { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
        const audio = Buffer.from(String(json.audioContent ?? ""), "base64");
        return {
            audio,
            charsBilled: Number(json.usage?.processedCharactersCount ?? 0),
            totalMs: Math.round(performance.now() - started),
            audioMs: mp3DurationMs(audio),
        };
    }

    /** Inworld's voices, all languages; free, so it also checks the key. */
    async listVoices(): Promise<Voice[]> {
        const json = await this.call("/voices", { method: "GET" });
        return (json.voices ?? []) as Voice[];
    }

    private async call(path: string, init: RequestInit): Promise<any> {
        const key = await this.apiKey();
        if (!key) {
            throw new InworldError(401, "No Inworld API key. Run “Markdown Reader: Set API Key”.");
        }
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const signal = init.signal
            ? AbortSignal.any([
                  init.signal,
                  timeout,
              ])
            : timeout;
        const response = await this.fetchImpl(`${API}${path}`, { ...init, signal, headers: { Authorization: `Basic ${key}`, "Content-Type": "application/json" } });
        // An error body that isn't JSON still yields the status below.
        const json: any = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new InworldError(response.status, `Inworld ${response.status}: ${json?.message ?? json?.error?.message ?? response.statusText}`);
        }
        return json;
    }
}

/** Duration of constant-bit-rate MP3 from its size; close enough for telemetry. */
export function mp3DurationMs(mp3: Buffer): number {
    return Math.round((mp3.length * 8 * 1000) / MP3_BIT_RATE);
}
