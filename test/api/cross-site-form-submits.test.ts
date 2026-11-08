import { asObject, call, form, register, send, testOrigin } from "../support/api";
import type { TestUser } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

/*
 * A form post is a simple request, so CORS never sees it: another site's page can
 * post one of these forms, and the payload-less writes on the JSON API, with the
 * lister's session cookie attached. These tests pin both halves of the defence:
 * the session cookies state `SameSite=Lax` instead of inheriting a browser
 * default, and both the page form routes and the private API boundary refuse a
 * state-changing request they can tell came from another site before it reads the
 * form or touches a listing.
 *
 * The page forms are the browser's: `application/x-www-form-urlencoded`, posted to
 * the page route with the session cookie the app issued. The API writes carry
 * their own `Origin` / `Sec-Fetch-Site` headers, including the payload-less
 * publish, unlist and change-role calls a page can submit without a preflight.
 */

const PASSWORD = "correct horse battery staple";

let priceCounter = 0;
const uniquePriceMinor = () => 200_000 + (priceCounter += 1) * 137;
const uniqueTitle = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const listingPayload = (overrides: Record<string, unknown> = {}) => ({
  kind: "room",
  title: uniqueTitle("csrf-listing"),
  priceMinor: uniquePriceMinor(),
  regionCode: "crete",
  ...overrides,
});

const createDraft = (user: TestUser, overrides: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const response = yield* send("POST", "/api/listings", {
      cookie: user.cookie,
      payload: listingPayload(overrides),
    });
    assert.strictEqual(response.status, 200, `create draft: ${response.body}`);
    return asObject(response.json);
  });

const publish = (user: TestUser, id: unknown) =>
  send("POST", `/api/listings/${String(id)}/publish`, { cookie: user.cookie });

interface OwnListing {
  readonly id: unknown;
  readonly title: unknown;
  readonly status: unknown;
}

// The owner's own feed is the read that shows what a listing really is, drafts
// and unlisted rows included - the public detail route hides those.
const ownListings = (user: TestUser) =>
  Effect.gen(function* () {
    const response = yield* call("/api/listings/mine?limit=50", {
      headers: { cookie: user.cookie },
    });
    assert.strictEqual(response.status, 200, response.body);
    return (asObject(response.json)["items"] as ReadonlyArray<unknown>).map(
      (item) => asObject(item) as unknown as OwnListing,
    );
  });

const ownListing = (user: TestUser, id: unknown) =>
  Effect.map(ownListings(user), (items) => items.find((item) => String(item.id) === String(id)));

const formFields = (overrides: Readonly<Record<string, string>> = {}) => ({
  kind: "room",
  title: uniqueTitle("csrf-form"),
  price: "1234",
  regionCode: "crete",
  ...overrides,
});

// The cookie travels in the headers exactly as a browser would send it: the
// cross-site case is not missing a session, it is presenting the lister's own.
const submitForm = (
  user: TestUser | undefined,
  path: string,
  fields: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>> = {},
) =>
  call(
    path,
    form(
      {
        method: "POST",
        headers: {
          ...(user === undefined ? {} : { cookie: user.cookie }),
          ...headers,
        },
      },
      fields,
    ),
  );

const crossSite = { origin: "https://evil.example" } as const;

const cookieValue = (user: TestUser): string => user.cookie.slice(user.cookie.indexOf("=") + 1);

/*
 * The refused response must not hand back a different session: the auth
 * middleware re-issues the access cookie it already accepted, and no refresh
 * cookie appears where the request carried none.
 */
const assertRefused = (
  response: { status: number; body: string; setCookies: ReadonlyArray<string> },
  user: TestUser,
) => {
  assert.strictEqual(response.status, 403, response.body);
  assert.include(response.body, "can only be submitted from this site");

  const access = response.setCookies.filter((header) => header.startsWith("access_token="));
  assert.strictEqual(access.length, 1);
  assert.isTrue(access[0]?.startsWith(`access_token=${cookieValue(user)};`), access[0]);
  assert.isFalse(response.setCookies.some((header) => header.startsWith("refresh_token=")));
};

