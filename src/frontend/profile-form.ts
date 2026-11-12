import { ListerProfileInput, SeekerProfileInput } from "@/db/schema/Profile";
import { ListerSchema } from "@/db/schema/Lister";
import { SeekerSchema } from "@/db/schema/Seeker";
import { Result, Schema, SchemaIssue } from "effect";

/*
 * The profile pages collect plain strings, while the model stores a date as
 * epoch millis and the flags as `0`/`1` bits. This module turns a submitted form
 * into the typed input the user service takes, and turns a failure into the
 * message the page shows. Both decoders end in the same boundary schemas the
 * JSON API decodes, so the page and the API cannot drift from each other's
 * limits.
 */

// An HTML form submits every named field, so absent and blank are the same
// thing here. A repeated field keeps its first value.
export type ProfileFormParams = Readonly<
  Record<string, string | ReadonlyArray<string> | undefined>
>;

export interface ProfileFormValues {
  readonly name: string;
  readonly dateOfBirth: string;
  readonly gender: string;
  readonly bio: string;
  readonly contact: string;
  readonly smoking: boolean;
  readonly pets: boolean;
  readonly ownership: string;
}

export const emptyProfileFormValues: ProfileFormValues = {
  name: "",
  dateOfBirth: "",
  gender: "",
  bio: "",
  contact: "",
  smoking: false,
  pets: false,
  ownership: "",
};

export type ProfileFormResult<A> =
  | { readonly ok: true; readonly input: A }
  | { readonly ok: false; readonly message: string };

const text = (params: ProfileFormParams, name: string): string => {
  const value = params[name];
  if (typeof value === "string") return value;
  return Array.isArray(value) ? (value[0] ?? "") : "";
};

const checked = (params: ProfileFormParams, name: string): boolean => text(params, name) === "true";

const bit = (on: boolean): 0 | 1 => (on ? 1 : 0);

export const profileFormValues = (params: ProfileFormParams): ProfileFormValues => ({
  name: text(params, "name"),
  dateOfBirth: text(params, "dateOfBirth"),
  gender: text(params, "gender"),
  bio: text(params, "bio"),
  contact: text(params, "contact"),
  smoking: checked(params, "smoking"),
  pets: checked(params, "pets"),
  ownership: text(params, "ownership"),
});

// A date input is a wall-clock day, not an instant; the model stores UTC
// midnight so the day a reader sees does not shift with their timezone.
const dateValue = (date: Date | null | undefined): string =>
  date == null ? "" : date.toISOString().slice(0, 10);

// The form is pre-filled from the stored row, or left blank when a legacy
// account's row does not exist yet.
export const profileFormValuesFrom = (
  profile: typeof SeekerSchema.Type | typeof ListerSchema.Type | null,
): ProfileFormValues => {
  if (profile === null) return emptyProfileFormValues;
  if ("ownership" in profile) {
    return {
      ...emptyProfileFormValues,
      name: profile.name ?? "",
      contact: profile.contact ?? "",
      ownership: profile.ownership,
    };
  }
  return {
    name: profile.name ?? "",
    dateOfBirth: dateValue(profile.dateOfBirth),
    gender: profile.gender ?? "",
    bio: profile.bio ?? "",
    contact: profile.contact ?? "",
    smoking: profile.smoking,
    pets: profile.pets,
    ownership: "",
  };
};

// The required fields a seeking profile needs before it describes a person.
// The page uses this for its incomplete notice and the same three fields are
// what the decoder refuses to save without.
export const isSeekerProfileComplete = (values: ProfileFormValues): boolean =>
  values.name.trim() !== "" && values.dateOfBirth.trim() !== "" && values.gender.trim() !== "";

interface FormFailure {
  readonly message: string;
}

const invalid = (message: string): FormFailure => ({ message });

const dateOfBirthMillis = (raw: string): Result.Result<number, FormFailure> => {
  const trimmed = raw.trim();
  if (trimmed === "") return Result.fail(invalid("Enter your date of birth."));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return Result.fail(invalid("Enter your date of birth as a calendar date."));
  }
  const millis = Date.parse(`${trimmed}T00:00:00.000Z`);
  // A day that does not exist - 31 February - is only caught by asking the date
  // it became, because the parser silently rolls it into the next month.
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== trimmed) {
    return Result.fail(invalid("That is not a real date."));
  }
  return Result.succeed(millis);
};

