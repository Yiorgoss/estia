import { CreateListingInput, ListingSchema, UpdateListingInput } from "@/db/schema/Listing";
import { Result, Schema, SchemaIssue } from "effect";

/*
 * The listing forms collect plain strings, while the model stores the units the
 * database does: prices in minor units, dates as epoch millis, flags as `0`/`1`
 * bits. This module turns a submitted form into the typed input the listing
 * service takes, and turns a failure into the message the page shows. Create and
 * edit share it so both read a form the same way, and the result is decoded
 * through the same `CreateListingInput`/`UpdateListingInput` schemas the JSON API
 * uses, so neither surface can drift from the other's limits.
 */

// An HTML form submits every named field, so absent and blank are the same
// thing here. A repeated field keeps its first value.
export type ListingFormParams = Readonly<
  Record<string, string | ReadonlyArray<string> | undefined>
>;

export interface ListingFormValues {
  readonly kind: string;
  readonly title: string;
  readonly description: string;
  readonly priceEuros: string;
  readonly regionCode: string;
  readonly sizeSqm: string;
  readonly availableFrom: string;
  readonly furnished: boolean;
  readonly ensuite: boolean;
  readonly smoking: boolean;
  readonly pets: boolean;
  readonly lat: string;
  readonly lng: string;
}

export const emptyListingFormValues: ListingFormValues = {
  kind: "",
  title: "",
  description: "",
  priceEuros: "",
  regionCode: "",
  sizeSqm: "",
  availableFrom: "",
  furnished: false,
  ensuite: false,
  smoking: false,
  pets: false,
  lat: "",
  lng: "",
};

export type ListingFormResult<A> =
  | { readonly ok: true; readonly input: A }
  | { readonly ok: false; readonly message: string };

const text = (params: ListingFormParams, name: string): string => {
  const value = params[name];
  if (typeof value === "string") return value;
  return Array.isArray(value) ? (value[0] ?? "") : "";
};

const checked = (params: ListingFormParams, name: string): boolean => text(params, name) === "true";

const bit = (on: boolean): 0 | 1 => (on ? 1 : 0);

export const listingFormValues = (params: ListingFormParams): ListingFormValues => ({
  kind: text(params, "kind"),
  title: text(params, "title"),
  description: text(params, "description"),
  priceEuros: text(params, "price"),
  regionCode: text(params, "regionCode"),
  sizeSqm: text(params, "sizeSqm"),
  availableFrom: text(params, "availableFrom"),
  furnished: checked(params, "furnished"),
  ensuite: checked(params, "ensuite"),
  smoking: checked(params, "smoking"),
  pets: checked(params, "pets"),
  lat: text(params, "lat"),
  lng: text(params, "lng"),
});

// The edit page shows the stored price exactly (a row with cents reads "45.5"),
// while the form asks for whole euros: nothing is silently rounded away.
const eurosOf = (priceMinor: number): string => String(priceMinor / 100);

const dateValue = (date: Date | null | undefined): string =>
  date == null ? "" : date.toISOString().slice(0, 10);

export const listingFormValuesFor = (listing: typeof ListingSchema.Type): ListingFormValues => ({
  kind: listing.kind,
  title: listing.title,
  description: listing.description ?? "",
  priceEuros: eurosOf(listing.priceMinor),
  regionCode: listing.regionCode,
  sizeSqm: listing.sizeSqm == null ? "" : String(listing.sizeSqm),
  availableFrom: dateValue(listing.availableFrom),
  furnished: listing.furnished,
  ensuite: listing.ensuite,
  smoking: listing.smoking,
  pets: listing.pets,
  lat: listing.lat == null ? "" : String(listing.lat),
  lng: listing.lng == null ? "" : String(listing.lng),
});

interface FormFailure {
  readonly message: string;
}

const invalid = (message: string): FormFailure => ({ message });

const wholeEurosToMinor = (raw: string): Result.Result<number, FormFailure> => {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return Result.fail(invalid("Enter the price in whole euros, for example 750."));
  }
  const euros = Number(trimmed);
  if (!Number.isSafeInteger(euros * 100)) {
    return Result.fail(invalid("That price is too large."));
  }
  return Result.succeed(euros * 100);
};

const sizeFrom = (raw: string): Result.Result<number | null, FormFailure> => {
  const trimmed = raw.trim();
  if (trimmed === "") return Result.succeed(null);
  if (!/^\d+$/.test(trimmed)) {
    return Result.fail(invalid("Enter the size in whole square metres, for example 35."));
  }
  const size = Number(trimmed);
  if (!Number.isSafeInteger(size) || size <= 0) {
    return Result.fail(invalid("The size must be a whole number of square metres above zero."));
  }
  return Result.succeed(size);
};

