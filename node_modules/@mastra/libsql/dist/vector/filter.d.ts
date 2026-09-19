import { BaseFilterTranslator } from '@mastra/core/vector/filter';
import type { VectorFilter, OperatorSupport, OperatorValueMap, VectorFieldValue } from '@mastra/core/vector/filter';
type LibSQLOperatorValueMap = Omit<OperatorValueMap, '$regex' | '$options' | '$in' | '$all' | '$nin' | '$eq' | '$ne'> & {
    $size: number;
    $contains: VectorFieldValue | Record<string, unknown>;
    $all: VectorFieldValue;
    $in: VectorFieldValue;
    $nin: VectorFieldValue;
    $eq: VectorFieldValue;
    $ne: VectorFieldValue;
};
export type LibSQLVectorFilter = VectorFilter<keyof LibSQLOperatorValueMap, LibSQLOperatorValueMap>;
/**
 * Translates MongoDB-style filters to LibSQL compatible filters.
 *
 * Key differences from MongoDB:
 *
 * Logical Operators ($and, $or, $nor):
 * - Can be used at the top level or nested within fields
 * - Can take either a single condition or an array of conditions
 *
 */
export declare class LibSQLFilterTranslator extends BaseFilterTranslator<LibSQLVectorFilter> {
    protected getSupportedOperators(): OperatorSupport;
    translate(filter?: LibSQLVectorFilter): LibSQLVectorFilter;
    private translateNode;
}
export {};
//# sourceMappingURL=filter.d.ts.map