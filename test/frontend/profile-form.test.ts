import {
  decodeListerProfileForm,
  decodeSeekerProfileForm,
  emptyProfileFormValues,
  isSeekerProfileComplete,
  profileFormValues,
  profileFormValuesFrom,
} from "@/frontend/profile-form";
import { profilePage } from "@/frontend/pages/profile";
import { SeekerSchema } from "@/db/schema/Seeker";
import { ListerSchema } from "@/db/schema/Lister";
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

/*
 * The form decoder is the bridge between what a browser submits (strings) and
 * what the user service takes (a date in millis, bit flags). These tests pin
 * that conversion, the readable rejection messages, and the states the page has
 * to render: incomplete, saved, and the other role's form.
 */

const seekerForm = (overrides: Record<string, string> = {}): Record<string, string> => ({
  name: "Ada Seeker",
  dateOfBirth: "1995-04-12",
  gender: "female",
  bio: "Looking for a quiet room",
  smoking: "true",
  ...overrides,
});

describe("decodeSeekerProfileForm", () => {
  it("converts the date to UTC midnight and the flags to bits", () => {
    const result = decodeSeekerProfileForm(seekerForm({ pets: "true" }));
    assert.isTrue(result.ok);
    if (!result.ok) return;

    assert.strictEqual(result.input.name, "Ada Seeker");
    assert.strictEqual(result.input.dateOfBirth.getTime(), Date.UTC(1995, 3, 12));
    assert.strictEqual(result.input.gender, "female");
    assert.strictEqual(result.input.bio, "Looking for a quiet room");
    assert.strictEqual(result.input.smoking, true);
    assert.strictEqual(result.input.pets, true);
  });

  it("treats a blank bio as absent and an unchecked box as off", () => {
    const result = decodeSeekerProfileForm(seekerForm({ bio: "   " }));
    assert.isTrue(result.ok);
    if (!result.ok) return;

    assert.isNull(result.input.bio);
    assert.strictEqual(result.input.smoking, true);
    assert.strictEqual(result.input.pets, false);
  });

  it("names each missing required field", () => {
    const noName = decodeSeekerProfileForm(seekerForm({ name: "  " }));
    assert.isFalse(noName.ok);
    if (noName.ok) return;
    assert.strictEqual(noName.message, "Enter your name.");

    const noDate = decodeSeekerProfileForm(seekerForm({ dateOfBirth: "" }));
    assert.isFalse(noDate.ok);
    if (noDate.ok) return;
    assert.strictEqual(noDate.message, "Enter your date of birth.");

    const noGender = decodeSeekerProfileForm(seekerForm({ gender: "" }));
    assert.isFalse(noGender.ok);
    if (noGender.ok) return;
    assert.strictEqual(noGender.message, "Choose your gender.");
  });

  it("rejects a day that does not exist and a malformed date", () => {
    const impossible = decodeSeekerProfileForm(seekerForm({ dateOfBirth: "1995-02-31" }));
    assert.isFalse(impossible.ok);
    if (impossible.ok) return;
    assert.strictEqual(impossible.message, "That is not a real date.");

    const malformed = decodeSeekerProfileForm(seekerForm({ dateOfBirth: "12/04/1995" }));
    assert.isFalse(malformed.ok);
    if (malformed.ok) return;
    assert.strictEqual(malformed.message, "Enter your date of birth as a calendar date.");
  });

  it("rejects a value the model does not carry, in the field's own words", () => {
    const badGender = decodeSeekerProfileForm(seekerForm({ gender: "alien" }));
    assert.isFalse(badGender.ok);
    if (badGender.ok) return;
    assert.strictEqual(badGender.message, "Choose your gender.");

    const longName = decodeSeekerProfileForm(seekerForm({ name: "a".repeat(121) }));
    assert.isFalse(longName.ok);
    if (longName.ok) return;
    assert.strictEqual(longName.message, "Enter your name, up to 120 characters.");
  });
});

describe("decodeListerProfileForm", () => {
  it("keeps a display name that was typed and turns a blank one into null", () => {
    const named = decodeListerProfileForm({ name: "Ada Lets", ownership: "leaseholder" });
    assert.isTrue(named.ok);
    if (!named.ok) return;
    assert.strictEqual(named.input.name, "Ada Lets");
    assert.strictEqual(named.input.ownership, "leaseholder");

    const blank = decodeListerProfileForm({ name: "  ", ownership: "owner" });
    assert.isTrue(blank.ok);
    if (!blank.ok) return;
    assert.isNull(blank.input.name);
  });

  it("requires an ownership and names it when it is missing", () => {
    const missing = decodeListerProfileForm({ name: "Ada Lets", ownership: "" });
    assert.isFalse(missing.ok);
    if (missing.ok) return;
    assert.strictEqual(missing.message, "Choose whether you own the place or hold its lease.");

    const unknown = decodeListerProfileForm({ name: "Ada Lets", ownership: "landlord" });
    assert.isFalse(unknown.ok);
    if (unknown.ok) return;
    assert.strictEqual(unknown.message, "Choose whether you own the place or hold its lease.");
  });
});

