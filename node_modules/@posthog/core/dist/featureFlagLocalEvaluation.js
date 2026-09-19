"use strict";
var __webpack_require__ = {};
(()=>{
    __webpack_require__.d = (exports1, getters, values)=>{
        var define = (defs, kind)=>{
            for(var key in defs)if (__webpack_require__.o(defs, key) && !__webpack_require__.o(exports1, key)) Object.defineProperty(exports1, key, {
                enumerable: true,
                [kind]: defs[key]
            });
        };
        define(getters, "get");
        define(values, "value");
    };
})();
(()=>{
    __webpack_require__.o = (obj, prop)=>Object.prototype.hasOwnProperty.call(obj, prop);
})();
(()=>{
    __webpack_require__.r = (exports1)=>{
        if ("u" > typeof Symbol && Symbol.toStringTag) Object.defineProperty(exports1, Symbol.toStringTag, {
            value: 'Module'
        });
        Object.defineProperty(exports1, '__esModule', {
            value: true
        });
    };
})();
var __webpack_exports__ = {};
__webpack_require__.r(__webpack_exports__);
__webpack_require__.d(__webpack_exports__, {
    InconclusiveMatchError: ()=>InconclusiveMatchError,
    getFeatureFlagHash: ()=>getFeatureFlagHash,
    getFeatureFlagVariant: ()=>getFeatureFlagVariant,
    getFeatureFlagVariantLookupTable: ()=>getFeatureFlagVariantLookupTable,
    hashSHA1: ()=>hashSHA1,
    matchFeatureFlagProperty: ()=>matchFeatureFlagProperty,
    parseFeatureFlagSemver: ()=>parseFeatureFlagSemver,
    relativeDateParseForFeatureFlagMatching: ()=>relativeDateParseForFeatureFlagMatching,
    resolveFeatureFlagPayload: ()=>resolveFeatureFlagPayload
});
const external_featureFlagUtils_js_namespaceObject = require("./featureFlagUtils.js");
const NULL_VALUES_ALLOWED_OPERATORS = [
    'is_not',
    'is_set'
];
const LONG_SCALE = 0xfffffffffffffff;
class InconclusiveMatchError extends Error {
    constructor(message){
        super(message);
        this.name = this.constructor.name;
        Object.setPrototypeOf(this, InconclusiveMatchError.prototype);
    }
}
function isTruthyOrFalsyPropertyValue(value) {
    if ('boolean' == typeof value) return true;
    if ('string' == typeof value) {
        const lowercaseValue = value.toLowerCase();
        return 'true' === lowercaseValue || 'false' === lowercaseValue;
    }
    if (!Array.isArray(value)) return false;
    for(let index = 0; index < value.length; index++)if (!isTruthyOrFalsyPropertyValue(index in value ? value[index] : null)) return false;
    return true;
}
function isTruthyPropertyValue(value) {
    if ('boolean' == typeof value) return value;
    if ('string' == typeof value) return 'true' === value.toLowerCase();
    if (!Array.isArray(value)) return false;
    for(let index = 0; index < value.length; index++)if (!isTruthyPropertyValue(index in value ? value[index] : null)) return false;
    return true;
}
function assertUnicodeScalarString(value) {
    for(let index = 0; index < value.length; index++){
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) throw new InconclusiveMatchError('Cannot stringify an unpaired surrogate like the flags service');
            index++;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new InconclusiveMatchError('Cannot stringify an unpaired surrogate like the flags service');
    }
}
function assertJsonRepresentable(value, seen = new Set()) {
    if (null === value || 'boolean' == typeof value) return;
    if ('string' == typeof value) return void assertUnicodeScalarString(value);
    if ('number' == typeof value) {
        if (!Number.isFinite(value)) throw new InconclusiveMatchError(`Cannot represent non-finite number ${value} like the flags service`);
        return;
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) throw new InconclusiveMatchError('Cannot represent a circular array during local evaluation');
        seen.add(value);
        try {
            for(let index = 0; index < value.length; index++)if (index in value) assertJsonRepresentable(value[index], seen);
        } finally{
            seen.delete(value);
        }
        return;
    }
    if ('object' == typeof value) {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && null !== prototype) throw new InconclusiveMatchError('Cannot represent a non-JSON object like the flags service');
        if (seen.has(value)) throw new InconclusiveMatchError('Cannot represent a circular object during local evaluation');
        seen.add(value);
        try {
            for (const key of Object.keys(value)){
                assertUnicodeScalarString(key);
                assertJsonRepresentable(value[key], seen);
            }
        } finally{
            seen.delete(value);
        }
        return;
    }
    throw new InconclusiveMatchError(`Cannot represent ${typeof value} like the flags service`);
}
function compareJsonObjectKeys(left, right) {
    let leftIndex = 0;
    let rightIndex = 0;
    while(leftIndex < left.length && rightIndex < right.length){
        const leftUnit = left.charCodeAt(leftIndex);
        const rightUnit = right.charCodeAt(rightIndex);
        const leftIsHighSurrogate = leftUnit >= 0xd800 && leftUnit <= 0xdbff;
        const rightIsHighSurrogate = rightUnit >= 0xd800 && rightUnit <= 0xdbff;
        const leftNext = leftIsHighSurrogate ? left.charCodeAt(leftIndex + 1) : 0;
        const rightNext = rightIsHighSurrogate ? right.charCodeAt(rightIndex + 1) : 0;
        const leftCodePoint = leftIsHighSurrogate ? (leftUnit - 0xd800) * 0x400 + leftNext - 0xdc00 + 0x10000 : leftUnit;
        const rightCodePoint = rightIsHighSurrogate ? (rightUnit - 0xd800) * 0x400 + rightNext - 0xdc00 + 0x10000 : rightUnit;
        if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
        leftIndex += leftIsHighSurrogate ? 2 : 1;
        rightIndex += rightIsHighSurrogate ? 2 : 1;
    }
    return left.length - right.length;
}
function serializeJsonValue(value, seen = new Set()) {
    if (null === value) return 'null';
    if ('string' == typeof value) {
        assertUnicodeScalarString(value);
        return JSON.stringify(value);
    }
    if ('boolean' == typeof value) return value ? 'true' : 'false';
    if ('number' == typeof value) {
        if (!Number.isFinite(value)) throw new InconclusiveMatchError(`Cannot stringify non-finite number ${value} like the flags service`);
        if (Number.isInteger(value)) throw new InconclusiveMatchError(`Cannot distinguish integer ${value} from an integral JSON float during local evaluation`);
        return String(value);
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) throw new InconclusiveMatchError('Cannot stringify a circular array during local evaluation');
        seen.add(value);
        try {
            const items = [];
            for(let index = 0; index < value.length; index++)items.push(index in value ? serializeJsonValue(value[index], seen) : 'null');
            return `[${items.join(',')}]`;
        } finally{
            seen.delete(value);
        }
    }
    if ('object' == typeof value) {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && null !== prototype) throw new InconclusiveMatchError('Cannot stringify a non-JSON object like the flags service');
        if (seen.has(value)) throw new InconclusiveMatchError('Cannot stringify a circular object during local evaluation');
        seen.add(value);
        try {
            const keys = Object.keys(value);
            keys.forEach(assertUnicodeScalarString);
            return `{${keys.sort(compareJsonObjectKeys).map((key)=>`${JSON.stringify(key)}:${serializeJsonValue(value[key], seen)}`).join(',')}}`;
        } finally{
            seen.delete(value);
        }
    }
    throw new InconclusiveMatchError(`Cannot stringify ${typeof value} like the flags service`);
}
function exactMatchString(value) {
    if ('string' == typeof value) {
        assertUnicodeScalarString(value);
        return value;
    }
    return serializeJsonValue(value);
}
function isValidRegex(regex) {
    try {
        new RegExp(regex);
        return true;
    } catch  {
        return false;
    }
}
function asciiLowercase(value) {
    return String(value).replace(/[A-Z]/g, (character)=>character.toLowerCase());
}
function parseSemverNumericIdentifier(part, raw, parsingPolicy) {
    if (!/^\d+$/.test(part) || 'strict' === parsingPolicy && part.length > 1 && '0' === part[0]) throw new InconclusiveMatchError(`Invalid semver: ${raw}`);
    return parseInt(part, 10);
}
function parseFeatureFlagSemver(value, parsingPolicy = 'strict') {
    const text = String(value).trim().replace(/^[vV]/, '');
    const baseVersion = text.split('-')[0].split('+')[0];
    if (!baseVersion || baseVersion.startsWith('.')) throw new InconclusiveMatchError(`Invalid semver: ${value}`);
    const parts = baseVersion.split('.');
    const parsePart = (part)=>{
        if (void 0 === part || '' === part) return 0;
        return parseSemverNumericIdentifier(part, value, parsingPolicy);
    };
    return [
        parsePart(parts[0]),
        parsePart(parts[1]),
        parsePart(parts[2])
    ];
}
function compareSemverTuples(a, b) {
    for(let i = 0; i < 3; i++){
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
    }
    return 0;
}
function computeTildeBounds(value, parsingPolicy) {
    const parsed = parseFeatureFlagSemver(value, parsingPolicy);
    return {
        lower: [
            parsed[0],
            parsed[1],
            parsed[2]
        ],
        upper: [
            parsed[0],
            parsed[1] + 1,
            0
        ]
    };
}
function computeCaretBounds(value, parsingPolicy) {
    const [major, minor, patch] = parseFeatureFlagSemver(value, parsingPolicy);
    const lower = [
        major,
        minor,
        patch
    ];
    let upper;
    upper = major > 0 ? [
        major + 1,
        0,
        0
    ] : minor > 0 ? [
        0,
        minor + 1,
        0
    ] : [
        0,
        0,
        patch + 1
    ];
    return {
        lower,
        upper
    };
}
function computeWildcardBounds(value, parsingPolicy) {
    const text = String(value).trim().replace(/^[vV]/, '');
    const cleanedText = text.replace(/\.\*$/, '').replace(/\*$/, '');
    if (!cleanedText) throw new InconclusiveMatchError(`Invalid wildcard semver: ${value}`);
    const parts = cleanedText.split('.');
    const parseWildcardPart = (part)=>{
        if ('legacy-permissive' === parsingPolicy) {
            const parsed = parseInt(part, 10);
            if (!isNaN(parsed)) return parsed;
        } else try {
            return parseSemverNumericIdentifier(part, value, parsingPolicy);
        } catch  {}
        throw new InconclusiveMatchError(`Invalid wildcard semver: ${value}`);
    };
    const major = parseWildcardPart(parts[0]);
    if (1 === parts.length) return {
        lower: [
            major,
            0,
            0
        ],
        upper: [
            major + 1,
            0,
            0
        ]
    };
    const minor = parseWildcardPart(parts[1]);
    return {
        lower: [
            major,
            minor,
            0
        ],
        upper: [
            major,
            minor + 1,
            0
        ]
    };
}
function convertToDateTime(value) {
    if (value instanceof Date) return value;
    if ('string' == typeof value || 'number' == typeof value) {
        const date = new Date(value);
        if (!isNaN(date.valueOf())) return date;
        throw new InconclusiveMatchError(`${value} is in an invalid date format`);
    }
    throw new InconclusiveMatchError(`The date provided ${value} must be a string, number, or date object`);
}
function relativeDateParseForFeatureFlagMatching(value) {
    const regex = /^-?(?<number>[0-9]+)(?<interval>[a-z])$/;
    const match = value.match(regex);
    const parsedDt = new Date(new Date().toISOString());
    if (!match || !match.groups) return null;
    const number = parseInt(match.groups['number']);
    if (number >= 10000) return null;
    const interval = match.groups['interval'];
    if ('h' === interval) parsedDt.setUTCHours(parsedDt.getUTCHours() - number);
    else if ('d' === interval) parsedDt.setUTCDate(parsedDt.getUTCDate() - number);
    else if ('w' === interval) parsedDt.setUTCDate(parsedDt.getUTCDate() - 7 * number);
    else if ('m' === interval) parsedDt.setUTCMonth(parsedDt.getUTCMonth() - number);
    else {
        if ('y' !== interval) return null;
        parsedDt.setUTCFullYear(parsedDt.getUTCFullYear() - number);
    }
    return parsedDt;
}
function matchFeatureFlagProperty(property, propertyValues, options = {}) {
    const key = property.key;
    const value = property.value;
    const operator = property.operator || 'exact';
    const parsingPolicy = options.semverParsingPolicy ?? 'strict';
    const hasProperty = Object.prototype.hasOwnProperty.call(propertyValues, key);
    if (hasProperty) {
        if ('is_not_set' === operator) return false;
        else if ('is_set' === operator) return true;
    } else throw new InconclusiveMatchError(`Property ${key} not found in propertyValues`);
    const overrideValue = propertyValues[key];
    if (void 0 === overrideValue) {
        options.warnFunction?.(`Property ${key} cannot have a value of undefined with the ${operator} operator`);
        return 'is_not' === operator;
    }
    if (null === overrideValue && !NULL_VALUES_ALLOWED_OPERATORS.includes(operator) && 'exact' !== operator && 'is_not' !== operator) {
        options.warnFunction?.(`Property ${key} cannot have a value of null with the ${operator} operator`);
        return false;
    }
    const computeExactMatch = (target, actual)=>{
        if (isTruthyOrFalsyPropertyValue(target)) {
            assertJsonRepresentable(actual);
            return isTruthyPropertyValue(target) === isTruthyPropertyValue(actual);
        }
        if (Array.isArray(target)) {
            const actualString = exactMatchString(actual).toLowerCase();
            return target.some((item)=>exactMatchString(item).toLowerCase() === actualString);
        }
        return exactMatchString(target).toLowerCase() === exactMatchString(actual).toLowerCase();
    };
    const compare = (lhs, rhs, comparisonOperator)=>{
        if ('gt' === comparisonOperator) return lhs > rhs;
        if ('gte' === comparisonOperator) return lhs >= rhs;
        if ('lt' === comparisonOperator) return lhs < rhs;
        if ('lte' === comparisonOperator) return lhs <= rhs;
        throw new Error(`Invalid operator: ${comparisonOperator}`);
    };
    switch(operator){
        case 'exact':
            return computeExactMatch(value, overrideValue);
        case 'is_not':
            return !computeExactMatch(value, overrideValue);
        case 'is_set':
            return true;
        case 'icontains':
            return asciiLowercase(overrideValue).includes(asciiLowercase(value));
        case 'not_icontains':
            return !asciiLowercase(overrideValue).includes(asciiLowercase(value));
        case 'starts_with':
            return asciiLowercase(overrideValue).startsWith(asciiLowercase(value));
        case 'not_starts_with':
            return !asciiLowercase(overrideValue).startsWith(asciiLowercase(value));
        case 'ends_with':
            return asciiLowercase(overrideValue).endsWith(asciiLowercase(value));
        case 'not_ends_with':
            return !asciiLowercase(overrideValue).endsWith(asciiLowercase(value));
        case 'regex':
            return isValidRegex(String(value)) && null !== String(overrideValue).match(String(value));
        case 'not_regex':
            return isValidRegex(String(value)) && null === String(overrideValue).match(String(value));
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte':
            {
                const parsedValue = 'number' == typeof value ? value : parseFloat(String(value));
                const parsedOverride = 'number' == typeof overrideValue ? overrideValue : null != overrideValue ? parseFloat(String(overrideValue)) : 0 / 0;
                if (Number.isFinite(parsedValue) && Number.isFinite(parsedOverride)) return compare(parsedOverride, parsedValue, operator);
                return compare(String(overrideValue), String(value), operator);
            }
        case 'is_date_after':
        case 'is_date_before':
            {
                if ('boolean' == typeof value) throw new InconclusiveMatchError('Date operations cannot be performed on boolean values');
                let parsedDate = relativeDateParseForFeatureFlagMatching(String(value));
                if (null == parsedDate) parsedDate = convertToDateTime(value);
                const overrideDate = convertToDateTime(overrideValue);
                return 'is_date_before' === operator ? overrideDate < parsedDate : overrideDate > parsedDate;
            }
        case 'semver_eq':
            return 0 === compareSemverTuples(parseFeatureFlagSemver(String(overrideValue), parsingPolicy), parseFeatureFlagSemver(String(value), parsingPolicy));
        case 'semver_neq':
            return 0 !== compareSemverTuples(parseFeatureFlagSemver(String(overrideValue), parsingPolicy), parseFeatureFlagSemver(String(value), parsingPolicy));
        case 'semver_gt':
            return compareSemverTuples(parseFeatureFlagSemver(String(overrideValue), parsingPolicy), parseFeatureFlagSemver(String(value), parsingPolicy)) > 0;
        case 'semver_gte':
            return compareSemverTuples(parseFeatureFlagSemver(String(overrideValue), parsingPolicy), parseFeatureFlagSemver(String(value), parsingPolicy)) >= 0;
        case 'semver_lt':
            return compareSemverTuples(parseFeatureFlagSemver(String(overrideValue), parsingPolicy), parseFeatureFlagSemver(String(value), parsingPolicy)) < 0;
        case 'semver_lte':
            return compareSemverTuples(parseFeatureFlagSemver(String(overrideValue), parsingPolicy), parseFeatureFlagSemver(String(value), parsingPolicy)) <= 0;
        case 'semver_tilde':
            {
                const overrideParsed = parseFeatureFlagSemver(String(overrideValue), parsingPolicy);
                const { lower, upper } = computeTildeBounds(String(value), parsingPolicy);
                return compareSemverTuples(overrideParsed, lower) >= 0 && compareSemverTuples(overrideParsed, upper) < 0;
            }
        case 'semver_caret':
            {
                const overrideParsed = parseFeatureFlagSemver(String(overrideValue), parsingPolicy);
                const { lower, upper } = computeCaretBounds(String(value), parsingPolicy);
                return compareSemverTuples(overrideParsed, lower) >= 0 && compareSemverTuples(overrideParsed, upper) < 0;
            }
        case 'semver_wildcard':
            {
                const overrideParsed = parseFeatureFlagSemver(String(overrideValue), parsingPolicy);
                const { lower, upper } = computeWildcardBounds(String(value), parsingPolicy);
                return compareSemverTuples(overrideParsed, lower) >= 0 && compareSemverTuples(overrideParsed, upper) < 0;
            }
        default:
            throw new InconclusiveMatchError(`Unknown operator: ${operator}`);
    }
}
async function hashSHA1(text) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error('SubtleCrypto API not available');
    const hashBuffer = await subtle.digest('SHA-1', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hashBuffer)).map((byte)=>byte.toString(16).padStart(2, '0')).join('');
}
async function getFeatureFlagHash(key, bucketingValue, salt = '') {
    const hashString = await hashSHA1(`${key}.${bucketingValue}${salt}`);
    return parseInt(hashString.slice(0, 15), 16) / LONG_SCALE;
}
function getFeatureFlagVariantLookupTable(variants) {
    const table = [];
    let valueMin = 0;
    for (const variant of variants){
        const valueMax = valueMin + variant.rollout_percentage / 100.0;
        table.push({
            valueMin,
            valueMax,
            key: variant.key
        });
        valueMin = valueMax;
    }
    return table;
}
async function getFeatureFlagVariant(key, bucketingValue, variants) {
    const hashValue = await getFeatureFlagHash(key, bucketingValue, 'variant');
    return getFeatureFlagVariantLookupTable(variants).find((variant)=>hashValue >= variant.valueMin && hashValue < variant.valueMax)?.key;
}
function resolveFeatureFlagPayload(payloads, flagValue) {
    if (false === flagValue || null == flagValue || !payloads) return null;
    const payloadKey = 'boolean' == typeof flagValue ? flagValue.toString() : flagValue;
    const payload = payloads[payloadKey] || null;
    return null == payload ? null : (0, external_featureFlagUtils_js_namespaceObject.parsePayload)(payload);
}
exports.InconclusiveMatchError = __webpack_exports__.InconclusiveMatchError;
exports.getFeatureFlagHash = __webpack_exports__.getFeatureFlagHash;
exports.getFeatureFlagVariant = __webpack_exports__.getFeatureFlagVariant;
exports.getFeatureFlagVariantLookupTable = __webpack_exports__.getFeatureFlagVariantLookupTable;
exports.hashSHA1 = __webpack_exports__.hashSHA1;
exports.matchFeatureFlagProperty = __webpack_exports__.matchFeatureFlagProperty;
exports.parseFeatureFlagSemver = __webpack_exports__.parseFeatureFlagSemver;
exports.relativeDateParseForFeatureFlagMatching = __webpack_exports__.relativeDateParseForFeatureFlagMatching;
exports.resolveFeatureFlagPayload = __webpack_exports__.resolveFeatureFlagPayload;
for(var __rspack_i in __webpack_exports__)if (-1 === [
    "InconclusiveMatchError",
    "getFeatureFlagHash",
    "getFeatureFlagVariant",
    "getFeatureFlagVariantLookupTable",
    "hashSHA1",
    "matchFeatureFlagProperty",
    "parseFeatureFlagSemver",
    "relativeDateParseForFeatureFlagMatching",
    "resolveFeatureFlagPayload"
].indexOf(__rspack_i)) exports[__rspack_i] = __webpack_exports__[__rspack_i];
Object.defineProperty(exports, '__esModule', {
    value: true
});
