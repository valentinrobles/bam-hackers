import type { InValue } from '@libsql/client';
import type { LibSQLVectorFilter } from './filter.js';
interface FilterResult {
    sql: string;
    values: InValue[];
}
export declare function buildFilterQuery(filter: LibSQLVectorFilter): FilterResult;
export {};
//# sourceMappingURL=sql-builder.d.ts.map