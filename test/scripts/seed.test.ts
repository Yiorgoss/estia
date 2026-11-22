import { LISTING_PHOTO_MAX_PER_LISTING } from "@/db/schema/ListingPhoto";
import { GreekRegionCodes } from "@/db/schema/Listing";
import {
  ALL_PHOTO_SHAPES,
  DEFAULT_BASE_URL,
  LISTING_PHOTO_MAX_BYTES,
  PHOTO_SHAPES,
  SEED_LISTINGS,
  SEED_PASSWORD,
  SEED_USERS,
  SeedSafetyError,
  TEST_BASE_URL,
  TEST_HOSTNAME,
  assertSeedTarget,
  formatCredentialsTable,
  resolveSeedTarget,
} from "../../scripts/seed";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/*
 * The seed script is a CLI, but two parts of it must be provable without a
 * server: the production guard that decides whether it may run at all, and the
 * logins table it prints and repeats in `docs/seed.md`. The rest of this file
 * pins the seed plan to the app's own limits, so a change to the gallery or the
 * region list breaks here instead of at seed time.
 */

const docsPath = resolve(import.meta.dirname, "../../docs/seed.md");
const docs = readFileSync(docsPath, "utf8");

/*
 * The guard is an Effect, so a refusal is proved by running it and asking for
 * the typed failure. A success where a refusal was expected fails the test
 * loudly rather than silently passing.
 */
const refuse = (input: Parameters<typeof resolveSeedTarget>[0]): SeedSafetyError => {
  const result = Effect.runSync(Effect.result(resolveSeedTarget(input)));
  if (result._tag !== "Failure") return assert.fail("expected the seed guard to refuse");
  assert.instanceOf(result.failure, SeedSafetyError);
  return result.failure;
};

const accept = (input: Parameters<typeof assertSeedTarget>[0]): URL =>
  Effect.runSync(assertSeedTarget(input));


describe("the seed target guard", () => {
  it("accepts the default local target", () => {
    const url = accept({});
    assert.strictEqual(url.href, `${DEFAULT_BASE_URL}/`);
  });

  it("accepts every loopback name on a dev port", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const url = accept({ baseUrl: `http://${host}:5173` });
      assert.strictEqual(url.hostname, host);
    }
  });

  it("accepts the test host over HTTPS and nothing else on it", () => {
    const url = accept({ baseUrl: TEST_BASE_URL });
    assert.strictEqual(url.hostname, TEST_HOSTNAME);
    assert.strictEqual(url.protocol, "https:");
    assert.match(
      refuse({ baseUrl: `http://${TEST_HOSTNAME}` }).message,
      /test environment is only reachable over HTTPS/,
    );
    assert.match(refuse({ baseUrl: `https://${TEST_HOSTNAME}:8443` }).message, /is neither/);
  });

  it("refuses a production environment", () => {
    const error = refuse({ environment: "production" });
    assert.match(error.message, /ENVIRONMENT=production/);
  });

  it("refuses the wrangler prod environment and a production NODE_ENV", () => {
    assert.match(refuse({ environment: "prod" }).message, /ENVIRONMENT=prod/);
    assert.match(refuse({ nodeEnv: "production" }).message, /NODE_ENV=production/);
    assert.match(refuse({ nodeEnv: "staging" }).message, /NODE_ENV=staging/);
  });

  it("refuses a remote or production flag", () => {
    assert.match(refuse({ argv: ["--remote"] }).message, /--remote/);
    assert.match(refuse({ argv: ["--prod"] }).message, /--prod/);
    assert.match(refuse({ argv: ["--production"] }).message, /--production/);
  });

  it("refuses an address that is not loopback or the test host", () => {
    assert.match(
      refuse({ baseUrl: "https://estia.example.com" }).message,
      /estia\.example\.com is neither a local loopback address nor the test environment/,
    );
    // Lookalike names and a non-HTTP scheme are refused too.
    assert.match(refuse({ baseUrl: "http://127.0.0.1.evil.example" }).message, /is neither/);
    assert.match(
      refuse({ baseUrl: `https://${TEST_HOSTNAME}.evil.example` }).message,
      /is neither/,
    );
    assert.match(refuse({ baseUrl: "ftp://127.0.0.1" }).message, /ftp: is not an HTTP address/);
    assert.match(refuse({ baseUrl: "not a url" }).message, /is not a URL/);
  });

  it("refuses before any request, so a refusal means no writes", () => {
    assert.match(
      refuse({ environment: "production", baseUrl: "http://127.0.0.1" }).message,
      /ENVIRONMENT=production/,
    );
  });
});

