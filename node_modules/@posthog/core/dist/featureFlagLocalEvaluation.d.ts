import type { FeatureFlagValue, JsonType } from './types';
export type FeatureFlagPropertyValue = JsonType;
export type FeatureFlagProperty = {
    key: string;
    value: FeatureFlagPropertyValue;
    operator?: string;
};
export type FeatureFlagSemverParsingPolicy = 'strict' | 'legacy-permissive';
export type MatchFeatureFlagPropertyOptions = {
    warnFunction?: (message: string) => void;
    semverParsingPolicy?: FeatureFlagSemverParsingPolicy;
};
export type FeatureFlagVariant = {
    key: string;
    rollout_percentage: number;
};
export type FeatureFlagVariantLookupEntry = {
    valueMin: number;
    valueMax: number;
    key: string;
};
export declare class InconclusiveMatchError extends Error {
    constructor(message: string);
}
type SemverTuple = [number, number, number];
export declare function parseFeatureFlagSemver(value: string, parsingPolicy?: FeatureFlagSemverParsingPolicy): SemverTuple;
export declare function relativeDateParseForFeatureFlagMatching(value: string): Date | null;
export declare function matchFeatureFlagProperty(property: FeatureFlagProperty, propertyValues: Record<string, any>, options?: MatchFeatureFlagPropertyOptions): boolean;
export declare function hashSHA1(text: string): Promise<string>;
export declare function getFeatureFlagHash(key: string, bucketingValue: string, salt?: string): Promise<number>;
export declare function getFeatureFlagVariantLookupTable(variants: readonly FeatureFlagVariant[]): FeatureFlagVariantLookupEntry[];
export declare function getFeatureFlagVariant(key: string, bucketingValue: string, variants: readonly FeatureFlagVariant[]): Promise<string | undefined>;
export declare function resolveFeatureFlagPayload(payloads: Readonly<Record<string, JsonType | undefined>> | null | undefined, flagValue: FeatureFlagValue | null | undefined): JsonType | null;
export {};
//# sourceMappingURL=featureFlagLocalEvaluation.d.ts.map