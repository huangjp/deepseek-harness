/**
 * Compiled helpers a first-party route uses to build one pi-ai profile.
 *
 * Sibling plugins import this subpath. The desktop package runs under plain
 * Node, which refuses to strip TypeScript inside `node_modules`, so a bundled
 * `lib/*.js` import of `src/auth.ts` or `src/config.ts` fails before that
 * plugin can register its Models-page row.
 *
 * These names stay off the package root: that entry is the plugin the Loader
 * evaluates, and the root keeps adapter construction helpers unexported.
 *
 * @module @deepseek-ai/dsh-llm-pi-ai/route-support
 */
export { authContextFrom, credentialStoreFrom } from './auth.ts'
export { resolveProfiles } from './config.ts'
