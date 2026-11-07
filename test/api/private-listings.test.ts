import { AppServicesLive, PrivateRouterLive, PublicRouterLive } from "@/api";
import { StorageRepository } from "@/repos/storage.repo";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect";
import { Etag, HttpPlatform, HttpRouter } from "effect/http";
import { TestSqlLive } from "../support/sql";

/*
 * These tests drive the real private router - `AuthMiddleware`, the listing
 * handlers, `ListingService`, and the repository - over the in-memory D1-shaped
 * database from `test/support/sql.ts`. The only thing they fake is the network:
 * a `Request` goes in and a `Response` comes out. Users are registered through
 * the public auth endpoint, so the cookies these tests present are the same
 * signed access tokens the app issues.
 */

/*
 * workerd, where the app actually runs, implements `Uint8Array.prototype.toHex`,
 * which the refresh-token service uses to mint a token. Node 22, where these
 * tests run, does not, so registering a user would fail here for a reason that
 * exists only in the test runtime. Supplying the primitive keeps the tests on
 * the same code path the deployed runtime takes.
 */
const uint8ArrayPrototype = Uint8Array.prototype as unknown as { toHex?: () => string };
uint8ArrayPrototype.toHex ??= function (this: Uint8Array) {
  return Array.from(this, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const DOMAIN = "http://listings.test";
const JWT_SECRET = "listings-test-secret-listings-test-secret";

// The multipart upload endpoint on the public router is the only consumer of R2;
// these tests never touch it, but the router's request services still name it.
const StorageRepositoryStub = Layer.succeed(StorageRepository, {
  put: () => Effect.die("storage is not used by the listing tests"),
  newMultipart: () => Effect.die("storage is not used by the listing tests"),
});

const ConfigLive = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ DOMAIN, JWT_SECRET, ENVIRONMENT: "local" }),
);

const AppLayer = Layer.mergeAll(PublicRouterLive, PrivateRouterLive).pipe(
  Layer.provide(Etag.layer),
  Layer.provide(HttpPlatform.layer),
  Layer.provide(Path.layer),
  Layer.provide(FileSystem.layerNoop({})),
  Layer.provide(AppServicesLive),
  Layer.provide(StorageRepositoryStub),
  HttpRouter.provideRequest(AppServicesLive),
  HttpRouter.provideRequest(StorageRepositoryStub),
  Layer.provide(TestSqlLive),
  Layer.provide(ConfigLive),
);

const app = HttpRouter.toWebHandler(AppLayer, { disableLogger: true });

interface TestResponse {
  readonly status: number;
  readonly body: string;
  readonly json: unknown;
  readonly cookies: Readonly<Record<string, string>>;
}

const call = (path: string, init?: RequestInit): Effect.Effect<TestResponse> =>
  Effect.promise(async () => {
    const response = await app.handler(new Request(`http://localhost${path}`, init));
    const body = await response.text();
    const cookies: Record<string, string> = {};
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      const index = pair.indexOf("=");
      cookies[pair.slice(0, index)] = pair.slice(index + 1);
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
    return { status: response.status, body, json, cookies };
  });

interface TestUser {
  readonly id: string;
  readonly cookie: string;
}

// A browser always sends a user agent, and the refresh-token record stores it,
// so the requests here carry one too.
const json = (init: RequestInit, payload?: unknown): RequestInit => ({
  ...init,
  headers: { "content-type": "application/json", "user-agent": "estia-tests", ...init.headers },
  ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
});

const send = (
  method: string,
  path: string,
  options: { readonly cookie?: string; readonly payload?: unknown } = {},
) =>
  call(
    path,
    json(
      {
        method,
        ...(options.cookie === undefined ? {} : { headers: { cookie: options.cookie } }),
      },
      options.payload,
    ),
  );

const register = (label: string): Effect.Effect<TestUser> =>
  Effect.gen(function* () {
    const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
    const response = yield* send("POST", "/api/auth/register", {
      payload: { email, password: "correct horse battery staple" },
    });
    assert.strictEqual(response.status, 200, `register ${label}: ${response.body}`);
    const accessToken = response.cookies["access_token"];
    assert.isString(accessToken);
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString());
    return { id: String(claims.id), cookie: `access_token=${accessToken}` };
  });

// Registered once per file; every test then creates the listings it needs.
const users = await Effect.runPromise(
  Effect.gen(function* () {
    const owner = yield* register("owner");
    const other = yield* register("other");
    return { owner, other };
  }),
);

