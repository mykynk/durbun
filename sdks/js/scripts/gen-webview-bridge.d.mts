// Types for the tests that import the generator.
export declare const ENTRY: string;
export declare const ANDROID_COPY: string;
export declare const IOS_COPY: string;
export declare function bundleBridge(): string;
export declare function kotlinSource(script: string): string;
export declare function swiftSource(script: string): string;
export declare function copies(): Array<[string, string]>;
export declare function drifted(): string[];
