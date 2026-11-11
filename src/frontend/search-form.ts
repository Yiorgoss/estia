import type { SavedSearch } from "@/db/schema/SavedSearch";

/*
 * The values the search form shows. Every field is a string because that is what
 * an input holds; converting the saved search's minor units and dates here keeps
 * the page template free of that arithmetic.
 */
export interface SearchFormValues {
  readonly query: string;
  readonly regionCode: string;
  readonly kind: string;
  readonly minPrice: string;
  readonly maxPrice: string;
  readonly minSizeSqm: string;
  readonly maxSizeSqm: string;
  readonly availableFrom: string;
  readonly furnished: boolean;
  readonly ensuite: boolean;
  readonly smoking: boolean;
  readonly pets: boolean;
}

export const emptySearchFormValues: SearchFormValues = {
  query: "",
  regionCode: "",
  kind: "",
  minPrice: "",
  maxPrice: "",
  minSizeSqm: "",
  maxSizeSqm: "",
  availableFrom: "",
  furnished: false,
  ensuite: false,
  smoking: false,
  pets: false,
};

// A whole price shows no decimals and a price with cents keeps them, so the
// saved 120050 euro-cents reads back as "1200.5" in the form that wrote it.
const eurosFromMinor = (value: number): string => String(value / 100);

const textFromNumber = (value: number | null | undefined): string =>
  value == null ? "" : String(value);

// A date input only accepts `YYYY-MM-DD`, so the stored instant is cut to its
// UTC day exactly as the form submitted it.
const dateInputValue = (value: Date | null | undefined): string =>
  value == null ? "" : value.toISOString().slice(0, 10);

export const searchFormValuesFromSavedSearch = (saved: SavedSearch): SearchFormValues => ({
  query: saved.query ?? "",
  regionCode: saved.regionCode ?? "",
  kind: saved.kind ?? "",
  minPrice: saved.minPriceMinor == null ? "" : eurosFromMinor(saved.minPriceMinor),
  maxPrice: saved.maxPriceMinor == null ? "" : eurosFromMinor(saved.maxPriceMinor),
  minSizeSqm: textFromNumber(saved.minSizeSqm),
  maxSizeSqm: textFromNumber(saved.maxSizeSqm),
  availableFrom: dateInputValue(saved.availableFrom),
  furnished: saved.furnished === true,
  ensuite: saved.ensuite === true,
  smoking: saved.smoking === true,
  pets: saved.pets === true,
});
