import { ListingId, UserId } from "@/db/schema/brands";
import type { KeysetCursor } from "@/db/schema/cursor";
import { ENQUIRY_PAGE_SIZE } from "@/db/schema/Enquiry";
import { EnquiryRepositoryLive } from "@/repos/enquiry.repo";
import { ListingRepositoryLive } from "@/repos/listing.repo";
import { ListerRepositoryLive } from "@/repos/lister.repo";
import { SeekerRepositoryLive } from "@/repos/seeker.repo";
import { UserRepositoryLive } from "@/repos/user.repo";
import { ENQUIRY_RATE_LIMIT, EnquiryService, EnquiryServiceLive } from "@/services/enquiry.service";
import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import {
  insertEnquiry,
  insertLister,
  insertListing,
  insertSeeker,
  insertUser,
} from "../support/seed";
import { TestSqlLive } from "../support/sql";

const userId = (value: string) => Schema.decodeSync(UserId)(value);
const listingId = (value: number) => Schema.decodeSync(ListingId)(value);

const RepositoriesLive = Layer.mergeAll(
  ListingRepositoryLive,
  EnquiryRepositoryLive,
  ListerRepositoryLive,
  SeekerRepositoryLive,
  UserRepositoryLive,
).pipe(Layer.provide(TestSqlLive));

const TestLive = Layer.merge(EnquiryServiceLive.pipe(Layer.provide(RepositoriesLive)), TestSqlLive);

const tagOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => (error as { readonly _tag?: string })._tag),
    Effect.orElseSucceed(() => "success"),
  );