describe("a state-changing listing form post from another site", () => {
  it.effect("is refused on publish and leaves the listing a draft", () =>
    Effect.gen(function* () {
      const user = yield* register("csrf-publish");
      const draft = yield* createDraft(user);

      const rejected = yield* submitForm(
        user,
        `/listings/${String(draft.id)}/publish`,
        {
          returnTo: "/listings/mine",
        },
        crossSite,
      );
      assertRefused(rejected, user);

      const after = yield* ownListing(user, draft.id);
      assert.strictEqual(after?.status, "draft");
    }),
  );

  it.effect("is refused on unlist and leaves the listing published", () =>
    Effect.gen(function* () {
      const user = yield* register("csrf-unlist");
      const draft = yield* createDraft(user);
      assert.strictEqual((yield* publish(user, draft.id)).status, 200);

      const rejected = yield* submitForm(
        user,
        `/listings/${String(draft.id)}/unlist`,
        {},
        crossSite,
      );
      assertRefused(rejected, user);

      const after = yield* ownListing(user, draft.id);
      assert.strictEqual(after?.status, "published");
    }),
  );

  it.effect("is refused on the create form and creates nothing", () =>
    Effect.gen(function* () {
      const user = yield* register("csrf-create");
      const before = yield* ownListings(user);
      const title = uniqueTitle("csrf-created");

      const rejected = yield* submitForm(user, "/listings/new", formFields({ title }), crossSite);
      assertRefused(rejected, user);

      const after = yield* ownListings(user);
      assert.strictEqual(after.length, before.length);
      assert.isUndefined(after.find((item) => item.title === title));
    }),
  );

  it.effect("is refused on the edit form and leaves the listing as it was", () =>
    Effect.gen(function* () {
      const user = yield* register("csrf-edit");
      const draft = yield* createDraft(user, { title: uniqueTitle("csrf-untouched") });
      const renamed = uniqueTitle("csrf-renamed");

      const rejected = yield* submitForm(
        user,
        `/listings/${String(draft.id)}/edit`,
        formFields({ title: renamed }),
        crossSite,
      );
      assertRefused(rejected, user);

      const after = yield* ownListing(user, draft.id);
      assert.strictEqual(after?.title, draft.title);
    }),
  );

  it.effect("is refused when the browser labels the submit cross-site", () =>
    Effect.gen(function* () {
      const user = yield* register("csrf-sec-fetch-site");
      const draft = yield* createDraft(user);

      const rejected = yield* submitForm(
        user,
        `/listings/${String(draft.id)}/publish`,
        {},
        { "sec-fetch-site": "cross-site" },
      );
      assertRefused(rejected, user);
      assert.strictEqual((yield* ownListing(user, draft.id))?.status, "draft");
    }),
  );

  it.effect("is refused when only the Referer names the other site", () =>
    Effect.gen(function* () {
      const user = yield* register("csrf-referer");
      const draft = yield* createDraft(user);

      const rejected = yield* submitForm(
        user,
        `/listings/${String(draft.id)}/publish`,
        {},
        { referer: "https://evil.example/publish.html" },
      );
      assertRefused(rejected, user);
      assert.strictEqual((yield* ownListing(user, draft.id))?.status, "draft");
    }),
  );
});

