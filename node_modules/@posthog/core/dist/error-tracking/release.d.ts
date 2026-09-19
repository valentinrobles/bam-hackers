/**
 * Read the release id injected into the bundle by posthog-cli.
 *
 * The CLI prepends a small IIFE to each chunk that sets `globalThis._posthogReleaseId` to the
 * release row's id (a string, first write wins so the first loaded chunk pins the release for the
 * runtime). The SDK emits it on `$exception` events so the server resolves the release with a plain
 * foreign-key lookup. Returns `undefined` when nothing was injected or the value is malformed.
 */
export declare function getInjectedReleaseId(): string | undefined;
//# sourceMappingURL=release.d.ts.map