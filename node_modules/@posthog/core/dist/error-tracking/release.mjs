function getInjectedReleaseId() {
    const injected = globalThis._posthogReleaseId;
    return 'string' == typeof injected && injected.length > 0 ? injected : void 0;
}
export { getInjectedReleaseId };
