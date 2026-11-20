/*
 * Minimal `cloudflare:workers` shim for Node/Vitest unit and integration tests.
 * Production and local `vite dev` / `wrangler` runs resolve the real Cloudflare
 * built-in module; Vitest aliases `cloudflare:workers` here so `Chat` from
 * `src/durable-objects/chat.ts` executes directly under Vitest.
 */
export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
