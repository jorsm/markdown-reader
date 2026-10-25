/** Gives one panel ownership of playback, so inactive panels cannot stop another panel's audio. */
export class PlaybackCoordinator {
    private owner: object | undefined;
    private stopOwner: (() => void) | undefined;

    /** Claims playback and stops the previous owner, which updates its own state before the new owner starts. */
    claim(owner: object, stop: () => void): void {
        if (this.owner === owner) {
            return;
        }
        this.stopOwner?.();
        this.owner = owner;
        this.stopOwner = stop;
    }

    /** Releases playback only for its current owner; the result tells the caller whether it may stop the output. */
    release(owner: object): boolean {
        if (this.owner !== owner) {
            return false;
        }
        this.owner = undefined;
        this.stopOwner = undefined;
        return true;
    }
}
