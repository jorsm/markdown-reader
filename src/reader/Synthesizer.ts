import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { access, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { costUsd, type Telemetry } from "../telemetry/Telemetry";
import { shortHash } from "../text/units";
import type { InworldClient, SynthRequest } from "../tts/InworldClient";

/** Bumped when the text rules change what is spoken, so old audio is not reused. */
export const PROCESSOR_ID = "rules-2";

/** One unit to synthesize, with the document it belongs to. */
export interface SynthJob extends SynthRequest {
    /** Workspace-relative path of the document, for spend per document. */
    doc: string;
}

interface InFlight {
    promise: Promise<string>;
    controller: AbortController;
    users: number;
}

/** Turns spoken text into a cached audio file. A cache hit never calls Inworld and costs nothing. */
export class Synthesizer {
    private readonly clearListeners = new Set<() => void>();
    private readonly inFlight = new Map<string, InFlight>();

    constructor(
        private readonly cacheDir: string,
        private readonly client: InworldClient,
        private readonly telemetry: Telemetry,
        private readonly prices: () => Record<string, number>,
    ) {
        mkdirSync(cacheDir, { recursive: true });
    }

    /** Calls `listener` before cached files are removed, so playback can stop; returns an unsubscribe function. */
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
        const pending = [...this.inFlight.values()];
        pending.forEach((entry) => entry.controller.abort());
        await Promise.allSettled(pending.map((entry) => entry.promise));
        const files = await this.entries();
        await Promise.all(files.map((f) => rm(join(this.cacheDir, f), { force: true })));
    }

    private async entries(): Promise<string[]> {
        // The directory is created in the constructor; if it was removed by hand, the cache is empty.
        return readdir(this.cacheDir).catch(() => []);
    }

    /** The unit's audio file: from the cache, or synthesized and cached. Records a `synth` telemetry event either way. */
    async ensure(job: SynthJob, signal?: AbortSignal): Promise<string> {
        signal?.throwIfAborted();
        const file = join(this.cacheDir, `${cacheKey(job)}.mp3`);
        const existing = this.inFlight.get(file);
        const entry = existing ?? this.start(job, file);
        const result = await this.waitFor(file, entry, signal);
        if (existing) {
            this.telemetry.record({ ...this.event(job), cacheHit: true });
        }
        return result;
    }

    private start(job: SynthJob, file: string): InFlight {
        const controller = new AbortController();
        const entry: InFlight = {
            controller,
            users: 0,
            promise: this.prepare(job, file, controller.signal).finally(() => {
                if (this.inFlight.get(file) === entry) {
                    this.inFlight.delete(file);
                }
            }),
        };
        this.inFlight.set(file, entry);
        return entry;
    }

    private async waitFor(file: string, entry: InFlight, signal?: AbortSignal): Promise<string> {
        entry.users++;
        let onAbort: (() => void) | undefined;
        try {
            return await new Promise<string>((resolve, reject) => {
                onAbort = () => reject(signal!.reason);
                signal?.addEventListener("abort", onAbort, { once: true });
                entry.promise.then(resolve, reject);
            });
        } finally {
            if (onAbort) {
                signal?.removeEventListener("abort", onAbort);
            }
            if (--entry.users === 0) {
                entry.controller.abort();
                if (this.inFlight.get(file) === entry) {
                    this.inFlight.delete(file);
                }
            }
        }
    }

    private event(job: SynthJob) {
        return { type: "synth" as const, model: job.modelId, voice: job.voiceId, language: job.language, doc: job.doc, charsSent: job.text.length, charsBilled: 0, costUsd: 0, cacheHit: false, totalMs: 0, audioMs: 0 };
    }

    private async prepare(job: SynthJob, file: string, signal: AbortSignal): Promise<string> {
        const base = this.event(job);
        if (await exists(file)) {
            this.telemetry.record({ ...base, cacheHit: true });
            return file;
        }
        try {
            const result = await this.client.synthesize(job, signal);
            // Write then rename: an interrupted write never leaves a truncated file at the cache key.
            const partial = `${file}.${randomUUID()}.part`;
            try {
                await writeFile(partial, result.audio);
                await rename(partial, file);
            } finally {
                await rm(partial, { force: true });
            }
            this.telemetry.record({ ...base, charsBilled: result.charsBilled, costUsd: costUsd(result.charsBilled, job.modelId, this.prices()), totalMs: result.totalMs, audioMs: result.audioMs });
            return file;
        } catch (error) {
            this.telemetry.record({ ...base, error: error instanceof Error && error.name === "AbortError" ? "aborted" : errorMessage(error).slice(0, 50) });
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
