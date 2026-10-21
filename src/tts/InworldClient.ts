const API = "https://api.inworld.ai/tts/v1";

export interface SynthRequest {
    text: string;
    voiceId: string;
    modelId: string;
    language: string;
    /** Preceding text, used by Inworld for intonation; neither spoken nor billed. */
    context: string[];
}

export interface SynthResult {
    /** Ogg Opus audio. */
    audio: Buffer;
    charsBilled: number;
    totalMs: number;
    audioMs: number;
}

export interface Voice {
    voiceId: string;
    displayName: string;
    description: string;
    languages: string[];
}

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

    async synthesize(request: SynthRequest, signal?: AbortSignal): Promise<SynthResult> {
        const started = performance.now();
        const body: Record<string, unknown> = {
            text: request.text,
            voiceId: request.voiceId,
            modelId: request.modelId,
            language: request.language,
            audioConfig: { audioEncoding: "OGG_OPUS", bitRate: 32000 },
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
            audioMs: oggOpusDurationMs(audio),
        };
    }

    async listVoices(): Promise<Voice[]> {
        const json = await this.call("/voices", { method: "GET" });
        return (json.voices ?? []) as Voice[];
    }

    private async call(path: string, init: RequestInit): Promise<any> {
        const key = await this.apiKey();
        if (!key) {
            throw new InworldError(401, "No Inworld API key. Run “Markdown Reader: Set API Key”.");
        }
        const response = await this.fetchImpl(`${API}${path}`, { ...init, headers: { Authorization: `Basic ${key}`, "Content-Type": "application/json" } });
        // An error body that isn't JSON still yields the status below.
        const json: any = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new InworldError(response.status, `Inworld ${response.status}: ${json?.message ?? json?.error?.message ?? response.statusText}`);
        }
        return json;
    }
}

/** Duration from the last Ogg page's granule position (48 kHz for Opus), minus the encoder's pre-skip. */
export function oggOpusDurationMs(ogg: Buffer): number {
    const last = ogg.lastIndexOf("OggS");
    const head = ogg.indexOf("OpusHead");
    if (last < 0 || last + 14 > ogg.length) {
        return 0;
    }
    const granule = Number(ogg.readBigUInt64LE(last + 6));
    const preSkip = head >= 0 && head + 12 <= ogg.length ? ogg.readUInt16LE(head + 10) : 0;
    return Math.max(0, Math.round((granule - preSkip) / 48));
}
