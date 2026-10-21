import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { costUsd, type Telemetry } from "../telemetry/Telemetry";
import type { InworldClient, SynthRequest } from "../tts/InworldClient";

/** Bumped when the text rules change what is spoken, so old audio is not reused. */
export const PROCESSOR_ID = "rules-1";

export interface SynthJob extends SynthRequest {
    /** Workspace-relative path of the document, for spend per document. */
    doc: string;
}

/** Turns spoken text into a cached audio file. A cache hit never calls Inworld and costs nothing. */
export class Synthesizer {
    constructor(
        private readonly cacheDir: string,
        private readonly client: InworldClient,
        private readonly telemetry: Telemetry,
        private readonly prices: () => Record<string, number>,
    ) {
        mkdirSync(cacheDir, { recursive: true });
    }

    async ensure(job: SynthJob, signal?: AbortSignal): Promise<string> {
        const file = join(this.cacheDir, `${cacheKey(job)}.mp3`);
        const base = { type: "synth" as const, model: job.modelId, voice: job.voiceId, language: job.language, doc: job.doc, charsSent: job.text.length };
        if (existsSync(file)) {
            this.telemetry.record({ ...base, charsBilled: 0, costUsd: 0, cacheHit: true, totalMs: 0, audioMs: 0 });
            return file;
        }
        try {
            const result = await this.client.synthesize(job, signal);
            writeFileSync(file, result.audio);
            const cost = costUsd(result.charsBilled, job.modelId, this.prices());
            this.telemetry.record({ ...base, charsBilled: result.charsBilled, costUsd: cost, cacheHit: false, totalMs: result.totalMs, audioMs: result.audioMs });
            return file;
        } catch (error) {
            const name = error instanceof Error ? (error.name === "AbortError" ? "aborted" : error.message.slice(0, 120)) : "unknown";
            this.telemetry.record({ ...base, charsBilled: 0, costUsd: 0, cacheHit: false, totalMs: 0, audioMs: 0, error: name });
            throw error;
        }
    }
}

export function cacheKey(job: SynthRequest): string {
    return createHash("sha256")
        .update(
            JSON.stringify([
                "inworld",
                job.modelId,
                job.voiceId,
                job.language,
                PROCESSOR_ID,
                job.text,
            ]),
        )
        .digest("hex")
        .slice(0, 32);
}
