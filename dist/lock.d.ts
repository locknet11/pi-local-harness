export declare class Lock {
    private readonly dir;
    private held;
    constructor(dir: string);
    private get pidFile();
    acquire(): boolean;
    ownerPid(): number | null;
    release(): void;
}
export declare function isAlive(pid: number): boolean;
export declare function readPidFile(path: string): number | null;
export declare function writePidFile(path: string, pid: number): void;