// An emptiable box is an absence: the contact line is only published when the
// person typed something into it.
const contactOrNull = (raw: string): string | null => {
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
};

/*
 * The schema reports the limits the form does not parse itself (trimmed names,
 * their length, the controlled gender and ownership sets). Naming the field it
 * rejected keeps that failure readable instead of echoing the decoder's
 * technical message.
 */
const seekerFieldMessages: Record<string, string> = {
  name: "Enter your name, up to 120 characters.",
  dateOfBirth: "Enter your date of birth as a calendar date.",
  gender: "Choose your gender.",
  bio: "Keep the bio to 2000 characters or fewer.",
  contact: "Keep your contact details to 200 characters or fewer.",
};

const listerFieldMessages: Record<string, string> = {
  name: "Keep the display name to 120 characters or fewer.",
  ownership: "Choose whether you own the place or hold its lease.",
  contact: "Keep your contact details to 200 characters or fewer.",
};

const issueFields = (issue: SchemaIssue.Issue): ReadonlyArray<string> => {
  switch (issue._tag) {
    case "Pointer": {
      const nested = issueFields(issue.issue);
      return nested.length === 0 ? [String(issue.path[0])] : nested;
    }
    case "Composite":
      return issue.issues.flatMap(issueFields);
    default:
      return [];
  }
};

const schemaFailure = (
  decoderError: Schema.SchemaError,
  fieldMessages: Record<string, string>,
): FormFailure => {
  const messages = [
    ...new Set(
      issueFields(decoderError.issue).map((field) => fieldMessages[field] ?? `Check ${field}.`),
    ),
  ];
  return invalid(messages.length === 0 ? "Check the form and try again." : messages.join(" "));
};

const finish = <A>(result: Result.Result<A, FormFailure>): ProfileFormResult<A> =>
  Result.match(result, {
    onSuccess: (input) => ({ ok: true as const, input }),
    onFailure: ({ message }) => ({ ok: false as const, message }),
  });

/*
 * The seeking form. Name, date of birth and gender are required because a
 * seeking profile without them says nothing about the person; the bio and the
 * two habit boxes stay optional and default to absent and off.
 */
export const decodeSeekerProfileForm = (
  params: ProfileFormParams,
): ProfileFormResult<typeof SeekerProfileInput.Type> =>
  finish(
    Result.gen(function* () {
      const name = text(params, "name");
      if (name.trim() === "") return yield* Result.fail(invalid("Enter your name."));

      const gender = text(params, "gender");
      if (gender.trim() === "") return yield* Result.fail(invalid("Choose your gender."));

      const dateOfBirth = yield* dateOfBirthMillis(text(params, "dateOfBirth"));
      const bio = text(params, "bio");

      const decoded = Schema.decodeUnknownResult(SeekerProfileInput)({
        name,
        dateOfBirth,
        gender,
        bio: bio.trim() === "" ? null : bio,
        contact: contactOrNull(text(params, "contact")),
        smoking: bit(checked(params, "smoking")),
        pets: bit(checked(params, "pets")),
      });
      return yield* Result.mapError(decoded, (failure) =>
        schemaFailure(failure, seekerFieldMessages),
      );
    }),
  );

// The listing form: the ownership is the one thing a listing profile must say,
// and the display name may stay empty.
export const decodeListerProfileForm = (
  params: ProfileFormParams,
): ProfileFormResult<typeof ListerProfileInput.Type> =>
  finish(
    Result.gen(function* () {
      const ownership = text(params, "ownership");
      if (ownership.trim() === "") {
        return yield* Result.fail(invalid("Choose whether you own the place or hold its lease."));
      }
      const name = text(params, "name");

      const decoded = Schema.decodeUnknownResult(ListerProfileInput)({
        name: name.trim() === "" ? null : name,
        ownership,
        contact: contactOrNull(text(params, "contact")),
      });
      return yield* Result.mapError(decoded, (failure) =>
        schemaFailure(failure, listerFieldMessages),
      );
    }),
  );