const availableFromMillis = (raw: string): Result.Result<number | null, FormFailure> => {
  const trimmed = raw.trim();
  if (trimmed === "") return Result.succeed(null);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return Result.fail(invalid("Enter the availability date as a calendar date."));
  }
  // A date input is a wall-clock day, not an instant; the model stores a UTC
  // midnight so the day a reader sees does not shift with their timezone.
  const millis = Date.parse(`${trimmed}T00:00:00.000Z`);
  if (!Number.isFinite(millis)) {
    return Result.fail(invalid("That is not a real date."));
  }
  return Result.succeed(millis);
};

const coordinate = (raw: string, label: string): Result.Result<number, FormFailure> => {
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(value)) {
    return Result.fail(invalid(`Enter ${label} as a number, for example 37.98.`));
  }
  return Result.succeed(value);
};

// Coordinates are optional display data, but only as a pair: half a point is a
// mistake, so it is rejected rather than guessed. Whether the pair is inside
// Greece is the listing service's rule, so its 422 is what the page reports.
const coordinates = (
  latRaw: string,
  lngRaw: string,
): Result.Result<{ readonly lat: number | null; readonly lng: number | null }, FormFailure> => {
  if (latRaw.trim() === "" && lngRaw.trim() === "") {
    return Result.succeed({ lat: null, lng: null });
  }
  if (latRaw.trim() === "" || lngRaw.trim() === "") {
    return Result.fail(invalid("Enter both latitude and longitude, or neither."));
  }
  return Result.gen(function* () {
    const lat = yield* coordinate(latRaw, "latitude");
    const lng = yield* coordinate(lngRaw, "longitude");
    return { lat, lng };
  });
};

/*
 * The schema reports limits the form does not parse itself (the title's trim and
 * length, the description's cap, the controlled region set). Naming the field it
 * rejected keeps that failure readable instead of echoing the decoder's
 * technical message.
 */
const fieldMessages: Record<string, string> = {
  kind: "Choose what kind of listing this is.",
  title: "The title must be between 1 and 120 characters.",
  description: "Keep the description to 5000 characters or fewer.",
  priceMinor: "Enter the price in whole euros, for example 750.",
  regionCode: "Choose one of the 13 Greek regions.",
  sizeSqm: "The size must be a whole number of square metres above zero.",
  availableFrom: "Enter the availability date as a calendar date.",
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

const schemaFailure = (error: Schema.SchemaError): FormFailure => {
  const messages = [
    ...new Set(issueFields(error.issue).map((field) => fieldMessages[field] ?? `Check ${field}.`)),
  ];
  return invalid(messages.length === 0 ? "Check the form and try again." : messages.join(" "));
};

const sharedFields = (
  params: ListingFormParams,
): Result.Result<Record<string, unknown>, FormFailure> =>
  Result.gen(function* () {
    const priceMinor = yield* wholeEurosToMinor(text(params, "price"));
    const sizeSqm = yield* sizeFrom(text(params, "sizeSqm"));
    const availableFrom = yield* availableFromMillis(text(params, "availableFrom"));
    const location = yield* coordinates(text(params, "lat"), text(params, "lng"));
    const description = text(params, "description");
    return {
      title: text(params, "title"),
      description: description.trim() === "" ? null : description,
      priceMinor,
      regionCode: text(params, "regionCode"),
      sizeSqm,
      availableFrom,
      furnished: bit(checked(params, "furnished")),
      ensuite: bit(checked(params, "ensuite")),
      smoking: bit(checked(params, "smoking")),
      pets: bit(checked(params, "pets")),
      lat: location.lat,
      lng: location.lng,
    };
  });

const finish = <A>(result: Result.Result<A, FormFailure>): ListingFormResult<A> =>
  Result.match(result, {
    onSuccess: (input) => ({ ok: true as const, input }),
    onFailure: ({ message }) => ({ ok: false as const, message }),
  });

export const decodeCreateListingForm = (
  params: ListingFormParams,
): ListingFormResult<typeof CreateListingInput.Type> =>
  finish(
    Result.gen(function* () {
      const shared = yield* sharedFields(params);
      const decoded = Schema.decodeUnknownResult(CreateListingInput)({
        ...shared,
        kind: text(params, "kind"),
      });
      return yield* Result.mapError(decoded, schemaFailure);
    }),
  );

export const decodeUpdateListingForm = (
  params: ListingFormParams,
): ListingFormResult<typeof UpdateListingInput.Type> =>
  finish(
    Result.gen(function* () {
      const shared = yield* sharedFields(params);
      // The edit form shows every field, so a save replaces all of them rather
      // than merging: clearing a box clears the column.
      return yield* Result.mapError(
        Schema.decodeUnknownResult(UpdateListingInput)(shared),
        schemaFailure,
      );
    }),
  );
