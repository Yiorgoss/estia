import { GenderEnum, OwnershipEnum, UserRoles } from "@/db/schema/brands";
import { Schema, SchemaTransformation } from "effect";

/*
 * The two profile shapes a person fills in themselves. Registration opens both
 * rows from the account id alone, so everything here is a value supplied later;
 * these schemas are the HTTP boundary's contract for `PUT /api/users/profile`
 * and the decoded values are what the repository upserts take.
 *
 * The payload is one union rather than a role field: the server knows the
 * caller's role from the stored account, and the two shapes cannot be confused
 * because a seeking profile requires a date of birth and a gender while a
 * listing profile requires an ownership. A client never names the role.
 */

// A name is trimmed before it is bounded, so a padded name is stored trimmed and
// a whitespace-only one is rejected at the boundary.
const ProfileName = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString.check(Schema.isMaxLength(120)),
    SchemaTransformation.transform({
      decode: (value: string) => value.trim(),
      encode: (value: string) => value,
    }),
  ),
);

const ProfileBio = Schema.String.check(Schema.isMaxLength(2000));

/*
 * A seeking profile is only meaningful once it names a person of a known age and
 * gender, so those three are required. The bio and the two habit flags are the
 * extras a person may leave out.
 */
export const SeekerProfileInput = Schema.Struct({
  name: ProfileName,
  dateOfBirth: Schema.DateFromMillis,
  gender: GenderEnum,
  bio: Schema.optional(Schema.NullishOr(ProfileBio)),
  smoking: Schema.optional(Schema.BooleanFromBit),
  pets: Schema.optional(Schema.BooleanFromBit),
});
export type SeekerProfileInput = typeof SeekerProfileInput.Type;

// A listing profile says how the lister holds the place. A display name is
// optional: an account can post listings before it wants to be named.
export const ListerProfileInput = Schema.Struct({
  name: Schema.optional(Schema.NullishOr(ProfileName)),
  ownership: OwnershipEnum,
});
export type ListerProfileInput = typeof ListerProfileInput.Type;

export const ProfileInput = Schema.Union([SeekerProfileInput, ListerProfileInput]);
export type ProfileInput = typeof ProfileInput.Type;

// The roles that own a profile row. An admin has none, which is a readable
// refusal rather than a guessed profile. An unassigned account has none either,
// but it adopts one by naming the profile it wants, so the roles here are also
// the choices a switch can carry.
export const EditableProfileRoles = Schema.Literals(["seeker", "lister"]);
export type EditableProfileRole = typeof EditableProfileRoles.Type;

export const editableProfileRole = (
  role: typeof UserRoles.Type,
): EditableProfileRole | undefined => (role === "seeker" || role === "lister" ? role : undefined);

// The role an account with no profile yet adopts on its first switch, or the
// role an assigned account names to move to. Omitting it flips an assigned
// account to its other profile.
export const RoleSwitchQuery = Schema.Struct({
  role: Schema.optional(EditableProfileRoles),
});
export type RoleSwitchQuery = typeof RoleSwitchQuery.Type;
