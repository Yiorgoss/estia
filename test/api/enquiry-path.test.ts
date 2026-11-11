import { ENQUIRY_PAGE_SIZE } from "@/db/schema/Enquiry";
import { asObject, call, form, json, query, register, send, testOrigin } from "../support/api";
import type { TestResponse, TestUser } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

const agent = "estia-tests";

const saveProfile = (user: TestUser, payload: unknown) =>
  send("PUT", "/api/users/profile", { cookie: user.cookie, payload });

const switchRole = (user: TestUser) =>
  call(
    "/api/users/change-role",
    json({ method: "POST", headers: { cookie: user.cookie, origin: testOrigin } }),
  );

const seekerPayload = (overrides: Record<string, unknown> = {}) => ({
  name: "Ada Seeker",
  dateOfBirth: Date.UTC(1995, 3, 12),
  gender: "female",
  bio: "Looking for a quiet room",
  contact: "ada@example.test",
  smoking: 0,
  pets: 0,
  ...overrides,
});

const listerPayload = (overrides: Record<string, unknown> = {}) => ({
  name: "Ada Lets",
  ownership: "owner",
  contact: "lets@example.test",
  ...overrides,
});

const listerUser = (label: string) =>
  Effect.gen(function* () {
    const user = yield* register(label);
    const switched = yield* switchRole(user);
    assert.strictEqual(switched.status, 200, switched.body);
    return user;
  });

const createListing = (user: TestUser, overrides: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const response = yield* send("POST", "/api/listings", {
      cookie: user.cookie,
      payload: {
        kind: "room",
        title: "Sunny room near the port",
        description: "A quiet room with a balcony",
        priceMinor: 771_100 + Math.floor(Math.random() * 100),
        regionCode: "attica",
        sizeSqm: 30,
        furnished: 1,
        ensuite: 0,
        smoking: 0,
        pets: 1,
        ...overrides,
      },
    });
    assert.strictEqual(response.status, 200, `create listing: ${response.body}`);
    return asObject(response.json);
  });

const publish = (user: TestUser, id: unknown) =>
  Effect.gen(function* () {
    const response = yield* send("POST", `/api/listings/${String(id)}/publish`, {
      cookie: user.cookie,
    });
    assert.strictEqual(response.status, 200, `publish: ${response.body}`);
    return asObject(response.json);
  });

const sentItems = (response: TestResponse) =>
  (asObject(response.json)["items"] as ReadonlyArray<Record<string, unknown>>) ?? [];

// The whole contact path shares one lister, one seeker, and one published
// listing; the other accounts exist to prove the cross-account boundaries.
const world = await Effect.runPromise(
  Effect.gen(function* () {
    const lister = yield* listerUser("enq-lister");
    const seeker = yield* register("enq-seeker");
    const other = yield* register("enq-other");
    const secondLister = yield* listerUser("enq-second-lister");

    const savedLister = yield* saveProfile(lister, listerPayload());
    assert.strictEqual(savedLister.status, 200, savedLister.body);
    const savedSeeker = yield* saveProfile(seeker, seekerPayload());
    assert.strictEqual(savedSeeker.status, 200, savedSeeker.body);
    const savedOther = yield* saveProfile(
      other,
      seekerPayload({ name: "Other Seeker", contact: "other@example.test" }),
    );
    assert.strictEqual(savedOther.status, 200, savedOther.body);
    const savedSecond = yield* saveProfile(
      secondLister,
      listerPayload({ name: "Second Lets", contact: "second@example.test" }),
    );
    assert.strictEqual(savedSecond.status, 200, savedSecond.body);

    const draft = yield* createListing(lister);
    const listing = yield* publish(lister, draft.id);
    const secondDraft = yield* createListing(secondLister, { title: "A room elsewhere" });
    const secondListing = yield* publish(secondLister, secondDraft.id);

    return { lister, seeker, other, secondLister, listing, secondListing };
  }),
);

const listingId = String(world.listing.id);

