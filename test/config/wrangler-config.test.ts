import { ENVIRONMENTS } from "@/app";
import { assert, describe, it } from "@effect/vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/*
 * The deployable configuration is part of the contract: a wrong `ENVIRONMENT`
 * literal or a missing public variable fails the whole service graph at the
 * first request, and the live symptom is a 500 on every path. These tests hold
 * `wrangler.jsonc` to the values `src/app.ts` reads.
 */

const WRANGLER_CONFIG_PATH = path.resolve(import.meta.dirname, "../../wrangler.jsonc");

/*
 * Keys the app reads that are public, so they belong in `vars` rather than in a
 * Cloudflare secret. `JWT_SECRET` is deliberately absent: it is a secret, set
 * with `wrangler secret put JWT_SECRET --env <name>`. `prod` has no domain or
 * route in this file yet; list `DOMAIN` for it here when it gets one.
 */
const REQUIRED_PUBLIC_VARS: Readonly<Record<string, ReadonlyArray<string>>> = {
  test: ["DOMAIN"],
};

interface WranglerEnvironment {
  readonly vars?: Readonly<Record<string, unknown>>;
}

interface WranglerConfig {
  readonly vars?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, WranglerEnvironment>>;
}

/*
 * `wrangler.jsonc` allows comments and trailing commas, which `JSON.parse`
 * rejects. This strips both only outside strings, so a `//` or `,` inside a
 * value such as a URL survives unchanged.
 */
const stripJsonc = (text: string): string => {
  let withoutComments = "";
  let index = 0;
  let inString = false;

  while (index < text.length) {
    const char = text[index] ?? "";
    if (inString) {
      withoutComments += char;
      if (char === "\\") {
        withoutComments += text[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutComments += char;
      index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    withoutComments += char;
    index += 1;
  }

  let withoutTrailingCommas = "";
  index = 0;
  inString = false;
  while (index < withoutComments.length) {
    const char = withoutComments[index] ?? "";
    if (inString) {
      withoutTrailingCommas += char;
      if (char === "\\") {
        withoutTrailingCommas += withoutComments[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      withoutTrailingCommas += char;
      index += 1;
      continue;
    }
    if (char === ",") {
      let next = index + 1;
      while (next < withoutComments.length && /\s/.test(withoutComments[next] ?? "")) next += 1;
      const following = withoutComments[next];
      if (following === "}" || following === "]") {
        index += 1;
        continue;
      }
    }
    withoutTrailingCommas += char;
    index += 1;
  }

  return withoutTrailingCommas;
};

const readWranglerConfig = (): WranglerConfig =>
  JSON.parse(stripJsonc(readFileSync(WRANGLER_CONFIG_PATH, "utf8"))) as WranglerConfig;

const environmentsOf = (config: WranglerConfig): ReadonlyArray<[string, WranglerEnvironment]> =>
  Object.entries(config.env ?? {});

const varsOf = (environment: WranglerEnvironment): Readonly<Record<string, unknown>> =>
  environment.vars ?? {};

const validEnvironments: ReadonlyArray<unknown> = ENVIRONMENTS;

describe("wrangler.jsonc", () => {
  const config = readWranglerConfig();

  it("defines the test and prod environments", () => {
    const names = environmentsOf(config).map(([name]) => name);
    assert.include(names, "test");
    assert.include(names, "prod");
  });

  it("gives every environment an ENVIRONMENT the app accepts", () => {
    for (const [name, environment] of environmentsOf(config)) {
      const environmentName = varsOf(environment)["ENVIRONMENT"];
      assert.include(
        validEnvironments,
        environmentName,
        `env.${name}.vars.ENVIRONMENT must be one of ${ENVIRONMENTS.join(", ")}`,
      );
    }
  });

  it("includes every required public variable for its environment", () => {
    for (const [name] of environmentsOf(config)) {
      const environment = config.env?.[name];
      const vars = environment === undefined ? {} : varsOf(environment);
      for (const key of REQUIRED_PUBLIC_VARS[name] ?? []) {
        assert.isString(vars[key], `env.${name}.vars.${key} must be a public variable`);
      }
    }
  });

  it("names the deployed test host as the test environment's DOMAIN", () => {
    const vars = config.env?.["test"] === undefined ? {} : varsOf(config.env["test"]);
    assert.strictEqual(vars["DOMAIN"], "https://estia.calisto.studio");
  });

  it("keeps JWT_SECRET out of vars, so it can only be a Cloudflare secret", () => {
    assert.notProperty(config.vars ?? {}, "JWT_SECRET");
    for (const [name, environment] of environmentsOf(config)) {
      assert.notProperty(
        varsOf(environment),
        "JWT_SECRET",
        `env.${name}.vars must not carry JWT_SECRET; set it with \`wrangler secret put JWT_SECRET --env ${name}\``,
      );
    }
  });
});
