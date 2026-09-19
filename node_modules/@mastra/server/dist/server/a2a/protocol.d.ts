import type { JSONRPCError, JSONRPCResponse, Message } from '@mastra/core/a2a';
import type { CoreMessage } from '@mastra/core/llm';
import type { IMastraLogger } from '@mastra/core/logger';
export declare function normalizeError(error: any, reqId: number | string | null, taskId?: string, logger?: IMastraLogger): JSONRPCResponse<null, unknown>;
export declare function createErrorResponse(id: number | string | null, error: JSONRPCError<unknown>): JSONRPCResponse<null, unknown>;
export declare function createSuccessResponse<T>(id: number | string | null, result: T): JSONRPCResponse<T>;
export declare function convertToCoreMessage(message: Message): CoreMessage;
//# sourceMappingURL=protocol.d.ts.map