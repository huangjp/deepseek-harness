/**
 * Local-model-relay settings page, node half. The empty apply exists so the
 * plugin appears in the host cordis.yml / Loader; the browser half owns the
 * page through exports["./client"], discovered from the package.json
 * dsh.client declaration. The relay it configures is served by
 * `@deepseek-ai/dsh-host-local-bridge`, whose routes this package reads.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
