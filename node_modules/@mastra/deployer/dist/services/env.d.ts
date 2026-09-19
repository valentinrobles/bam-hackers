export declare abstract class EnvService {
    abstract getEnvValue(key: string): Promise<string | null>;
    abstract setEnvValue(key: string, value: string): Promise<void>;
}
export declare class FileEnvService extends EnvService {
    private filePath;
    constructor(filePath: string);
    private readFile;
    private writeFile;
    private updateEnvData;
    getEnvValue(key: string): Promise<string | null>;
    setEnvValue(key: string, value: string): Promise<void>;
}
//# sourceMappingURL=env.d.ts.map