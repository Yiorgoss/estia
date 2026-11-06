import { RoomSchema } from "@/db/schema/Room";
import { escapeHtml } from "@/utils";

type SearchRoom = typeof RoomSchema.Type;

const formatPrice = (price: number) => `€${price.toLocaleString("en-GB")}`;

const formatDate = (date: Date | null | undefined) =>
  date == null
    ? null
    : date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });

const flagsOf = (room: SearchRoom) =>
  [
    room.furnished ? "Furnished" : undefined,
    room.ensuite ? "Ensuite" : undefined,
    room.smoking ? "Smoking allowed" : undefined,
    room.pets ? "Pets allowed" : undefined,
  ].filter((flag) => flag !== undefined);

const roomCard = (room: SearchRoom) => {
  const flags = flagsOf(room);
  const available = formatDate(room.availableFrom);

  return `
    <article class="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <header class="flex items-start justify-between gap-3">
        <h2 class="min-w-0 break-words text-base font-semibold text-gray-900">${escapeHtml(room.location)}</h2>
        <p class="shrink-0 text-lg font-semibold text-blue-700">
          ${formatPrice(room.price)}<span class="text-xs font-normal text-gray-500">/mo</span>
        </p>
      </header>
      ${
        room.description == null
          ? ""
          : `<p class="text-sm text-gray-600">${escapeHtml(room.description)}</p>`
      }
      ${
        flags.length === 0
          ? ""
          : `<ul class="flex flex-wrap gap-2">
              ${flags
                .map(
                  (flag) =>
                    `<li class="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">${flag}</li>`,
                )
                .join("")}
            </ul>`
      }
      <footer class="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-3 text-xs text-gray-500">
        <span>${room.size == null ? "Size unknown" : `${room.size} m²`}</span>
        <span>${available == null ? "Availability unknown" : `Available ${available}`}</span>
      </footer>
    </article>`;
};

export const searchResults = (rooms: ReadonlyArray<SearchRoom>) => `
  <div class="space-y-4" aria-live="polite">
    ${
      rooms.length === 0
        ? `<p class="rounded-lg border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
             No rooms match these filters.
           </p>`
        : `<p class="text-sm text-gray-600">
             ${rooms.length === 1 ? "1 room found" : `${rooms.length} rooms found`}
           </p>
           <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">${rooms.map(roomCard).join("")}</div>`
    }
  </div>`;

export const searchResultsError = (message: string) => `
  <p class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700" aria-live="polite">
    ${escapeHtml(message)}
  </p>`;