const asListing = (value: unknown): Record<string, unknown> => {
  assert.isObject(value);
  return value as Record<string, unknown>;
};

let priceCounter = 0;
const uniquePriceMinor = () => 100_000 + (priceCounter += 1) * 111;

const listingPayload = (overrides: Record<string, unknown> = {}) => ({
  kind: "room",
  title: "Sunny room near the port",
  description: "A quiet room with a balcony",
  priceMinor: uniquePriceMinor(),
  regionCode: "attica",
  sizeSqm: 30,
  furnished: 1,
  ensuite: 0,
  smoking: 0,
  pets: 1,
  ...overrides,
});

const createDraft = (user: TestUser, overrides: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const response = yield* send("POST", "/api/listings", {
      cookie: user.cookie,
      payload: listingPayload(overrides),
    });
    assert.strictEqual(response.status, 200, `create draft: ${response.body}`);
    return asListing(response.json);
  });

describe("POST /api/listings", () => {
  it.effect("creates a draft owned by the caller and never a published listing", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner, {
        title: "  Trimmed title  ",
        lat: 37.98,
        lng: 23.72,
      });

      assert.strictEqual(listing.status, "draft");
      assert.strictEqual(listing.ownerId, users.owner.id);
      assert.strictEqual(listing.title, "Trimmed title");
      assert.strictEqual(listing.kind, "room");
      assert.strictEqual(listing.regionCode, "attica");
      assert.strictEqual(listing.lat, 37.98);
      assert.strictEqual(listing.lng, 23.72);
      // The row schema's flags are bits, so they travel as 0/1 on both sides.
      assert.strictEqual(listing.furnished, 1);
      assert.strictEqual(listing.ensuite, 0);
      assert.isNull(listing.publishedAt);
    }),
  );

  it.effect("rejects an unauthenticated create with a 401", () =>
    Effect.gen(function* () {
      const response = yield* send("POST", "/api/listings", {
        payload: listingPayload(),
      });
      assert.strictEqual(response.status, 401);
    }),
  );

  it.effect("rejects a blank, oversized, or negatively priced listing with a 400", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<Record<string, unknown>> = [
        { title: "   " },
        { title: "x".repeat(121) },
        { priceMinor: -1 },
      ];
      for (const overrides of cases) {
        const response = yield* send("POST", "/api/listings", {
          cookie: users.owner.cookie,
          payload: listingPayload(overrides),
        });
        assert.strictEqual(response.status, 400, JSON.stringify(overrides));
      }
    }),
  );

  it.effect("rejects coordinates outside the Greek box with a 422", () =>
    Effect.gen(function* () {
      const valencia = yield* send("POST", "/api/listings", {
        cookie: users.owner.cookie,
        payload: listingPayload({ lat: 39.47, lng: -0.38 }),
      });
      assert.strictEqual(valencia.status, 422);

      // Half a pair is a bad request, not a location problem.
      const halfPair = yield* send("POST", "/api/listings", {
        cookie: users.owner.cookie,
        payload: listingPayload({ lat: 37.98 }),
      });
      assert.strictEqual(halfPair.status, 400);
    }),
  );
});

describe("PATCH /api/listings/:id", () => {
  it.effect("updates the owner's listing and only the fields it was sent", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner);
      const id = listing.id;

      const response = yield* send("PATCH", `/api/listings/${id}`, {
        cookie: users.owner.cookie,
        payload: { title: "Renamed room", priceMinor: 62_000 },
      });
      assert.strictEqual(response.status, 200, response.body);
      const updated = asListing(response.json);
      assert.strictEqual(updated.title, "Renamed room");
      assert.strictEqual(updated.priceMinor, 62_000);
      // Untouched fields keep their stored values.
      assert.strictEqual(updated.regionCode, listing.regionCode);
      assert.strictEqual(updated.sizeSqm, listing.sizeSqm);
      assert.strictEqual(updated.status, "draft");
    }),
  );

  it.effect("answers 403 for another owner's listing and 404 for a missing one", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner);

      const foreign = yield* send("PATCH", `/api/listings/${listing.id}`, {
        cookie: users.other.cookie,
        payload: { title: "Hijacked" },
      });
      assert.strictEqual(foreign.status, 403);

      const missing = yield* send("PATCH", "/api/listings/999999", {
        cookie: users.owner.cookie,
        payload: { title: "Nowhere" },
      });
      assert.strictEqual(missing.status, 404);
    }),
  );

  it.effect("rejects invalid input and out-of-Greece coordinates", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner);

      for (const payload of [{ title: "" }, { title: "x".repeat(121) }, { priceMinor: -1 }]) {
        const response = yield* send("PATCH", `/api/listings/${listing.id}`, {
          cookie: users.owner.cookie,
          payload,
        });
        assert.strictEqual(response.status, 400, JSON.stringify(payload));
      }

      const outside = yield* send("PATCH", `/api/listings/${listing.id}`, {
        cookie: users.owner.cookie,
        payload: { lat: 35.9, lng: 14.51 },
      });
      assert.strictEqual(outside.status, 422);
    }),
  );

  it.effect("rejects an unauthenticated update with a 401", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner);
      const response = yield* send("PATCH", `/api/listings/${listing.id}`, {
        payload: { title: "Anonymous" },
      });
      assert.strictEqual(response.status, 401);
    }),
  );
});