layer(TestLive, { concurrent: false })("EnquiryService", (it) => {
  it.effect("records a trimmed message against a published listing", () =>
    Effect.gen(function* () {
      yield* insertUser("u-enq-send", "enq-send@test.local");
      yield* insertListing(6101, "u-enq-send", { status: "published" });
      yield* insertUser("u-enq-sender", "enq-sender@test.local");
      const service = yield* EnquiryService;

      const enquiry = yield* service.send(userId("u-enq-sender"), listingId(6101), {
        message: "  Is the room still available?  ",
      });

      assert.strictEqual(enquiry.listingId, 6101);
      assert.strictEqual(enquiry.senderId, "u-enq-sender");
      assert.strictEqual(enquiry.message, "Is the room still available?");
    }),
  );

  it.effect("refuses a missing, draft, or unlisted listing with the same not-found answer", () =>
    Effect.gen(function* () {
      yield* insertUser("u-enq-hidden", "enq-hidden@test.local");
      yield* insertUser("u-enq-watcher", "enq-watcher@test.local");
      yield* insertListing(6102, "u-enq-hidden", { status: "draft" });
      yield* insertListing(6103, "u-enq-hidden", { status: "unpublished" });
      const service = yield* EnquiryService;

      for (const id of [6102, 6103, 9_999_999]) {
        assert.strictEqual(
          yield* tagOf(service.send(userId("u-enq-watcher"), listingId(id), { message: "Hi" })),
          "EnquiryListingNotFoundError",
          `listing ${id}`,
        );
      }
    }),
  );

  it.effect("refuses an enquiry on the caller's own listing", () =>
    Effect.gen(function* () {
      yield* insertUser("u-enq-owner", "enq-owner@test.local");
      yield* insertListing(6104, "u-enq-owner", { status: "published" });
      const service = yield* EnquiryService;

      assert.strictEqual(
        yield* tagOf(service.send(userId("u-enq-owner"), listingId(6104), { message: "Hello me" })),
        "EnquiryOwnListingError",
      );
    }),
  );

  it.effect("rejects a blank or oversized message with a validation error", () =>
    Effect.gen(function* () {
      yield* insertUser("u-enq-msg-owner", "enq-msg-owner@test.local");
      yield* insertUser("u-enq-msg-sender", "enq-msg-sender@test.local");
      yield* insertListing(6105, "u-enq-msg-owner", { status: "published" });
      const service = yield* EnquiryService;

      for (const message of ["   ", "x".repeat(2001)]) {
        assert.strictEqual(
          yield* tagOf(service.send(userId("u-enq-msg-sender"), listingId(6105), { message })),
          "EnquiryValidationError",
        );
      }
    }),
  );

  it.effect("rate-limits one sender after the hourly limit", () =>
    Effect.gen(function* () {
      yield* insertUser("u-enq-rate-owner", "enq-rate-owner@test.local");
      yield* insertUser("u-enq-rate-sender", "enq-rate-sender@test.local");
      yield* insertListing(6106, "u-enq-rate-owner", { status: "published" });
      const service = yield* EnquiryService;

      for (let index = 0; index < ENQUIRY_RATE_LIMIT; index += 1) {
        yield* service.send(userId("u-enq-rate-sender"), listingId(6106), {
          message: `Message ${index}`,
        });
      }

      assert.strictEqual(
        yield* tagOf(
          service.send(userId("u-enq-rate-sender"), listingId(6106), { message: "One too many" }),
        ),
        "EnquiryRateLimitedError",
      );
    }),
  );

  it.effect("scopes each list to its own side of the contact path", () =>
    Effect.gen(function* () {
      yield* insertUser("u-enq-owner-a", "enq-owner-a@test.local");
      yield* insertUser("u-enq-owner-b", "enq-owner-b@test.local");
      yield* insertUser("u-enq-seeker-a", "enq-seeker-a@test.local");
      yield* insertUser("u-enq-seeker-b", "enq-seeker-b@test.local");
      yield* insertSeeker("u-enq-seeker-a", {
        name: "Ada Seeking",
        contact: "ada@example.test",
      });
      yield* insertSeeker("u-enq-seeker-b", { name: "Bob Seeking", contact: "bob@example.test" });
      yield* insertLister(7101, "u-enq-owner-a", {
        name: "Ada Lets",
        contact: "lets@example.test",
      });
      yield* insertListing(6107, "u-enq-owner-a", { status: "published", title: "Room A" });
      yield* insertListing(6108, "u-enq-owner-b", { status: "published", title: "Room B" });

      const service = yield* EnquiryService;
      yield* service.send(userId("u-enq-seeker-a"), listingId(6107), { message: "From A" });
      yield* service.send(userId("u-enq-seeker-b"), listingId(6108), { message: "From B" });

      const receivedA = yield* service.listReceived(userId("u-enq-owner-a"));
      assert.strictEqual(receivedA.items.length, 1);
      assert.strictEqual(receivedA.items[0]?.message, "From A");
      assert.strictEqual(receivedA.items[0]?.listingTitle, "Room A");
      assert.strictEqual(receivedA.items[0]?.senderName, "Ada Seeking");
      assert.strictEqual(receivedA.items[0]?.senderContact, "ada@example.test");

      const receivedB = yield* service.listReceived(userId("u-enq-owner-b"));
      assert.strictEqual(receivedB.items.length, 1);
      assert.strictEqual(receivedB.items[0]?.senderName, "Bob Seeking");

      const sentA = yield* service.listSent(userId("u-enq-seeker-a"));
      assert.strictEqual(sentA.items.length, 1);
      assert.strictEqual(sentA.items[0]?.message, "From A");
      assert.strictEqual(sentA.items[0]?.listingTitle, "Room A");

      // Each side only ever sees its own rows, even though both enquiries exist
      // and both listings are public.
      const sentB = yield* service.listSent(userId("u-enq-seeker-b"));
      assert.strictEqual(sentB.items.length, 1);
      assert.strictEqual(sentB.items[0]?.message, "From B");
      assert.notInclude(
        sentA.items.map((enquiry) => enquiry.message),
        "From B",
      );
      assert.notInclude(
        receivedA.items.map((enquiry) => enquiry.message),
        "From B",
      );
    }),
  );

  it.effect("falls back to the account email when the sender has no seeking profile", () =>
    Effect.gen(function* () {
      yield* insertUser("u-enq-identity-owner", "identity-owner@test.local");
      yield* insertUser("u-enq-identity-sender", "identity-sender@test.local");
      yield* insertListing(6110, "u-enq-identity-owner", { status: "published" });
      const service = yield* EnquiryService;

      yield* service.send(userId("u-enq-identity-sender"), listingId(6110), {
        message: "No profile here",
      });

      const received = yield* service.listReceived(userId("u-enq-identity-owner"));
      assert.strictEqual(received.items.length, 1);
      assert.strictEqual(received.items[0]?.senderName, "identity-sender@test.local");
      assert.strictEqual(received.items[0]?.senderContact, "identity-sender@test.local");
    }),
  );

  it.effect("uses the listing profile's published identity for a lister-only sender", () =>
    Effect.gen(function* () {
      yield* insertUser("u-enq-lister-owner", "lister-id-owner@test.local");
      yield* insertUser("u-enq-lister-sender", "lister-id-sender@test.local");
      yield* insertLister(7104, "u-enq-lister-sender", {
        name: "Sender Lets",
        contact: "sender-contact@example.test",
      });
      yield* insertListing(6113, "u-enq-lister-owner", { status: "published" });
      const service = yield* EnquiryService;

      yield* service.send(userId("u-enq-lister-sender"), listingId(6113), { message: "Hello" });

      const identity = yield* service.senderIdentityOf(userId("u-enq-lister-sender"));
      assert.strictEqual(identity.name, "Sender Lets");
      assert.strictEqual(identity.contact, "sender-contact@example.test");

      const received = yield* service.listReceived(userId("u-enq-lister-owner"));
      assert.strictEqual(received.items.length, 1);
      assert.strictEqual(received.items[0]?.senderName, "Sender Lets");
      assert.strictEqual(received.items[0]?.senderContact, "sender-contact@example.test");
    }),
  );

  it.effect("prefers the seeking profile's identity when both profiles are published", () =>
    Effect.gen(function* () {
      yield* insertUser("u-enq-both-owner", "both-owner@test.local");
      yield* insertUser("u-enq-both-sender", "both-sender@test.local");
      yield* insertSeeker("u-enq-both-sender", {
        name: "Both Seeking",
        contact: "both-seeking@example.test",
      });
      yield* insertLister(7105, "u-enq-both-sender", {
        name: "Both Listing",
        contact: "both-listing@example.test",
      });
      yield* insertListing(6114, "u-enq-both-owner", { status: "published" });
      const service = yield* EnquiryService;

      yield* service.send(userId("u-enq-both-sender"), listingId(6114), { message: "Hello" });

      const identity = yield* service.senderIdentityOf(userId("u-enq-both-sender"));
      assert.strictEqual(identity.name, "Both Seeking");
      assert.strictEqual(identity.contact, "both-seeking@example.test");

      const received = yield* service.listReceived(userId("u-enq-both-owner"));
      assert.strictEqual(received.items.length, 1);
      assert.strictEqual(received.items[0]?.senderName, "Both Seeking");
      assert.strictEqual(received.items[0]?.senderContact, "both-seeking@example.test");
    }),
  );

  it.effect("refuses a sender whose profile contact is blank and whose account has no email", () =>
    Effect.gen(function* () {
      yield* insertUser("u-enq-no-contact-owner", "no-contact-owner@test.local");
      yield* insertUser("u-enq-no-contact-sender", "   ");
      yield* insertSeeker("u-enq-no-contact-sender", { name: "Ada Seeker", contact: "   " });
      yield* insertListing(6111, "u-enq-no-contact-owner", { status: "published" });
      const service = yield* EnquiryService;

      const refused = yield* Effect.flip(
        service.send(userId("u-enq-no-contact-sender"), listingId(6111), {
          message: "Can you reply to this?",
        }),
      );
      assert.strictEqual(refused._tag, "EnquiryValidationError");
      if (refused._tag === "EnquiryValidationError") {
        assert.include(refused.message, "contact detail");
      }

      const received = yield* service.listReceived(userId("u-enq-no-contact-owner"));
      assert.strictEqual(received.items.length, 0);

      const identity = yield* service.senderIdentityOf(userId("u-enq-no-contact-sender"));
      assert.strictEqual(identity.name, "Ada Seeker");
      assert.strictEqual(identity.contact, null);
    }),
  );

  it.effect("sends with the profile contact line when the account has no email", () =>
    Effect.gen(function* () {
      yield* insertUser("u-enq-contact-only-owner", "contact-only-owner@test.local");
      yield* insertUser("u-enq-contact-only-sender", "\t");
      yield* insertSeeker("u-enq-contact-only-sender", {
        name: "Ada Seeker",
        contact: "ada@example.test",
      });
      yield* insertListing(6112, "u-enq-contact-only-owner", { status: "published" });
      const service = yield* EnquiryService;

      yield* service.send(userId("u-enq-contact-only-sender"), listingId(6112), {
        message: "Hello there",
      });

      const received = yield* service.listReceived(userId("u-enq-contact-only-owner"));
      assert.strictEqual(received.items.length, 1);
      assert.strictEqual(received.items[0]?.senderName, "Ada Seeker");
      assert.strictEqual(received.items[0]?.senderContact, "ada@example.test");
    }),
  );

  it.effect("bounds both lists and walks them with a cursor without gaps or repeats", () =>
    Effect.gen(function* () {
      yield* insertUser("u-enq-page-owner", "enq-page-owner@test.local");
      yield* insertUser("u-enq-page-sender", "enq-page-sender@test.local");
      yield* insertListing(6109, "u-enq-page-owner", { status: "published" });
      const total = ENQUIRY_PAGE_SIZE * 2 + 3;
      for (let index = 0; index < total; index += 1) {
        yield* insertEnquiry({
          listingId: 6109,
          senderId: "u-enq-page-sender",
          senderName: "enq-page-sender@test.local",
          senderContact: "enq-page-sender@test.local",
          message: `Page message ${index}`,
          createdAt: 1_700_000_000_000 + Math.floor(index / 3),
        });
      }
      const service = yield* EnquiryService;

      const sent: Array<number> = [];
      let sentCursor: KeysetCursor | undefined;
      do {
        const page = yield* service.listSent(userId("u-enq-page-sender"), sentCursor);
        assert.isAtMost(page.items.length, ENQUIRY_PAGE_SIZE);
        sent.push(...page.items.map((enquiry) => enquiry.id));
        sentCursor = page.nextCursor ?? undefined;
      } while (sentCursor !== undefined);

      const received: Array<number> = [];
      let receivedCursor: KeysetCursor | undefined;
      do {
        const page = yield* service.listReceived(userId("u-enq-page-owner"), receivedCursor);
        assert.isAtMost(page.items.length, ENQUIRY_PAGE_SIZE);
        received.push(...page.items.map((enquiry) => enquiry.id));
        receivedCursor = page.nextCursor ?? undefined;
      } while (receivedCursor !== undefined);

      for (const ids of [sent, received]) {
        assert.strictEqual(ids.length, total);
        assert.strictEqual(new Set(ids).size, total);
        assert.deepStrictEqual(
          ids,
          [...ids].sort((left, right) => right - left),
        );
      }
    }),
  );

  it.effect("reads a lister's published contact line, or nothing when they published none", () =>
    Effect.gen(function* () {
      yield* insertUser("u-enq-contact", "enq-contact@test.local");
      yield* insertLister(7102, "u-enq-contact", {
        name: "Ada Lets",
        contact: "lets@example.test",
      });
      yield* insertUser("u-enq-contact-empty", "enq-contact-empty@test.local");
      yield* insertLister(7103, "u-enq-contact-empty", { name: null, contact: null });
      const service = yield* EnquiryService;

      const published = yield* service.listerContactOf(userId("u-enq-contact"));
      assert.isTrue(Option.isSome(published));
      if (Option.isSome(published)) {
        assert.strictEqual(published.value.name, "Ada Lets");
        assert.strictEqual(published.value.contact, "lets@example.test");
      }

      const unpublished = yield* service.listerContactOf(userId("u-enq-contact-empty"));
      assert.isTrue(Option.isSome(unpublished));
      if (Option.isSome(unpublished)) {
        assert.isNull(unpublished.value.name);
        assert.isNull(unpublished.value.contact);
      }
    }),
  );
});