describe("profile form values", () => {
  it("pre-fills a seeking row and leaves a missing row blank", () => {
    const values = profileFormValuesFrom(
      Schema.decodeUnknownSync(SeekerSchema)({
        id: 1,
        userId: "u-1",
        name: "Ada Seeker",
        contact: null,
        bio: null,
        dateOfBirth: Date.UTC(1995, 3, 12),
        gender: "female",
        smoking: 1,
        pets: 0,
        createdAt: 0,
      }),
    );

    assert.strictEqual(values.name, "Ada Seeker");
    assert.strictEqual(values.dateOfBirth, "1995-04-12");
    assert.strictEqual(values.gender, "female");
    assert.strictEqual(values.bio, "");
    assert.strictEqual(values.smoking, true);
    assert.deepStrictEqual(profileFormValuesFrom(null), emptyProfileFormValues);
  });

  it("pre-fills a listing row with its ownership", () => {
    const values = profileFormValuesFrom(
      Schema.decodeUnknownSync(ListerSchema)({
        id: 1,
        userId: "u-1",
        name: "Ada Lets",
        contact: "ada@example.test",
        ownership: "leaseholder",
        createdAt: 0,
      }),
    );

    assert.strictEqual(values.name, "Ada Lets");
    assert.strictEqual(values.contact, "ada@example.test");
    assert.strictEqual(values.ownership, "leaseholder");
  });

  it("reads the submitted fields back into the form's values", () => {
    const values = profileFormValues(seekerForm({ smoking: "", pets: "true" }));
    assert.strictEqual(values.dateOfBirth, "1995-04-12");
    assert.strictEqual(values.smoking, false);
    assert.strictEqual(values.pets, true);
  });

  it("calls a seeking profile complete only with a name, a birth date and a gender", () => {
    assert.isTrue(isSeekerProfileComplete(profileFormValues(seekerForm())));
    assert.isFalse(isSeekerProfileComplete(profileFormValues(seekerForm({ gender: "" }))));
    assert.isFalse(isSeekerProfileComplete(profileFormValues(seekerForm({ name: "  " }))));
  });
});

describe("profilePage", () => {
  it("marks an empty seeking profile incomplete and offers the switch", () => {
    const html = profilePage({ role: "seeker", values: emptyProfileFormValues });

    assert.include(html, "Your seeking profile is incomplete");
    assert.include(html, "Add your name, date of birth and gender");
    assert.include(html, 'action="/profile"');
    assert.include(html, "Switch to my listing profile");
    assert.include(
      html,
      "Shown to a lister when you send them an enquiry. Your account email is shown instead when this is empty.",
    );
    assert.notInclude(html, "Your profile was saved.");
  });

  it("drops the incomplete notice once the required fields are in place and shows a save", () => {
    const html = profilePage({
      role: "seeker",
      values: profileFormValues(seekerForm()),
      saved: true,
    });

    assert.notInclude(html, "Your seeking profile is incomplete");
    assert.include(html, "Your profile was saved.");
    assert.include(html, 'value="Ada Seeker"');
  });

  it("shows the listing form with its ownership and the saved error", () => {
    const html = profilePage({
      role: "lister",
      values: profileFormValues({ name: "Ada Lets", ownership: "owner" }),
      error: "Choose whether you own the place or hold its lease.",
    });

    assert.include(html, "Listing profile");
    assert.include(html, '<option value="owner" selected>');
    assert.include(html, "Switch to my seeking profile");
    assert.include(html, "Choose whether you own the place or hold its lease.");
    // A listing profile has no seeking fields to offer.
    assert.notInclude(html, 'name="dateOfBirth"');
    assert.notInclude(html, 'name="bio"');
  });

  it("escapes everything it echoes back", () => {
    const html = profilePage({
      role: "seeker",
      values: profileFormValues(
        seekerForm({ name: '<script>alert("x")</script>', bio: "<b>bold</b>" }),
      ),
    });

    assert.notInclude(html, '<script>alert("x")</script>');
    assert.notInclude(html, "<b>bold</b>");
    assert.include(html, "&lt;script&gt;");
    assert.include(html, "&lt;b&gt;bold&lt;/b&gt;");
  });
});
