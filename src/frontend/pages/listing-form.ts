import { GreekRegionCodes, ListingKind, ListingSchema } from "@/db/schema/Listing";
import { head } from "@/frontend/head";
import { header } from "@/frontend/header";
import type { ListingFormValues } from "@/frontend/listing-form";
import { kindLabels, regionLabels, statusLabels } from "@/frontend/listing-labels";
import { canTransition } from "@/services/listing.service";
import { escapeHtml } from "@/utils";

/*
 * The create and edit pages are server-rendered forms: the browser posts the
 * fields back here, the route runs the same listing service the JSON API uses,
 * and a failure is answered with this page again carrying the reason. That keeps
 * a bad submit readable - a blank page or a JSON blob would not be.
 *
 * Anything a listing supplied is escaped: titles, descriptions, and the values
 * echoed back into a rejected form are all user input.
 */

const labelClass = "mb-1 block text-sm font-medium text-gray-700";
const inputClass =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500";
const selectClass =
  "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500";
const hintClass = "mt-1 text-xs text-gray-500";
const primaryButtonClass =
  "rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2";
const secondaryButtonClass =
  "rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50";

const field = (name: string, label: string, control: string, hint?: string) => `
  <div>
    <label for="${name}" class="${labelClass}">${label}</label>
    ${control}
    ${hint === undefined ? "" : `<p class="${hintClass}">${hint}</p>`}
  </div>`;

const textInput = (
  name: string,
  options: { readonly value: string; readonly placeholder?: string; readonly required?: boolean },
) => `<input
      id="${name}"
      name="${name}"
      type="text"
      value="${escapeHtml(options.value)}"
      ${options.placeholder === undefined ? "" : `placeholder="${escapeHtml(options.placeholder)}"`}
      ${options.required === true ? "required" : ""}
      class="${inputClass}"
    />`;

const numberInput = (
  name: string,
  options: {
    readonly value: string;
    readonly min: string;
    readonly step: string;
    readonly placeholder?: string;
    readonly required?: boolean;
  },
) => `<input
      id="${name}"
      name="${name}"
      type="number"
      value="${escapeHtml(options.value)}"
      min="${options.min}"
      step="${options.step}"
      ${options.placeholder === undefined ? "" : `placeholder="${escapeHtml(options.placeholder)}"`}
      ${options.required === true ? "required" : ""}
      class="${inputClass}"
    />`;

// A size is a whole number of square metres above zero, and the shared size
// schema forbids the same values.
const optionalNumber = (name: string, value: string, placeholder: string) =>
  numberInput(name, { value, min: "0", step: "1", placeholder });

// A coordinate may be negative, and where it falls is the service's decision, so
// the input is a plain number: a `min` here would only hide the honest answer
// behind a browser tooltip.
const coordinateInput = (name: string, value: string, placeholder: string) => `
  <input
    id="${name}"
    name="${name}"
    type="number"
    value="${escapeHtml(value)}"
    step="any"
    placeholder="${escapeHtml(placeholder)}"
    class="${inputClass}"
  />`;

const checkbox = (name: string, label: string, checked: boolean) => `
  <label class="flex items-center gap-2 text-sm text-gray-700">
    <input
      type="checkbox"
      name="${name}"
      value="true"
      ${checked ? "checked" : ""}
      class="size-4 accent-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
    />
    ${label}
  </label>`;

export const listingErrorBanner = (message: string | undefined) =>
  message === undefined
    ? ""
    : `<p class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">${escapeHtml(message)}</p>`;

const regionOptions = GreekRegionCodes.map((code) => ({
  value: code,
  label: regionLabels[code],
}));

const kindOptions = ListingKind.literals.map((kind) => ({
  value: kind,
  label: kindLabels[kind],
}));

const kindField = (values: ListingFormValues) => `
  <div>
    <label for="kind" class="${labelClass}">Kind</label>
    <select id="kind" name="kind" required class="${selectClass}">
      <option value="">Choose a kind</option>
      ${kindOptions
        .map(
          (option) =>
            `<option value="${option.value}" ${option.value === values.kind ? "selected" : ""}>${option.label}</option>`,
        )
        .join("")}
    </select>
  </div>`;

// A listing does not change what it is, so the edit page shows the kind instead
// of offering it.
const lockedKindField = (kind: string) => {
  const label = kindLabels[kind as ListingKind] ?? kind;
  return `
  <div>
    <span class="${labelClass}">Kind</span>
    <p class="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">${escapeHtml(label)}</p>
    <p class="${hintClass}">A listing does not change what it is.</p>
  </div>`;
};