describe("a listing form post from this site", () => {
  it.effect("is accepted when the browser marks it same-origin", () =>
    Effect.gen(function* () {
      const user = yield* register("same-origin");
      const draft = yield* createDraft(user);

      const accepted = yield* submitForm(
        user,
        `/listings/${String(draft.id)}/publish`,
        { returnTo: "/listings/mine" },
        { origin: testOrigin, "sec-fetch-site": "same-origin" },
      );
      assert.strictEqual(accepted.status, 303, accepted.body);
      assert.strictEqual(accepted.location, "/listings/mine");
      assert.strictEqual((yield* ownListing(user, draft.id))?.status, "published");
    }),
  );

  it.effect("is accepted when the browser marks it user-initiated", () =>
    Effect.gen(function* () {
      const user = yield* register("user-initiated");
      const draft = yield* createDraft(user);

      const accepted = yield* submitForm(
        user,
        `/listings/${String(draft.id)}/publish`,
        {},
        { "sec-fetch-site": "none" },
      );
      assert.strictEqual(accepted.status, 303, accepted.body);
      assert.strictEqual((yield* ownListing(user, draft.id))?.status, "published");
    }),
  );

  it.effect("is accepted from the host the request reached, not just DOMAIN", () =>
    Effect.gen(function* () {
      const user = yield* register("request-host");
      const draft = yield* createDraft(user);

      const accepted = yield* submitForm(
        user,
        `/listings/${String(draft.id)}/publish`,
        {},
        { origin: testOrigin },
      );
      assert.strictEqual(accepted.status, 303, accepted.body);
      assert.strictEqual((yield* ownListing(user, draft.id))?.status, "published");
    }),
  );

  it.effect("is accepted from a client that sends none of the origin headers", () =>
    Effect.gen(function* () {
      const user = yield* register("header-less");
      const draft = yield* createDraft(user);

      const accepted = yield* submitForm(user, `/listings/${String(draft.id)}/publish`, {});
      assert.strictEqual(accepted.status, 303, accepted.body);
      assert.strictEqual((yield* ownListing(user, draft.id))?.status, "published");
    }),
  );

  it.effect("is accepted on the create and edit forms", () =>
    Effect.gen(function* () {
      const user = yield* register("same-origin-write");
      const title = uniqueTitle("csrf-created");

      const created = yield* submitForm(user, "/listings/new", formFields({ title }), {
        origin: testOrigin,
      });
      assert.strictEqual(created.status, 303, created.body);

      const draft = (yield* ownListings(user)).find((item) => item.title === title);
      assert.isDefined(draft);

      const renamed = uniqueTitle("csrf-renamed");
      const edited = yield* submitForm(
        user,
        `/listings/${String(draft?.id)}/edit`,
        formFields({ title: renamed }),
        { origin: testOrigin },
      );
      assert.strictEqual(edited.status, 303, edited.body);
      assert.strictEqual((yield* ownListing(user, draft?.id))?.title, renamed);
    }),
  );
});

/*
 * The same rule at the JSON API's own boundary. These endpoints take no payload,
 * so a page on another site can submit one as a plain form post: empty body, no
 * content type, the lister's own cookie attached. The tests drive the endpoints
 * because the gate sits on the private router rather than in one handler.
 */
const apiWrite = (user: TestUser, path: string, headers: Readonly<Record<string, string>> = {}) =>
  call(path, {
    method: "POST",
    headers: { "user-agent": "estia-tests", cookie: user.cookie, ...headers },
  });

const statusOf = (user: TestUser, id: unknown) =>
  Effect.map(ownListing(user, id), (listing) => listing?.status);

const assertApiRefused = (response: { status: number; body: string }) => {
  assert.strictEqual(response.status, 403, response.body);
  assert.include(response.body, "can only be submitted from this site");
};

