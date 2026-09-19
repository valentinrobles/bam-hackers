export declare class FileService {
    /**
     *
     * @param inputFile the file in the starter files directory to copy
     * @param outputFilePath the destination path
     * @param replaceIfExists flag to replace if it exists
     * @returns
     */
    copyStarterFile(inputFile: string, outputFilePath: string, replaceIfExists?: boolean): Promise<boolean>;
    setupEnvFile({ dbUrl }: {
        dbUrl: string;
    }): Promise<void>;
    getFirstExistingFile(files: string[]): string;
    replaceValuesInFile({ filePath, replacements, }: {
        filePath: string;
        replacements: {
            search: string;
            replace: string;
        }[];
    }): void;
}
//# sourceMappingURL=service.file.d.ts.map