describe("the seed target selection", () => {
  it("seeds the local default when no environment is named", () => {
    assert.strictEqual(Effect.runSync(resolveSeedTarget({})).href, `${DEFAULT_BASE_URL}/`);
    assert.strictEqual(
      Effect.runSync(resolveSeedTarget({ baseUrl: "http://127.0.0.1:8801" })).href,
      "http://127.0.0.1:8801/",
    );
  });

  it("moves to the test host for --env test, --env=test, or --test", () => {
    for (const argv of [["--env", "test"], ["--env=test"], ["--test"]]) {
      const url = Effect.runSync(resolveSeedTarget({ argv, baseUrl: "http://127.0.0.1:8801" }));
      assert.strictEqual(url.href, `${TEST_BASE_URL}/`);
    }
    assert.strictEqual(TEST_BASE_URL, `https://${TEST_HOSTNAME}`);
  });

  it("refuses any other --env name, including an empty one", () => {
    assert.match(refuse({ argv: ["--env", "production"] }).message, /--env production/);
    assert.match(refuse({ argv: ["--env", "prod"] }).message, /--env prod/);
    assert.match(refuse({ argv: ["--env"] }).message, /--env \(no value\)/);
    assert.match(refuse({ argv: ["--env=staging"] }).message, /--env staging/);
  });

  it("keeps the environment refusal in front of the test host too", () => {
    assert.match(
      refuse({ argv: ["--env", "test"], environment: "production" }).message,
      /ENVIRONMENT=production/,
    );
    assert.match(refuse({ argv: ["--test"], nodeEnv: "production" }).message, /NODE_ENV=production/);
  });
});

describe("the seeded logins table", () => {
  it("lists every account with a password and a role", () => {
    const table = formatCredentialsTable(SEED_USERS);
    for (const user of SEED_USERS) {
      assert.include(table, user.email);
      assert.include(table, user.password);
    }
    assert.match(table.split("\n")[0] ?? "", /^EMAIL\s+PASSWORD\s+ROLE$/);
  });

  it("pads the email and password columns to the widest cell", () => {
    const widths = {
      email: Math.max(...SEED_USERS.map((user) => user.email.length), "EMAIL".length),
      password: Math.max(...SEED_USERS.map((user) => user.password.length), "PASSWORD".length),
    };
    const rows = formatCredentialsTable(SEED_USERS).split("\n").slice(2);
    assert.strictEqual(rows.length, SEED_USERS.length);
    for (const [index, user] of SEED_USERS.entries()) {
      assert.strictEqual(
        rows[index],
        `${user.email.padEnd(widths.email)}  ${user.password.padEnd(widths.password)}  ${user.role}`,
      );
    }
  });

  it("is repeated in docs/seed.md, so the credentials are always findable", () => {
    assert.include(docs, formatCredentialsTable(SEED_USERS));
    assert.include(docs, "pnpm seed");
  });

  it("documents the test environment the guard allows", () => {
    assert.include(docs, "pnpm seed:test");
    assert.include(docs, TEST_HOSTNAME);
    assert.include(docs, "pnpm migrate:test");
  });
});

describe("the seed plan", () => {
  it("gives every account only the profiles its role has", () => {
    for (const user of SEED_USERS) {
      assert.strictEqual(user.password, SEED_PASSWORD);
      assert.notStrictEqual(user.password, "");
      if (user.role === "seeker" || user.role === "both") {
        assert.isDefined(user.seeker, `${user.email} needs a seeking profile`);
      }
      if (user.role === "lister" || user.role === "both") {
        assert.isDefined(user.lister, `${user.email} needs a listing profile`);
      }
    }
  });

  it("covers listers, seekers, and one account that does both", () => {
    const roles = SEED_USERS.map((user) => user.role);
    assert.include(roles, "lister");
    assert.include(roles, "seeker");
    assert.include(roles, "both");
  });

  it("places every listing in a known region inside Greece", () => {
    for (const listing of SEED_LISTINGS) {
      assert.include(GreekRegionCodes, listing.regionCode);
      assert.isAtLeast(listing.lat, 34.0);
      assert.isAtMost(listing.lat, 42.5);
      assert.isAtLeast(listing.lng, 19.0);
      assert.isAtMost(listing.lng, 30.5);
      assert.isAbove(listing.priceMinor, 0);
    }
  });

  it("gives every listing an owner, a unique title, and a gallery inside the cap", () => {
    const emails = new Set(SEED_USERS.map((user) => user.email));
    const titles = new Set<string>();
    for (const listing of SEED_LISTINGS) {
      assert.isTrue(emails.has(listing.owner), `${listing.title} has an unknown owner`);
      assert.isFalse(titles.has(listing.title), `${listing.title} is seeded twice`);
      titles.add(listing.title);
      assert.isAtLeast(listing.photos.length, 1);
      assert.isAtMost(listing.photos.length, LISTING_PHOTO_MAX_PER_LISTING);
      for (const shape of listing.photos) {
        assert.include(ALL_PHOTO_SHAPES, shape);
      }
    }
  });

  it("covers every photo shape the layout has to survive", () => {
    const seeded = new Set(SEED_LISTINGS.flatMap((listing) => listing.photos));
    for (const shape of ALL_PHOTO_SHAPES) {
      assert.isTrue(seeded.has(shape), `no seeded listing uses the ${shape} shape`);
      assert.isDefined(PHOTO_SHAPES[shape]);
    }
    assert.isAbove(LISTING_PHOTO_MAX_BYTES, 0);
  });
});
