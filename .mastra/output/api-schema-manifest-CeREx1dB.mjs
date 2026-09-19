import { S as SERVER_ROUTES, c as schemaToJsonSchema } from './index.mjs';
import '@mastra/core/evals/scoreTraces';
import '@mastra/core/mastra';
import '@mastra/loggers';
import '@mastra/core/agent';
import '@chat-adapter/telegram';
import './patient-memory.mjs';
import '@mastra/memory';
import './storage.mjs';
import 'node:fs';
import 'node:path';
import '@mastra/libsql';
import 'zod';
import './nebius.mjs';
import 'chat';
import './tickets.mjs';
import '@libsql/client';
import 'node:crypto';
import './tools/80a53523-8894-ad48-053e-548fff21baa7.mjs';
import '@mastra/core/tools';
import './tools/06500b67-0372-b96a-8569-6574078588e3.mjs';
import './tools/8536deb5-171f-f5a8-af8a-2187b32d2353.mjs';
import './tools/abcc5ea5-aa0f-e662-f224-b8898923c3bb.mjs';
import './start-video-call.mjs';
import '@mastra/core/request-context';
import '@mastra/core/server';
import 'crypto';
import 'fs';
import 'fs/promises';
import 'path';
import 'url';
import 'stream';
import 'https';
import 'http';
import 'http2';
import 'process';
import 'zod/v4';
import 'zod/v3';
import '@mastra/core/schema';
import '@mastra/core/utils/zod-to-json';
import '@mastra/core/auth/ee';
import '@mastra/core/memory';
import '@mastra/core/stream';
import '@mastra/core/agent/durable';
import '@mastra/core/di';
import '@mastra/core/error';
import '@mastra/core/llm';
import 'module';
import 'util';
import '@mastra/core/a2a';
import 'dns/promises';
import 'net';
import '@mastra/core/utils';
import '@mastra/core/features';
import '@mastra/core/storage';
import '@mastra/core/observability';
import '@mastra/core/evals';
import '@mastra/core/processors';
import '@mastra/core/workspace';
import 'stream/promises';
import 'buffer';
import './tools.mjs';

//#region src/server/server-adapter/api-schema-manifest.ts
function convertSchema(schema) {
	return schema ? schemaToJsonSchema(schema) : void 0;
}
function asJsonSchema(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function schemaType(schema) {
	const type = schema?.type;
	return Array.isArray(type) ? type.find(Boolean) : type;
}
function inferResponseShape(responseSchema) {
	if (!responseSchema) return { kind: "unknown" };
	const type = schemaType(responseSchema);
	if (type === "array") return { kind: "array" };
	if (type !== "object") return { kind: "single" };
	const properties = responseSchema.properties && !Array.isArray(responseSchema.properties) ? responseSchema.properties : {};
	const propertyNames = Object.keys(properties);
	const paginationProperty = "page" in properties ? "page" : "pagination" in properties ? "pagination" : void 0;
	const listProperty = Object.entries(properties).find(([, property]) => schemaType(asJsonSchema(property)) === "array")?.[0];
	if (listProperty && (paginationProperty || propertyNames.length <= 2)) return {
		kind: "object-property",
		listProperty,
		paginationProperty
	};
	if (responseSchema.additionalProperties && propertyNames.length === 0) return { kind: "record" };
	return { kind: "single" };
}
function isManifestRoute(route) {
	return route.responseType === "json" && !route.deprecated;
}
function buildApiSchemaManifest(routes = SERVER_ROUTES) {
	return {
		version: 1,
		routes: routes.filter(isManifestRoute).map((route) => {
			const responseSchema = convertSchema(route.responseSchema);
			return {
				method: route.method,
				path: route.path,
				responseType: route.responseType,
				pathParamSchema: convertSchema(route.pathParamSchema),
				queryParamSchema: convertSchema(route.queryParamSchema),
				bodySchema: convertSchema(route.bodySchema),
				responseSchema,
				responseShape: inferResponseShape(responseSchema)
			};
		})
	};
}

export { buildApiSchemaManifest };