describe("POST /api/listings/:id/publish and /unlist", () => {
  it.effect("publishes a draft, unlists it, and relists it", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner);
      const id = listing.id;

      const published = yield* send("POST", `/api/listings/${id}/publish`, {
        cookie: users.owner.cookie,
      });
      assert.strictEqual(published.status, 200, published.body);
      const publishedBody = asListing(published.json);
      assert.strictEqual(publishedBody.status, "published");
      assert.isNumber(publishedBody.publishedAt);

      const unlisted = yield* send("POST", `/api/listings/${id}/unlist`, {
        cookie: users.owner.cookie,
      });
      assert.strictEqual(unlisted.status, 200, unlisted.body);
      assert.strictEqual(asListing(unlisted.json).status, "unpublished");

      // Unlisting is reversible and keeps the listing.
      const relisted = yield* send("POST", `/api/listings/${id}/publish`, {
        cookie: users.owner.cookie,
      });
      assert.strictEqual(relisted.status, 200, relisted.body);
      assert.strictEqual(asListing(relisted.json).status, "published");
    }),
  );

  it.effect("answers 409 for an illegal transition", () =>
    Effect.gen(function* () {
      const draft = yield* createDraft(users.owner);
      const unlistingDraft = yield* send("POST", `/api/listings/${draft.id}/unlist`, {
        cookie: users.owner.cookie,
      });
      assert.strictEqual(unlistingDraft.status, 409);

      const published = yield* send("POST", `/api/listings/${draft.id}/publish`, {
        cookie: users.owner.cookie,
      });
      assert.strictEqual(published.status, 200);

      const republishing = yield* send("POST", `/api/listings/${draft.id}/publish`, {
        cookie: users.owner.cookie,
      });
      assert.strictEqual(republishing.status, 409);
    }),
  );

  it.effect("answers 403 for another owner and 404 for a missing listing", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner);

      const foreignPublish = yield* send("POST", `/api/listings/${listing.id}/publish`, {
        cookie: users.other.cookie,
      });
      assert.strictEqual(foreignPublish.status, 403);

      const missingUnlist = yield* send("POST", "/api/listings/999999/unlist", {
        cookie: users.owner.cookie,
      });
      assert.strictEqual(missingUnlist.status, 404);
    }),
  );

  it.effect("rejects unauthenticated transitions with a 401", () =>
    Effect.gen(function* () {
      const listing = yield* createDraft(users.owner);
      for (const action of ["publish", "unlist"]) {
        const response = yield* send("POST", `/api/listings/${listing.id}/${action}`);
        assert.strictEqual(response.status, 401, action);
      }
    }),
  );
});

interface MyListingsPage {
  readonly items: ReadonlyArray<Record<string, unknown>>;
  readonly nextCursor: string | null;
}

const myListingsPageOf = (value: unknown): MyListingsPage => {
  assert.isObject(value);
  const body = value as Record<string, unknown>;
  assert.isArray(body.items);
  return {
    items: body.items as ReadonlyArray<Record<string, unknown>>,
    nextCursor: (body.nextCursor ?? null) as string | null,
  };
};

const idsOf = (page: MyListingsPage) => page.items.map((item) => item.id);

