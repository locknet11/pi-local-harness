export declare const color: {
    dim: (s: string) => string;
    red: (s: string) => string;
    green: (s: string) => string;
    yellow: (s: string) => string;
    blue: (s: string) => string;
    cyan: (s: string) => string;
    bold: (s: string) => string;
};
export declare function configureLogging(opts: {
    file?: string;
    mirror?: boolean;
}): void;
export declare const log: {
    plain(msg: string): void;
    info(msg: string): void;
    ok(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    step(msg: string): void;
    detail(msg: string): void;
    /** Indented excerpt of command output, trimmed to the last `maxLines`. */
    excerpt(text: string, maxLines?: number): void;
    blank(): void;
};
export declare function formatDuration(seconds: number): string;
/** "25m" / "90s" / "2h" / "1500" -> seconds */
export declare function parseDuration(value: string | number): number;
