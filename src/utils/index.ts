export const toHex = (uInt8Arr: Uint8Array) => {
  return Array.from(uInt8Arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const htmlEscapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Listing content is user input, so anything interpolated into server-rendered
// HTML has to go through this first.
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => htmlEscapes[char] ?? char);

// An HTML form submits every named field, empty ones included, and `""` is not
// a valid numeric bound to the query schemas (it is a bad request). Dropping
// empty values keeps an untouched "max price" box from failing the search.
export const omitEmptySearchParams = (
  params: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
) => {
  const kept: Record<string, string | ReadonlyArray<string>> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    kept[key] = value;
  }
  return kept;
};

// Listing prices are stored in minor units; a whole price shows no decimals and
// a price with cents shows exactly two, so a card never reads "€455.5".
export const formatPriceMinor = (priceMinor: number) =>
  `€${(priceMinor / 100).toLocaleString("en-GB", {
    minimumFractionDigits: priceMinor % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;

/*
 * The search form collects euros, while the listings API filters on minor
 * units. Converting here keeps the form's units a presentation concern and the
 * API contract in one unit. A value that is not a plain finite number is passed
 * through unchanged, so the query codec still rejects it instead of the
 * conversion turning it into `0`.
 */
export const withMinorUnitPrices = (
  params: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
) => {
  const converted: Record<string, string | ReadonlyArray<string>> = {
    ...omitEmptySearchParams(params),
  };
  const toMinor = (value: string | ReadonlyArray<string>) => {
    if (typeof value !== "string" || value.trim() === "") return String(value);
    const euros = Number(value);
    return Number.isFinite(euros) ? String(Math.round(euros * 100)) : value;
  };

  if (converted.minPrice !== undefined) {
    converted.minPriceMinor = toMinor(converted.minPrice);
    delete converted.minPrice;
  }
  if (converted.maxPrice !== undefined) {
    converted.maxPriceMinor = toMinor(converted.maxPrice);
    delete converted.maxPrice;
  }
  return converted;
};

export const formatDate = (date: Date | null | undefined) =>
  date == null
    ? null
    : date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });

// An enquiry is read with a time attached, not just a day: two messages on the
// same afternoon are told apart. UTC keeps the server-rendered page stable
// wherever it is read.
export const formatDateTime = (date: Date | null | undefined) =>
  date == null
    ? null
    : date.toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
        timeZoneName: "short",
      });
