import type { IDeployer } from '@mastra/core/deployer';
import { Bundler } from '../bundler/index.js';
import { DepsService } from '../services/deps.js';
export declare abstract class Deployer extends Bundler implements IDeployer {
    deps: DepsService;
    constructor(args: {
        name: string;
    });
    getEnvFiles(): Promise<string[]>;
    abstract deploy(outputDirectory: string): Promise<void>;
}
//# sourceMappingURL=base.d.ts.map