import { GreekRegionCodes, ListingKind, ListingSchema } from "@/db/schema/Listing";
import {
  LISTING_PHOTO_MAX_BYTES,
  LISTING_PHOTO_MAX_PER_LISTING,
  listingPhotoCardUrl,
} from "@/db/schema/ListingPhoto";
import type { ListingPhoto } from "@/db/schema/ListingPhoto";
import {
  errorBanner,
  pageShell,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/frontend/layout";
import type { ListingFormValues } from "@/frontend/listing-form";
import { kindLabels, regionLabels } from "@/frontend/listing-labels";
import { statusBadge, statusNotes } from "@/frontend/listing-status";
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

export const newListingPage = (values: ListingFormValues, error?: string) =>
  pageShell(
    "New listing",
    `
    <h1 class="text-2xl font-semibold text-gray-900">Post a listing</h1>
    <p class="mt-1 text-sm text-gray-600">
      A new listing starts as a draft, so you can correct it before anyone else sees it.
    </p>

    <div class="mt-4 space-y-4">
      ${errorBanner(error)}
    </div>

    <form
      method="post"
      action="/listings/new"
      class="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
    >
      ${listingFields(values, { kindLocked: false })}

      <div class="mt-6 flex flex-wrap items-center gap-3">
        <button type="submit" class="${primaryButtonClass}">Save draft</button>
        <a href="/listings/mine" class="${secondaryButtonClass}">My listings</a>
        <a href="/search" class="${secondaryButtonClass}">Cancel</a>
      </div>
    </form>`,
  );

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

const photoControlClass =
  "rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1";

/*
 * One gallery card. Every control is a plain form posting to a route that
 * re-checks ownership, so no-JS works and a photo id from another listing is
 * refused rather than silently ignored. "First" is the thumbnail the search
 * card and the public detail page use.
 */
const photoCard = (
  listingId: (typeof ListingSchema.Type)["id"],
  photo: ListingPhoto,
  index: number,
  total: number,
) => `
  <li class="overflow-hidden rounded-md border border-gray-200 bg-white">
    <img
      src="${escapeHtml(listingPhotoCardUrl(listingId, photo.id))}"
      alt="Photo ${index + 1}"
      loading="lazy"
      class="aspect-[4/3] w-full bg-gray-100 object-cover"
    />
    ${
      photo.thumbnailKey === null
        ? `<p class="border-t border-amber-100 bg-amber-50 px-2 py-1 text-xs text-amber-800">
             No downscaled copy; the original is used on cards.
           </p>`
        : ""
    }
    <div class="flex flex-wrap items-center gap-2 border-t border-gray-100 p-2">
      ${
        index === 0
          ? `<span class="rounded-full bg-blue-700 px-2 py-0.5 text-xs font-medium text-white">First</span>`
          : `<form method="post" action="/listings/${listingId}/photos/${photo.id}/first">
              <button type="submit" class="${photoControlClass}">Make first</button>
            </form>`
      }
      ${
        index === 0
          ? ""
          : `<form method="post" action="/listings/${listingId}/photos/${photo.id}/move">
              <input type="hidden" name="direction" value="up" />
              <button type="submit" class="${photoControlClass}" aria-label="Move photo ${index + 1} up">&uarr;</button>
            </form>`
      }
      ${
        index === total - 1
          ? ""
          : `<form method="post" action="/listings/${listingId}/photos/${photo.id}/move">
              <input type="hidden" name="direction" value="down" />
              <button type="submit" class="${photoControlClass}" aria-label="Move photo ${index + 1} down">&darr;</button>
            </form>`
      }
      <form method="post" action="/listings/${listingId}/photos/${photo.id}/delete" class="ml-auto">
        <button type="submit" class="${photoControlClass} text-red-700 hover:bg-red-50">Delete</button>
      </form>
    </div>
  </li>`;

const gallerySection = (
  listing: typeof ListingSchema.Type,
  photos: ReadonlyArray<ListingPhoto>,
) => `
  <section class="mt-4 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h2 class="text-lg font-semibold text-gray-900">Photos</h2>
      <p class="text-xs text-gray-500">${photos.length} of ${LISTING_PHOTO_MAX_PER_LISTING}</p>
    </div>
    <p class="mt-1 text-sm text-gray-600">
      The first photo is the thumbnail in search results. JPEG, PNG, or WebP, up to
      ${LISTING_PHOTO_MAX_BYTES / (1024 * 1024)} MB each.
    </p>

    ${
      photos.length === 0
        ? `<p class="mt-3 rounded-md border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
             No photos yet.
           </p>`
        : `<ol class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
             ${photos
               .map((photo, index) => photoCard(listing.id, photo, index, photos.length))
               .join("")}
           </ol>`
    }

    ${
      photos.length >= LISTING_PHOTO_MAX_PER_LISTING
        ? ""
        : `<form
             method="post"
             action="/listings/${listing.id}/photos"
             enctype="multipart/form-data"
             class="mt-4 flex flex-wrap items-center gap-3 border-t border-gray-100 pt-4"
           >
             <label for="photos" class="text-sm font-medium text-gray-700">Add photos</label>
             <input
               id="photos"
               name="photos"
               type="file"
               accept="image/jpeg,image/png,image/webp"
               multiple
               required
               class="text-sm text-gray-600 file:mr-3 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-200"
             />
             <button type="submit" class="${secondaryButtonClass}">Upload</button>
           </form>`
    }
  </section>`;

export const editListingPage = (
  listing: typeof ListingSchema.Type,
  values: ListingFormValues,
  error?: string,
  photos: ReadonlyArray<ListingPhoto> = [],
) =>
  pageShell(
    "Edit listing",
    `
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold text-gray-900">Edit listing</h1>
        <p class="mt-1 text-sm text-gray-600">Listing #${listing.id}</p>
      </div>
      ${statusBadge(listing.status)}
    </div>

    <section class="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <p class="text-sm text-gray-600">${statusNotes[listing.status]}</p>
      <div class="mt-4 flex flex-wrap items-center gap-3">
        ${transitionControls(listing)}
      </div>
    </section>

    <div class="mt-4 space-y-4">
      ${errorBanner(error)}
    </div>

    ${gallerySection(listing, photos)}

    <form
      method="post"
      action="/listings/${listing.id}/edit"
      class="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
    >
      ${listingFields({ ...values, kind: listing.kind }, { kindLocked: true })}

      <div class="mt-6 flex flex-wrap items-center gap-3">
        <button type="submit" class="${primaryButtonClass}">Save changes</button>
        <a href="/listings/mine" class="${secondaryButtonClass}">My listings</a>
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
    <p class="mt-6 flex flex-wrap items-center gap-3">
      <a href="/listings/mine" class="${secondaryButtonClass}">My listings</a>
      <a href="/search" class="${secondaryButtonClass}">Back to search</a>
    </p>`,
  );
