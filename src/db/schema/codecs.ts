import { Schema, SchemaTransformation } from "effect";

/*
 * Codecs for values that arrive as strings. Query parameters and form fields
 * are always transported as strings, so schemas used for them must encode to a
 * string as well. `Schema.BooleanFromBit` covers the `0 | 1` database flags but
 * has no string form, hence this one.
 */
export const BooleanFromString: Schema.Codec<boolean, string> = Schema.Literals([
  "true",
  "false",
]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (value) => value === "true",
      encode: (value) => (value ? "true" : "false"),
    }),
  ),
);

/*
 * `Schema.FiniteFromString` coerces with JavaScript's `Number`, which turns a
 * blank string into `0`. A filter is either present with a value or absent, so
 * a blank parameter is rejected instead of silently becoming zero.
 */
export const NonBlankFiniteFromString: Schema.Codec<number, string> = Schema.String.check(
  Schema.isPattern(/\S/),
).pipe(Schema.decodeTo(Schema.Finite, SchemaTransformation.numberFromString));
