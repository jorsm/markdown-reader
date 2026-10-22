import { mkdirSync } from "node:fs";
import { access, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { costUsd, type Telemetry } from "../telemetry/Telemetry";
import { shortHash } from "../text/units";
import type { InworldClient, SynthRequest } from "../tts/InworldClient";

/** Bumped when the text rules change what is spoken, so old audio is not reused. */
export const PROCESSOR_ID = "rules-1";

/** One unit to synthesize, with the document it belongs to. */
export interface SynthJob extends SynthRequest {
    /** Workspace-relative path of the document, for spend per document. */
    doc: string;
}

/** Turns spoken text into a cached audio file. A cache hit never calls Inworld and costs nothing. */
export class Synthesizer {
    private readonly clearListeners = new Set<() => void>();

    constructor(
        private readonly cacheDir: string,
        private readonly client: InworldClient,
        private readonly telemetry: Telemetry,
        private readonly prices: () => Record<string, number>,
    ) {
        mkdirSync(cacheDir, { recursive: true });
    }

    /** Calls `listener` after the cache is cleared; returns a function that unsubscribes it. */
    onDidClear(listener: () => void): () => void {
        this.clearListeners.add(listener);
        return () => this.clearListeners.delete(listener);
    }

    /** How many audio files the cache holds and their total size. */
    async stats(): Promise<CacheStats> {
        const files = (await this.entries()).filter((f) => f.endsWith(".mp3"));
        // A file removed meanwhile (a write renamed into place, another window clearing) counts as empty.
        const sizes = await Promise.all(
            files.map((f) =>
                stat(join(this.cacheDir, f)).then(
                    (s) => s.size,
                    () => 0,
                ),
            ),
        );
        return { files: files.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
    }

    /** Deletes every cached file, after telling listeners so playback stops first. Listening again bills again. */
    async clear(): Promise<void> {
        this.clearListeners.forEach((listener) => listener());
        const files = await this.entries();
        await Promise.all(files.map((f) => rm(join(this.cacheDir, f), { force: true })));
    }

    private async entries(): Promise<string[]> {
        // The directory is created in the constructor; if it was removed by hand, the cache is empty.
        return readdir(this.cacheDir).catch(() => []);
    }

    /** The unit's audio file: from the cache, or synthesized and cached. Records a `synth` telemetry event either way. */
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

/** Size of the audio cache. */
export interface CacheStats {
    files: number;
    bytes: number;
}

/** The audio cache key: everything that changes the audio (engine, model, voice, language, text rules, text), nothing that does not. */
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

/** The message of any thrown value, for notifications and telemetry. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** True if `file` exists; a cached file can disappear when the cache is cleared, from any window. */
export async function exists(file: string): Promise<boolean> {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}