export const listingFields = (
  values: ListingFormValues,
  options: { readonly kindLocked: boolean },
) => `
  <div class="grid gap-4 sm:grid-cols-2">
    ${options.kindLocked ? lockedKindField(values.kind) : kindField(values)}
    ${field(
      "regionCode",
      "Region",
      `<select id="regionCode" name="regionCode" required class="${selectClass}">
        <option value="">Choose a region</option>
        ${regionOptions
          .map(
            (option) =>
              `<option value="${option.value}" ${option.value === values.regionCode ? "selected" : ""}>${option.label}</option>`,
          )
          .join("")}
      </select>`,
    )}
  </div>

  <div class="mt-4">
    ${field(
      "title",
      "Title",
      textInput("title", {
        value: values.title,
        required: true,
        placeholder: "Sunny room near the port",
      }),
    )}
  </div>

  <div class="mt-4">
    <label for="description" class="${labelClass}">Description</label>
    <textarea
      id="description"
      name="description"
      rows="4"
      class="${inputClass}"
    >${escapeHtml(values.description)}</textarea>
  </div>

  <div class="mt-4 grid gap-4 sm:grid-cols-3">
    ${field(
      "price",
      "Price (€)",
      numberInput("price", {
        value: values.priceEuros,
        min: "0",
        step: "0.01",
        placeholder: "750",
        required: true,
      }),
      "Euros per month, up to two decimal places.",
    )}
    ${field("sizeSqm", "Size (m²)", optionalNumber("sizeSqm", values.sizeSqm, "35"))}
    ${field(
      "availableFrom",
      "Available from",
      `<input id="availableFrom" name="availableFrom" type="date" value="${escapeHtml(values.availableFrom)}" class="${inputClass}" />`,
    )}
  </div>

  <fieldset class="mt-4">
    <legend class="${labelClass}">Details</legend>
    <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      ${checkbox("furnished", "Furnished", values.furnished)}
      ${checkbox("ensuite", "Ensuite", values.ensuite)}
      ${checkbox("smoking", "Smoking allowed", values.smoking)}
      ${checkbox("pets", "Pets allowed", values.pets)}
    </div>
  </fieldset>

  <fieldset class="mt-4">
    <legend class="${labelClass}">Location on the map</legend>
    <div class="grid gap-4 sm:grid-cols-2">
      ${field("lat", "Latitude", coordinateInput("lat", values.lat, "37.98"))}
      ${field("lng", "Longitude", coordinateInput("lng", values.lng, "23.72"))}
    </div>
    <p class="${hintClass}">Optional, but enter both or neither. The point must be inside Greece.</p>
  </fieldset>`;

const pageShell = (title: string, content: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  ${head}
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body class="min-h-lvh bg-gray-50">
  ${header}
  <main class="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
    ${content}
  </main>
</body>
</html>
`;

export const newListingPage = (values: ListingFormValues, error?: string) =>
  pageShell(
    "New listing",
    `
    <h1 class="text-2xl font-semibold text-gray-900">Post a listing</h1>
    <p class="mt-1 text-sm text-gray-600">
      A new listing starts as a draft, so you can correct it before anyone else sees it.
    </p>

    <div class="mt-4 space-y-4">
      ${listingErrorBanner(error)}
    </div>

    <form
      method="post"
      action="/listings/new"
      class="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
    >
      ${listingFields(values, { kindLocked: false })}

      <div class="mt-6 flex flex-wrap items-center gap-3">
        <button type="submit" class="${primaryButtonClass}">Save draft</button>
        <a href="/search" class="${secondaryButtonClass}">Cancel</a>
      </div>
    </form>`,
  );

const statusBadgeClass = {
  draft: "bg-gray-100 text-gray-700",
  published: "bg-green-100 text-green-800",
  unpublished: "bg-amber-100 text-amber-800",
} as const;

// What each status means to a visitor, since publishing now opens a page as well
// as a search result.
const statusNotes = {
  draft:
    "Only you can see a draft. Publish it to show it in public search and give it a public page.",
  published: "This listing is published: it appears in public search and has its own public page.",
  unpublished:
    "This listing is unlisted: it is hidden from public search and its public page, with all its details kept.",
} as const;

const transitionControls = (listing: typeof ListingSchema.Type) => {
  const publish = canTransition(listing.status, "published")
    ? `<form method="post" action="/listings/${listing.id}/publish">
        <button type="submit" class="${primaryButtonClass}">Publish</button>
      </form>`
    : "";
  const unlist = canTransition(listing.status, "unpublished")
    ? `<form method="post" action="/listings/${listing.id}/unlist">
        <button type="submit" class="${secondaryButtonClass}">Unlist</button>
      </form>`
    : "";

  return `${publish}${unlist}`;
};

export const editListingPage = (
  listing: typeof ListingSchema.Type,
  values: ListingFormValues,
  error?: string,
) =>
  pageShell(
    "Edit listing",
    `
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold text-gray-900">Edit listing</h1>
        <p class="mt-1 text-sm text-gray-600">Listing #${listing.id}</p>
      </div>
      <span class="rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass[listing.status]}">
        ${statusLabels[listing.status]}
      </span>
    </div>

    <section class="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <p class="text-sm text-gray-600">${statusNotes[listing.status]}</p>
      <div class="mt-4 flex flex-wrap items-center gap-3">
        ${transitionControls(listing)}
      </div>
    </section>

    <div class="mt-4 space-y-4">
      ${listingErrorBanner(error)}
    </div>

    <form
      method="post"
      action="/listings/${listing.id}/edit"
      class="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
    >
      ${listingFields({ ...values, kind: listing.kind }, { kindLocked: true })}

      <div class="mt-6 flex flex-wrap items-center gap-3">
        <button type="submit" class="${primaryButtonClass}">Save changes</button>
        <a href="/listings/${listing.id}/edit" class="${secondaryButtonClass}">Reset</a>
      </div>
    </form>`,
  );

// Used when there is no listing to render a form for: it is missing, it belongs
// to someone else, or the request itself could not be answered.
export const listingErrorPage = (title: string, message: string) =>
  pageShell(
    title,
    `
    <h1 class="text-2xl font-semibold text-gray-900">${escapeHtml(title)}</h1>
    <p class="mt-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
      ${escapeHtml(message)}
    </p>
    <p class="mt-6">
      <a href="/search" class="${secondaryButtonClass}">Back to search</a>
    </p>`,
  );