describe("GET /api/listings/mine", () => {
  const mine = (user: TestUser | undefined, query = "") =>
    send("GET", `/api/listings/mine${query}`, user === undefined ? {} : { cookie: user.cookie });

  it.effect("returns every status of the caller's own listings and nobody else's", () =>
    Effect.gen(function* () {
      const owner = yield* register("mine-owner");
      const other = yield* register("mine-other");

      const draft = yield* createDraft(owner, { title: "A draft only its owner sees" });

      const published = yield* createDraft(owner, { title: "A published listing" });
      const publishedResponse = yield* send("POST", `/api/listings/${published.id}/publish`, {
        cookie: owner.cookie,
      });
      assert.strictEqual(publishedResponse.status, 200, publishedResponse.body);

      const unlisted = yield* createDraft(owner, { title: "An unlisted listing" });
      yield* send("POST", `/api/listings/${unlisted.id}/publish`, { cookie: owner.cookie });
      const unlistedResponse = yield* send("POST", `/api/listings/${unlisted.id}/unlist`, {
        cookie: owner.cookie,
      });
      assert.strictEqual(unlistedResponse.status, 200, unlistedResponse.body);

      const foreign = yield* createDraft(other, { title: "Another account's draft" });

      const response = yield* mine(owner);
      assert.strictEqual(response.status, 200, response.body);
      const page = myListingsPageOf(response.json);

      // Newest first, and a draft and an unlisted row are both visible to their
      // owner even though public search hides them.
      assert.deepStrictEqual(idsOf(page), [unlisted.id, published.id, draft.id]);
      assert.deepStrictEqual(
        page.items.map((item) => item.status),
        ["unpublished", "published", "draft"],
      );
      assert.isTrue(page.items.every((item) => item.ownerId === owner.id));
      assert.notInclude(idsOf(page), foreign.id);
      assert.isNull(page.nextCursor);
    }),
  );

  it.effect("pages newest first with an opaque cursor", () =>
    Effect.gen(function* () {
      const user = yield* register("mine-paging");
      const firstCreated = yield* createDraft(user, { title: "First created" });
      const secondCreated = yield* createDraft(user, { title: "Second created" });
      const thirdCreated = yield* createDraft(user, { title: "Third created" });

      const pageOne = yield* mine(user, "?limit=2");
      assert.strictEqual(pageOne.status, 200, pageOne.body);
      const firstPage = myListingsPageOf(pageOne.json);
      assert.deepStrictEqual(idsOf(firstPage), [thirdCreated.id, secondCreated.id]);

      const cursor = firstPage.nextCursor;
      if (cursor === null) throw new Error("expected a next cursor");
      // The cursor is opaque: base64url, never the sort key in the clear.
      assert.match(cursor, /^[A-Za-z0-9_-]+$/);

      const pageTwo = yield* mine(user, `?limit=2&cursor=${cursor}`);
      assert.strictEqual(pageTwo.status, 200, pageTwo.body);
      const secondPage = myListingsPageOf(pageTwo.json);
      assert.deepStrictEqual(idsOf(secondPage), [firstCreated.id]);
      assert.isNull(secondPage.nextCursor);
    }),
  );

  it.effect("keeps the paging contract and rejects an unauthenticated caller", () =>
    Effect.gen(function* () {
      const user = yield* register("mine-contract");

      for (const query of ["?limit=0", "?limit=51", "?limit=abc", "?cursor=not-a-cursor"]) {
        const response = yield* mine(user, query);
        assert.strictEqual(response.status, 400, query);
      }

      const anonymous = yield* mine(undefined);
      assert.strictEqual(anonymous.status, 401);

      const anonymousPaged = yield* mine(undefined, "?limit=2");
      assert.strictEqual(anonymousPaged.status, 401);
    }),
  );
});

describe("GET /listings/mine page", () => {
  it.effect("answers a signed-out visitor with a sign-in prompt, not a bare 401", () =>
    Effect.gen(function* () {
      for (const path of ["/listings/mine", "/listings/new"]) {
        const response = yield* send("GET", path);
        assert.strictEqual(response.status, 401, path);
        assert.notInclude(response.body, "UnauthorizedError", path);
        assert.include(response.body, 'href="/login"', path);
      }
    }),
  );

  it.effect("renders the signed-in owner's feed", () =>
    Effect.gen(function* () {
      const user = yield* register("mine-page");
      const listing = yield* createDraft(user, { title: "A draft on the mine page" });

      const response = yield* send("GET", "/listings/mine", { cookie: user.cookie });
      assert.strictEqual(response.status, 200, response.body);
      assert.include(response.body, "A draft on the mine page");
      assert.include(response.body, "Showing 1 listing, newest first");
      assert.include(response.body, 'name="returnTo" value="/listings/mine"');
      assert.include(response.body, `action="/listings/${listing.id}/publish"`);
    }),
  );
});
