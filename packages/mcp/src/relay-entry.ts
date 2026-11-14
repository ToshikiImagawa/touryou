/**
 * daemon の窓口への中継（relay）と身元確認（identity）だけの入口（`@touryou/mcp/relay`）。cli がこれを使う。
 * MCP SDK・zod を読み込まない（このファイルと、その import 先は、relay.ts・identity.ts・@touryou/core だけ）。
 */
export * from "./identity.js";
export * from "./relay.js";
