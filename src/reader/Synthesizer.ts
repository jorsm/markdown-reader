import { mkdirSync } from "node:fs";
import { access, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { costUsd, type Telemetry } from "../telemetry/Telemetry";
import { shortHash } from "../text/units";
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
        const base = { type: "synth" as const, model: job.modelId, voice: job.voiceId, language: job.language, doc: job.doc, charsSent: job.text.length, charsBilled: 0, costUsd: 0, cacheHit: false, totalMs: 0, audioMs: 0 };
        if (await exists(file)) {
            this.telemetry.record({ ...base, cacheHit: true });
            return file;
        }
        try {
            const result = await this.client.synthesize(job, signal);
            // Write then rename: an interrupted write never leaves a truncated file at the cache key.
            const partial = `${file}.${process.pid}.part`;
            await writeFile(partial, result.audio);
            await rename(partial, file);
            this.telemetry.record({ ...base, charsBilled: result.charsBilled, costUsd: costUsd(result.charsBilled, job.modelId, this.prices()), totalMs: result.totalMs, audioMs: result.audioMs });
            return file;
        } catch (error) {
            this.telemetry.record({ ...base, error: error instanceof Error && error.name === "AbortError" ? "aborted" : errorMessage(error).slice(0, 120) });
            throw error;
        }
    }
}

export function cacheKey(job: SynthRequest): string {
    return shortHash(
        JSON.stringify([
            "inworld",
            job.modelId,
            job.voiceId,
            job.language,
            PROCESSOR_ID,
            job.text,
        ]),
        32,
    );
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function exists(file: string): Promise<boolean> {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}