describe("a state-changing JSON write from another site", () => {
  it.effect("is refused on publish and leaves the listing a draft", () =>
    Effect.gen(function* () {
      const user = yield* register("api-csrf-publish");
      const draft = yield* createDraft(user);

      assertApiRefused(
        yield* apiWrite(user, `/api/listings/${String(draft.id)}/publish`, crossSite),
      );
      assert.strictEqual(yield* statusOf(user, draft.id), "draft");
    }),
  );

  it.effect("is refused on unlist and leaves the listing published", () =>
    Effect.gen(function* () {
      const user = yield* register("api-csrf-unlist");
      const draft = yield* createDraft(user);
      assert.strictEqual((yield* publish(user, draft.id)).status, 200);

      assertApiRefused(
        yield* apiWrite(user, `/api/listings/${String(draft.id)}/unlist`, crossSite),
      );
      assert.strictEqual(yield* statusOf(user, draft.id), "published");
    }),
  );

  // A sibling subdomain is not the request's own origin but still counts as the
  // same site, so the browser attaches the session cookie to its post.
  it.effect("is refused when the browser labels the write same-site", () =>
    Effect.gen(function* () {
      const user = yield* register("api-csrf-same-site");
      const draft = yield* createDraft(user);

      assertApiRefused(
        yield* apiWrite(user, `/api/listings/${String(draft.id)}/publish`, {
          "sec-fetch-site": "same-site",
        }),
      );
      assert.strictEqual(yield* statusOf(user, draft.id), "draft");
    }),
  );

  it.effect("is refused on change-role", () =>
    Effect.gen(function* () {
      const user = yield* register("api-csrf-change-role");

      assertApiRefused(yield* apiWrite(user, "/api/users/change-role", crossSite));
      assertApiRefused(
        yield* apiWrite(user, "/api/users/change-role", { "sec-fetch-site": "cross-site" }),
      );
    }),
  );

  it.effect("is accepted from this site's own page", () =>
    Effect.gen(function* () {
      const user = yield* register("api-write-same-origin");
      const draft = yield* createDraft(user);
      const path = `/api/listings/${String(draft.id)}`;
      const ownOrigin = { origin: testOrigin, "sec-fetch-site": "same-origin" };

      const accepted = yield* apiWrite(user, `${path}/publish`, ownOrigin);
      assert.strictEqual(accepted.status, 200, accepted.body);
      assert.strictEqual(yield* statusOf(user, draft.id), "published");

      const unlisted = yield* apiWrite(user, `${path}/unlist`, ownOrigin);
      assert.strictEqual(unlisted.status, 200, unlisted.body);
      assert.strictEqual(yield* statusOf(user, draft.id), "unpublished");
    }),
  );

  it.effect("is accepted from a client that sends none of the origin headers", () =>
    Effect.gen(function* () {
      const user = yield* register("api-write-header-less");
      const draft = yield* createDraft(user);
      const path = `/api/listings/${String(draft.id)}`;

      const accepted = yield* apiWrite(user, `${path}/publish`);
      assert.strictEqual(accepted.status, 200, accepted.body);
      assert.strictEqual(yield* statusOf(user, draft.id), "published");

      const unlisted = yield* apiWrite(user, `${path}/unlist`);
      assert.strictEqual(unlisted.status, 200, unlisted.body);
      assert.strictEqual(yield* statusOf(user, draft.id), "unpublished");
    }),
  );

  // A user-initiated request carries no cross-site claim, so it is not refused.
  // The handler may still answer with its own error, which is not the gate's 403:
  // a freshly registered account has no profile for `change-role` to return.
  it.effect("is accepted on change-role when the browser marks it user-initiated", () =>
    Effect.gen(function* () {
      const user = yield* register("api-write-user-initiated");

      const userInitiated = yield* apiWrite(user, "/api/users/change-role", {
        "sec-fetch-site": "none",
      });
      assert.notStrictEqual(userInitiated.status, 403, userInitiated.body);
      assert.notInclude(userInitiated.body, "can only be submitted from this site");
    }),
  );
});

/*
 * The other half of the defence: the session cookies state their policy instead of
 * inheriting a browser default, on both the surface that issues them and the
 * middleware that re-issues them on every authenticated request.
 */
describe("the session cookies", () => {
  const sameSiteOf = (setCookies: ReadonlyArray<string>, name: string): string | undefined => {
    const header = setCookies.find((value) => value.toLowerCase().startsWith(`${name}=`));
    return header?.match(/;\s*SameSite=([^;]+)/i)?.[1];
  };

  it.effect("are issued with SameSite=Lax on both the access and refresh cookie", () =>
    Effect.gen(function* () {
      const response = yield* send("POST", "/api/auth/register", {
        payload: { email: `${uniqueTitle("cookie")}@test.local`, password: PASSWORD },
      });
      assert.strictEqual(response.status, 200, response.body);
      assert.strictEqual(sameSiteOf(response.setCookies, "access_token"), "Lax");
      assert.strictEqual(sameSiteOf(response.setCookies, "refresh_token"), "Lax");
    }),
  );

  it.effect("keep SameSite=Lax when the auth middleware re-issues them", () =>
    Effect.gen(function* () {
      const user = yield* register("cookie-middleware");

      // Every authenticated private request goes through the middleware, which
      // re-issues the session cookie the request presented.
      const response = yield* call("/listings/mine", { headers: { cookie: user.cookie } });
      assert.strictEqual(response.status, 200, response.body);
      assert.strictEqual(sameSiteOf(response.setCookies, "access_token"), "Lax");
    }),
  );

  it.effect("keep SameSite=Lax on the cookie a form sign-in issues", () =>
    Effect.gen(function* () {
      const email = `${uniqueTitle("cookie-form")}@test.local`;
      yield* send("POST", "/api/auth/register", { payload: { email, password: PASSWORD } });

      const response = yield* call(
        "/login",
        form({ method: "POST" }, { email, password: PASSWORD }),
      );
      assert.strictEqual(response.status, 303, response.body);
      assert.strictEqual(sameSiteOf(response.setCookies, "access_token"), "Lax");
      assert.strictEqual(sameSiteOf(response.setCookies, "refresh_token"), "Lax");
    }),
  );
});