describe("the contact path's public surfaces", () => {
  it.effect(
    "never carries the lister's contact details or the enquiry form to an anonymous reader",
    () =>
      Effect.gen(function* () {
        const page = yield* call(`/listings/${listingId}`);
        assert.strictEqual(page.status, 200, page.body);
        assert.notInclude(page.body, "lets@example.test");
        assert.notInclude(page.body, `action="/listings/${listingId}/enquiries"`);
        assert.include(page.body, "Sign in to contact");

        // Neither the single-listing payload nor the search feed carries contact
        // details: they are a profile read, not a listing field.
        const detail = yield* call(`/api/listings/${listingId}`);
        assert.strictEqual(detail.status, 200, detail.body);
        assert.notInclude(detail.body, "lets@example.test");
        assert.isFalse("contact" in asObject(detail.json), "detail payload exposed contact");

        const feed = yield* call("/api/listings?minPriceMinor=0&maxPriceMinor=100000000");
        assert.strictEqual(feed.status, 200, feed.body);
        assert.notInclude(feed.body, "lets@example.test");
        for (const item of sentItems(feed)) {
          assert.isFalse("contact" in item, "feed item exposed contact");
        }

        const map = yield* call("/api/listings/map");
        assert.strictEqual(map.status, 200, map.body);
        assert.notInclude(map.body, "lets@example.test");
      }),
  );

  it.effect("shows a signed-in seeker the published contact line and the form", () =>
    Effect.gen(function* () {
      const page = yield* call(`/listings/${listingId}`, {
        headers: { cookie: world.seeker.cookie, "user-agent": agent },
      });
      assert.strictEqual(page.status, 200, page.body);
      assert.include(page.body, "Ada Lets");
      assert.include(page.body, "lets@example.test");
      assert.include(page.body, `action="/listings/${listingId}/enquiries"`);
      assert.include(page.body, "Send enquiry");
    }),
  );

  it.effect("offers the owner their enquiries instead of a form to themselves", () =>
    Effect.gen(function* () {
      const page = yield* call(`/listings/${listingId}`, {
        headers: { cookie: world.lister.cookie, "user-agent": agent },
      });
      assert.strictEqual(page.status, 200, page.body);
      assert.include(page.body, "This is your listing");
      assert.include(page.body, 'href="/enquiries"');
      assert.notInclude(page.body, `action="/listings/${listingId}/enquiries"`);
    }),
  );

  it.effect("keeps a rotated session when the listing page is not found", () =>
    Effect.gen(function* () {
      const registered = yield* send("POST", "/api/auth/register", {
        payload: {
          email: `enq-rotated-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
          password: "correct horse battery staple",
        },
      });
      assert.strictEqual(registered.status, 200, registered.body);
      const refresh = registered.cookies["refresh_token"];
      assert.isString(refresh);

      // A returning browser whose access cookie expired: only the refresh
      // cookie is left, so opening a stale listing link rotates the session.
      const missing = yield* call("/listings/99999999", {
        headers: { cookie: `refresh_token=${refresh}`, "user-agent": agent },
      });
      assert.strictEqual(missing.status, 404, missing.body);
      const rotatedAccess = missing.cookies["access_token"];
      const rotatedRefresh = missing.cookies["refresh_token"];
      assert.isString(rotatedAccess);
      assert.isString(rotatedRefresh);
      assert.notStrictEqual(rotatedRefresh, refresh);

      // The fresh pair is the live session, and the old refresh token is dead.
      const privatePage = yield* call("/api/users/me", {
        headers: { cookie: `access_token=${rotatedAccess}`, "user-agent": agent },
      });
      assert.strictEqual(privatePage.status, 200, privatePage.body);

      const replay = yield* call("/api/auth/refresh", {
        method: "POST",
        headers: {
          cookie: `refresh_token=${refresh}`,
          origin: testOrigin,
          "user-agent": agent,
        },
      });
      assert.strictEqual(replay.status, 401, replay.body);
    }),
  );

  // The enquiries page is on the private router, so its session is resolved by
  // the auth middleware. A returning browser whose access cookie expired must
  // be rotated back in there, not refused by the page behind it.
  it.effect("rotates an expired session on the enquiries page instead of refusing it", () =>
    Effect.gen(function* () {
      const registered = yield* send("POST", "/api/auth/register", {
        payload: {
          email: `enq-page-rotated-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
          password: "correct horse battery staple",
        },
      });
      assert.strictEqual(registered.status, 200, registered.body);
      const refresh = registered.cookies["refresh_token"];
      assert.isString(refresh);

      const page = yield* call("/enquiries", {
        headers: {
          cookie: `access_token=an.expired.token; refresh_token=${refresh}`,
          "user-agent": agent,
        },
      });
      assert.strictEqual(page.status, 200, page.body);
      assert.include(page.body, "Enquiries you sent");

      const rotatedAccess = page.cookies["access_token"];
      const rotatedRefresh = page.cookies["refresh_token"];
      assert.isString(rotatedAccess);
      assert.isString(rotatedRefresh);
      assert.notStrictEqual(rotatedAccess, "an.expired.token");
      assert.notStrictEqual(rotatedRefresh, refresh);

      // The rotated pair is the live session on the private API too.
      const sent = yield* call("/api/enquiries/sent", {
        headers: { cookie: `access_token=${rotatedAccess}`, "user-agent": agent },
      });
      assert.strictEqual(sent.status, 200, sent.body);

      // A genuinely signed-out visitor is still refused, and gets no cookies.
      const signedOut = yield* call("/enquiries", { headers: { "user-agent": agent } });
      assert.strictEqual(signedOut.status, 401, signedOut.body);
      assert.include(signedOut.body, "Sign in required");
      assert.isUndefined(signedOut.cookies["access_token"]);
      assert.isUndefined(signedOut.cookies["refresh_token"]);
    }),
  );

  // A private route can end in a failure that the runtime answers for, not in a
  // response the route built. The rotation already performed on that request
  // has to reach the browser on the answer too.
  it.effect("delivers the rotated pair when a private route fails before answering", () =>
    Effect.gen(function* () {
      const registered = yield* send("POST", "/api/auth/register", {
        payload: {
          email: `enq-failed-route-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
          password: "correct horse battery staple",
        },
      });
      assert.strictEqual(registered.status, 200, registered.body);
      const refresh = registered.cookies["refresh_token"];
      assert.isString(refresh);

      const malformed = yield* call("/api/enquiries/sent?cursor=not-a-cursor", {
        headers: {
          cookie: `access_token=an.expired.token; refresh_token=${refresh}`,
          "user-agent": agent,
        },
      });
      assert.strictEqual(malformed.status, 400, malformed.body);

      const rotatedAccess = malformed.cookies["access_token"];
      const rotatedRefresh = malformed.cookies["refresh_token"];
      assert.isString(rotatedAccess);
      assert.isString(rotatedRefresh);
      assert.notStrictEqual(rotatedAccess, "an.expired.token");
      assert.notStrictEqual(rotatedRefresh, refresh);

      // The failed request did not leave the browser with a revoked session.
      const sent = yield* call("/api/enquiries/sent", {
        headers: { cookie: `access_token=${rotatedAccess}`, "user-agent": agent },
      });
      assert.strictEqual(sent.status, 200, sent.body);
    }),
  );
});

describe("POST /api/listings/:id/enquiries", () => {
  let message = "";

  it.effect("records the enquiry with the session's identity and a trimmed message", () =>
    Effect.gen(function* () {
      message = `Enquiry ${Date.now()}`;
      const response = yield* send("POST", `/api/listings/${listingId}/enquiries`, {
        cookie: world.seeker.cookie,
        payload: { message: `  ${message}  ` },
      });

      assert.strictEqual(response.status, 200, response.body);
      const enquiry = asObject(response.json);
      assert.strictEqual(enquiry.message, message);
      assert.strictEqual(enquiry.senderId, world.seeker.id);
      assert.strictEqual(String(enquiry.listingId), listingId);
    }),
  );

  it.effect("shows the lister who wrote, how to reach them, and when", () =>
    Effect.gen(function* () {
      const received = yield* call("/api/enquiries/received", {
        headers: { cookie: world.lister.cookie, "user-agent": agent },
      });
      assert.strictEqual(received.status, 200, received.body);

      const match = sentItems(received).find((item) => item.message === message);
      assert.isDefined(match, received.body);
      assert.strictEqual(match?.listingTitle, "Sunny room near the port");
      assert.strictEqual(match?.senderName, "Ada Seeker");
      assert.strictEqual(match?.senderContact, "ada@example.test");
      assert.isNumber(match?.createdAt);
      // The lister reads the sender's published identity, never their account id.
      assert.isFalse("senderId" in (match ?? {}), "received enquiry exposed senderId");
    }),
  );

  it.effect(
    "falls back to the account email when a lister-only sender has no seeking identity",
    () =>
      Effect.gen(function* () {
        const sender = yield* listerUser("enq-identity-sender");
        const saved = yield* saveProfile(
          sender,
          listerPayload({ name: "Sender Lets", contact: "sender-contact@example.test" }),
        );
        assert.strictEqual(saved.status, 200, saved.body);

        const message = `Identity ${Date.now()}`;
        const sent = yield* send("POST", `/api/listings/${listingId}/enquiries`, {
          cookie: sender.cookie,
          payload: { message },
        });
        assert.strictEqual(sent.status, 200, sent.body);

        const received = yield* call("/api/enquiries/received", {
          headers: { cookie: world.lister.cookie, "user-agent": agent },
        });
        assert.strictEqual(received.status, 200, received.body);
        const match = sentItems(received).find((item) => item.message === message);
        assert.isDefined(match, received.body);
        assert.strictEqual(match?.senderName, sender.email);
        assert.strictEqual(match?.senderContact, sender.email);

        const page = yield* call("/enquiries", {
          headers: { cookie: world.lister.cookie, "user-agent": agent },
        });
        assert.strictEqual(page.status, 200, page.body);
        assert.include(page.body, message);
        assert.include(page.body, `From <span class="font-medium">${sender.email}</span>`);
        assert.include(page.body, `Contact: ${sender.email}`);
      }),
  );

  it.effect("snapshots the sender identity when the enquiry is sent", () =>
    Effect.gen(function* () {
      const sender = yield* register("enq-snapshot-seeker");
      const before = yield* saveProfile(
        sender,
        seekerPayload({ name: "Snapshot Before", contact: "before@example.test" }),
      );
      assert.strictEqual(before.status, 200, before.body);

      const message = `Snapshot ${Date.now()}`;
      const sent = yield* send("POST", `/api/listings/${listingId}/enquiries`, {
        cookie: sender.cookie,
        payload: { message },
      });
      assert.strictEqual(sent.status, 200, sent.body);

      const after = yield* saveProfile(
        sender,
        seekerPayload({ name: "Snapshot After", contact: "after@example.test" }),
      );
      assert.strictEqual(after.status, 200, after.body);

      const received = yield* call("/api/enquiries/received", {
        headers: { cookie: world.lister.cookie, "user-agent": agent },
      });
      assert.strictEqual(received.status, 200, received.body);
      const match = sentItems(received).find((item) => item.message === message);
      assert.isDefined(match, received.body);
      assert.strictEqual(match?.senderName, "Snapshot Before");
      assert.strictEqual(match?.senderContact, "before@example.test");

      const page = yield* call("/enquiries", {
        headers: { cookie: world.lister.cookie, "user-agent": agent },
      });
      assert.strictEqual(page.status, 200, page.body);
      assert.include(page.body, `From <span class="font-medium">Snapshot Before</span>`);
      assert.include(page.body, "Contact: before@example.test");
      assert.notInclude(page.body, "Snapshot After");
      assert.notInclude(page.body, "after@example.test");
    }),
  );

  it.effect("refuses a sender whose account has neither a name nor an email to show", () =>
    Effect.gen(function* () {
      const registered = yield* send("POST", "/api/auth/register", {
        payload: { email: " ", password: "correct horse battery staple" },
      });
      assert.strictEqual(registered.status, 200, registered.body);
      const access = registered.cookies["access_token"];
      assert.isString(access);
      const cookie = `access_token=${access}`;

      const apiSend = yield* send("POST", `/api/listings/${listingId}/enquiries`, {
        cookie,
        payload: { message: "No identity here" },
      });
      assert.strictEqual(apiSend.status, 400, apiSend.body);
      const body = asObject(apiSend.json);
      assert.strictEqual(body["_tag"], "EnquiryValidationError");
      assert.include(String(body["message"]), "no name or email");

      const pageSend = yield* call(
        `/listings/${listingId}/enquiries`,
        form(
          { method: "POST", headers: { cookie, "user-agent": agent } },
          { message: "No identity here either" },
        ),
      );
      assert.strictEqual(pageSend.status, 400, pageSend.body);
      assert.include(pageSend.body, "no name or email");
    }),
  );

  it.effect("shows the seeker what they sent, and no other account's rows", () =>
    Effect.gen(function* () {
      const sent = yield* call("/api/enquiries/sent", {
        headers: { cookie: world.seeker.cookie, "user-agent": agent },
      });
      assert.strictEqual(sent.status, 200, sent.body);
      const match = sentItems(sent).find((item) => item.message === message);
      assert.isDefined(match, sent.body);
      assert.strictEqual(match?.listingTitle, "Sunny room near the port");
      assert.isFalse("senderId" in (match ?? {}), "sent enquiry exposed senderId");

      // A different account has its own empty lists, even though the rows exist.
      const otherReceived = yield* call("/api/enquiries/received", {
        headers: { cookie: world.other.cookie, "user-agent": agent },
      });
      assert.strictEqual(otherReceived.status, 200, otherReceived.body);
      assert.isUndefined(sentItems(otherReceived).find((item) => item.message === message));

      const otherSent = yield* call("/api/enquiries/sent", {
        headers: { cookie: world.other.cookie, "user-agent": agent },
      });
      assert.strictEqual(otherSent.status, 200, otherSent.body);
      assert.isUndefined(sentItems(otherSent).find((item) => item.message === message));

      const secondReceived = yield* call("/api/enquiries/received", {
        headers: { cookie: world.secondLister.cookie, "user-agent": agent },
      });
      assert.strictEqual(secondReceived.status, 200, secondReceived.body);
      assert.isUndefined(sentItems(secondReceived).find((item) => item.message === message));
    }),
  );

  it.effect("refuses anonymous sends and reads", () =>
    Effect.gen(function* () {
      const anonSend = yield* send("POST", `/api/listings/${listingId}/enquiries`, {
        payload: { message: "Anonymous" },
      });
      assert.strictEqual(anonSend.status, 401);

      for (const path of ["/api/enquiries/sent", "/api/enquiries/received"]) {
        const response = yield* call(path, { headers: { "user-agent": agent } });
        assert.strictEqual(response.status, 401, path);
      }
    }),
  );

  it.effect("refuses a blank or oversized message and a cross-site post", () =>
    Effect.gen(function* () {
      for (const payload of [{ message: "   " }, { message: "x".repeat(2001) }]) {
        const response = yield* send("POST", `/api/listings/${listingId}/enquiries`, {
          cookie: world.seeker.cookie,
          payload,
        });
        assert.strictEqual(response.status, 400, response.body);
      }

      const crossSite = yield* call(
        `/api/listings/${listingId}/enquiries`,
        json(
          {
            method: "POST",
            headers: { cookie: world.seeker.cookie, origin: "http://evil.example" },
          },
          { message: "cross-site" },
        ),
      );
      assert.strictEqual(crossSite.status, 403, crossSite.body);
    }),
  );

  it.effect("refuses the owner's own listing and a listing that is not published", () =>
    Effect.gen(function* () {
      const own = yield* send("POST", `/api/listings/${listingId}/enquiries`, {
        cookie: world.lister.cookie,
        payload: { message: "To myself" },
      });
      assert.strictEqual(own.status, 409, own.body);
      assert.strictEqual(asObject(own.json)["_tag"], "EnquiryOwnListingError");

      const draft = yield* createListing(world.lister, { title: "Still private" });
      const hidden = yield* send("POST", `/api/listings/${String(draft.id)}/enquiries`, {
        cookie: world.seeker.cookie,
        payload: { message: "Can I see it?" },
      });
      assert.strictEqual(hidden.status, 404, hidden.body);

      const missing = yield* send("POST", "/api/listings/99999999/enquiries", {
        cookie: world.seeker.cookie,
        payload: { message: "Nowhere" },
      });
      assert.strictEqual(missing.status, 404, missing.body);
    }),
  );
});

describe("the contact form on a listing detail page", () => {
  it.effect("sends from the page and lands on the enquiries page on both sides", () =>
    Effect.gen(function* () {
      const message = `Form enquiry ${Date.now()}`;
      const sent = yield* call(
        `/listings/${listingId}/enquiries`,
        form(
          { method: "POST", headers: { cookie: world.seeker.cookie, "user-agent": agent } },
          { message },
        ),
      );
      assert.strictEqual(sent.status, 303, sent.body);
      assert.strictEqual(sent.location, "/enquiries?sent=1");

      const listerPage = yield* call("/enquiries", {
        headers: { cookie: world.lister.cookie, "user-agent": agent },
      });
      assert.strictEqual(listerPage.status, 200, listerPage.body);
      assert.include(listerPage.body, message);
      assert.include(listerPage.body, "Ada Seeker");
      assert.include(listerPage.body, "ada@example.test");
      assert.include(listerPage.body, "Enquiries your listings received");

      const seekerPage = yield* call("/enquiries?sent=1", {
        headers: { cookie: world.seeker.cookie, "user-agent": agent },
      });
      assert.strictEqual(seekerPage.status, 200, seekerPage.body);
      assert.include(seekerPage.body, "Your enquiry was sent");
      assert.include(seekerPage.body, message);
      assert.include(seekerPage.body, "Enquiries you sent");

      // Without a session the page is the sign-in prompt, not the enquiry list.
      const anonymous = yield* call("/enquiries", { headers: { "user-agent": agent } });
      assert.strictEqual(anonymous.status, 401, anonymous.body);
      assert.notInclude(anonymous.body, message);
    }),
  );

  it.effect("returns a refused message to the listing page with what was typed", () =>
    Effect.gen(function* () {
      const refused = yield* call(
        `/listings/${listingId}/enquiries`,
        form(
          { method: "POST", headers: { cookie: world.seeker.cookie, "user-agent": agent } },
          { message: "   " },
        ),
      );
      assert.strictEqual(refused.status, 400, refused.body);
      assert.include(refused.body, "Write a message up to 2000 characters.");
      assert.include(refused.body, `action="/listings/${listingId}/enquiries"`);
    }),
  );

  it.effect("keeps the profile form's contact box and the saved line", () =>
    Effect.gen(function* () {
      const page = yield* call("/profile", {
        headers: { cookie: world.lister.cookie, "user-agent": agent },
      });
      assert.strictEqual(page.status, 200, page.body);
      assert.include(page.body, 'name="contact"');
      assert.include(page.body, 'value="lets@example.test"');

      // The API reads the same stored line back to its owner.
      const profile = yield* call("/api/users/profile", {
        headers: { cookie: world.lister.cookie, "user-agent": agent },
      });
      assert.strictEqual(profile.status, 200, profile.body);
      assert.strictEqual(
        asObject(asObject(profile.json)["profile"])["contact"],
        "lets@example.test",
      );
    }),
  );
});

describe("enquiry pagination", () => {
  it.effect("bounds both API lists and walks them with a cursor without gaps or repeats", () =>
    Effect.gen(function* () {
      const seeker = yield* register("enq-page-seeker");
      const lister = yield* listerUser("enq-page-lister");
      const saved = yield* saveProfile(
        lister,
        listerPayload({ name: "Page Lets", contact: "page@example.test" }),
      );
      assert.strictEqual(saved.status, 200, saved.body);
      const draft = yield* createListing(lister, { title: "Paged listing" });
      const listing = yield* publish(lister, draft.id);
      const total = ENQUIRY_PAGE_SIZE * 2 + 3;

      for (let index = 0; index < total; index += 1) {
        yield* query(
          "INSERT INTO enquiries (listing_id, sender_id, message, sender_name, sender_contact, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [
            Number(listing.id),
            seeker.id,
            `Page message ${index}`,
            seeker.email,
            seeker.email,
            1_700_000_000_000 + index,
          ],
        );
      }

      const walk = (path: string, cookie: string) =>
        Effect.gen(function* () {
          const seen: Array<string> = [];
          let cursor: string | undefined;
          do {
            const response = yield* call(
              `${path}${cursor === undefined ? "" : `?cursor=${cursor}`}`,
              { headers: { cookie, "user-agent": agent } },
            );
            assert.strictEqual(response.status, 200, response.body);
            const body = asObject(response.json);
            const items = (body["items"] as ReadonlyArray<Record<string, unknown>>) ?? [];
            assert.isAtMost(items.length, ENQUIRY_PAGE_SIZE, path);
            seen.push(...items.map((item) => String(item["message"])));
            const next = body["nextCursor"];
            cursor = next == null ? undefined : String(next);
          } while (cursor !== undefined);
          return seen;
        });

      for (const [path, cookie] of [
        ["/api/enquiries/sent", seeker.cookie],
        ["/api/enquiries/received", lister.cookie],
      ] as const) {
        const seen = yield* walk(path, cookie);
        assert.strictEqual(seen.length, total, path);
        assert.strictEqual(new Set(seen).size, total, path);
      }

      // The page hands out the same cursor as a link, and following it moves the
      // sent list to the rows the first page did not show.
      const firstPage = yield* call("/enquiries", {
        headers: { cookie: seeker.cookie, "user-agent": agent },
      });
      assert.strictEqual(firstPage.status, 200, firstPage.body);
      assert.include(firstPage.body, `Page message ${total - 1}`);
      assert.notInclude(firstPage.body, "Page message 0");
      const nextHref = /href="(\/enquiries\?sentCursor=[^"]+)"/.exec(firstPage.body)?.[1];
      assert.isString(nextHref);

      const secondPage = yield* call(nextHref ?? "/enquiries", {
        headers: { cookie: seeker.cookie, "user-agent": agent },
      });
      assert.strictEqual(secondPage.status, 200, secondPage.body);
      assert.include(secondPage.body, `Page message ${total - ENQUIRY_PAGE_SIZE - 1}`);
      assert.notInclude(secondPage.body, `Page message ${total - 1}`);
      assert.notInclude(secondPage.body, "Page message 0");

      // A malformed cursor is a bad request, never a silent first page.
      const malformedPage = yield* call("/enquiries?sentCursor=not-a-cursor", {
        headers: { cookie: seeker.cookie, "user-agent": agent },
      });
      assert.strictEqual(malformedPage.status, 400, malformedPage.body);

      const malformedApi = yield* call("/api/enquiries/sent?cursor=not-a-cursor", {
        headers: { cookie: seeker.cookie, "user-agent": agent },
      });
      assert.strictEqual(malformedApi.status, 400, malformedApi.body);
    }),
  );
});
