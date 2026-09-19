import type { Context } from 'hono';
export declare function handleError(error: unknown, defaultMessage: string): Promise<Response>;
export declare function errorHandler(err: Error, c: Context, isDev?: boolean): Response;
//# sourceMappingURL=error.d.ts.map