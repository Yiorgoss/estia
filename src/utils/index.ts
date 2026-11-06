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

// Room listings are user input, so anything interpolated into server-rendered
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

export const formatPrice = (price: number) => `€${price.toLocaleString("en-GB")}`;

export const formatDate = (date: Date | null | undefined) =>
  date == null
    ? null
    : date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
