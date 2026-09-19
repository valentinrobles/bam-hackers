//#region src/segments.ts
const PATTERNS = {
	whitespace: /^\s+$/,
	structuredWhitespace: /\n\s/,
	cjk: /[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u30FF\uFF00-\uFFEF\u2E80-\u2EFF\u31C0-\u31EF\u3200-\u32FF\u3300-\u33FF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/,
	numeric: /^\d+$/,
	punctuation: /[.,!?;(){}[\]<>:/\\|@#$%^&*+=`~_"-]/
};
const TOKEN_SPLIT_PATTERN = new RegExp(`(\\s+|${PATTERNS.punctuation.source}+)`);
const DEFAULT_CHARS_PER_TOKEN = 6;
const SHORT_TOKEN_THRESHOLD = 3;
const KANA_CHARS_PER_TOKEN = 1.35;
const DEFAULT_LANGUAGE_CONFIGS = [
	{
		pattern: /[äöüßẞ]/i,
		averageCharsPerToken: 2.6
	},
	{
		pattern: /[éèêëàâîïôûùüÿçœæáíóúñ]/i,
		averageCharsPerToken: 3
	},
	{
		pattern: /[ąćęłńóśźżěščřžýůúďťň]/i,
		averageCharsPerToken: 2.5
	},
	{
		pattern: /[\u0430-\u044F\u0451]/i,
		averageCharsPerToken: 4
	},
	{
		pattern: /[\u03AC-\u03CE]/i,
		averageCharsPerToken: 2.75
	},
	{
		pattern: /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Component}]*$/u,
		averageCharsPerToken: .75
	}
];
/**
* Walks a text as (segment, estimated token count) pairs. The segments
* concatenate back to the original text; whitespace segments count zero
* tokens unless they carry structure (indentation or blank lines).
*/
function* walkSegments(text, options = {}) {
	if (!text) return;
	const resolvedOptions = resolveOptions(options);
	for (const segment of text.split(TOKEN_SPLIT_PATTERN)) if (segment) yield {
		segment,
		tokenCount: estimateSegmentTokens(segment, resolvedOptions)
	};
}
function resolveOptions(options) {
	return {
		defaultCharsPerToken: options.defaultCharsPerToken ?? DEFAULT_CHARS_PER_TOKEN,
		languageConfigs: options.languageConfigs ?? DEFAULT_LANGUAGE_CONFIGS
	};
}
function estimateSegmentTokens(segment, { languageConfigs, defaultCharsPerToken }) {
	if (PATTERNS.whitespace.test(segment)) return PATTERNS.structuredWhitespace.test(segment) ? 1 : 0;
	const languageCharsPerToken = getLanguageSpecificCharsPerToken(segment, languageConfigs);
	if (languageCharsPerToken !== void 0) return Math.ceil(getCharacterCount(segment) / languageCharsPerToken);
	if (PATTERNS.cjk.test(segment)) return estimateCjkTokens(segment);
	if (PATTERNS.numeric.test(segment)) return Math.ceil(segment.length / 3);
	if (segment.length <= SHORT_TOKEN_THRESHOLD) return 1;
	if (PATTERNS.punctuation.test(segment)) return Math.ceil(segment.length / 2);
	return Math.ceil(segment.length / defaultCharsPerToken);
}
function getLanguageSpecificCharsPerToken(segment, languageConfigs) {
	for (const config of languageConfigs) if (segment.search(config.pattern) !== -1) return config.averageCharsPerToken;
}
function getCharacterCount(text) {
	return Array.from(text).length;
}
function estimateCjkTokens(segment) {
	let kanaCount = 0;
	let otherCount = 0;
	for (const character of segment) {
		const codePoint = character.codePointAt(0);
		if (codePoint >= 12352 && codePoint <= 12543) kanaCount++;
		else otherCount++;
	}
	return otherCount + Math.ceil(kanaCount / KANA_CHARS_PER_TOKEN);
}
//#endregion
//#region src/index.ts
/**
* Checks if a text string is within a specified token limit
*/
function isWithinTokenLimit(text, tokenLimit, options) {
	return estimateTokenCount(text, options) <= tokenLimit;
}
/** @deprecated Use `estimateTokenCount` instead */
const approximateTokenSize = estimateTokenCount;
/**
* Estimates the number of tokens in a text string using heuristic rules
*/
function estimateTokenCount(text, options = {}) {
	if (!text) return 0;
	let tokenCount = 0;
	for (const segmentEstimate of walkSegments(text, options)) tokenCount += segmentEstimate.tokenCount;
	return tokenCount;
}
/**
* Extracts a portion of text based on token positions, similar to Array.prototype.slice()
*/
function sliceByTokens(text, start = 0, end, options = {}) {
	if (!text) return "";
	let segmentEstimates = walkSegments(text, options);
	let totalTokens = 0;
	if (start < 0 || end !== void 0 && end < 0) {
		const bufferedEstimates = Array.from(segmentEstimates);
		for (const { tokenCount } of bufferedEstimates) totalTokens += tokenCount;
		segmentEstimates = bufferedEstimates;
	}
	const normalizedStart = start < 0 ? Math.max(0, totalTokens + start) : Math.max(0, start);
	const normalizedEnd = end === void 0 ? Infinity : end < 0 ? Math.max(0, totalTokens + end) : end;
	if (normalizedStart >= normalizedEnd) return "";
	const parts = [];
	let currentTokenPos = 0;
	for (const { segment, tokenCount } of segmentEstimates) {
		if (currentTokenPos >= normalizedEnd) break;
		const extracted = extractSegmentPart(segment, currentTokenPos, tokenCount, normalizedStart, normalizedEnd);
		if (extracted) parts.push(extracted);
		currentTokenPos += tokenCount;
	}
	return parts.join("");
}
/**
* Splits text into chunks based on token count
*/
function splitByTokens(text, tokensPerChunk, options = {}) {
	if (!text || tokensPerChunk <= 0) return [];
	const overlap = Math.max(0, Math.min(options.overlap ?? 0, tokensPerChunk - 1));
	const chunks = [];
	let currentChunk = [];
	let currentTokenCount = 0;
	let hasUnchunkedSegments = false;
	for (const segmentEstimate of walkSegments(text, options)) {
		currentChunk.push(segmentEstimate);
		currentTokenCount += segmentEstimate.tokenCount;
		hasUnchunkedSegments = true;
		if (currentTokenCount >= tokensPerChunk) {
			chunks.push(joinSegments(currentChunk));
			hasUnchunkedSegments = false;
			if (overlap > 0) {
				const overlapSegments = [];
				let overlapTokenCount = 0;
				for (let i = currentChunk.length - 1; i >= 0 && overlapTokenCount < overlap; i--) {
					const overlapCandidate = currentChunk[i];
					overlapSegments.unshift(overlapCandidate);
					overlapTokenCount += overlapCandidate.tokenCount;
				}
				currentChunk = overlapSegments;
				currentTokenCount = overlapTokenCount;
			} else {
				currentChunk = [];
				currentTokenCount = 0;
			}
		}
	}
	if (currentChunk.length > 0 && hasUnchunkedSegments) chunks.push(joinSegments(currentChunk));
	return chunks;
}
function joinSegments(segmentEstimates) {
	let joined = "";
	for (const { segment } of segmentEstimates) joined += segment;
	return joined;
}
function extractSegmentPart(segment, segmentTokenStart, segmentTokenCount, targetStart, targetEnd) {
	if (segmentTokenCount === 0) return segmentTokenStart >= targetStart && segmentTokenStart < targetEnd ? segment : "";
	const segmentTokenEnd = segmentTokenStart + segmentTokenCount;
	if (segmentTokenStart >= targetEnd || segmentTokenEnd <= targetStart) return "";
	const overlapStart = Math.max(0, targetStart - segmentTokenStart);
	const overlapEnd = Math.min(segmentTokenCount, targetEnd - segmentTokenStart);
	if (overlapStart === 0 && overlapEnd === segmentTokenCount) return segment;
	const charStart = Math.floor(overlapStart / segmentTokenCount * segment.length);
	const charEnd = Math.ceil(overlapEnd / segmentTokenCount * segment.length);
	return segment.slice(charStart, charEnd);
}
//#endregion
export { approximateTokenSize, estimateTokenCount, isWithinTokenLimit, sliceByTokens, splitByTokens };
