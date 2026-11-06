import { head } from "../head";
import { header } from "../header";

const numberField = (name: string, label: string, placeholder: string) => `
  <div>
    <label for="${name}" class="mb-1 block text-sm font-medium text-gray-700">${label}</label>
    <input
      id="${name}"
      name="${name}"
      type="number"
      min="0"
      step="any"
      placeholder="${placeholder}"
      class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  </div>`;

const flagField = (name: string, label: string) => `
  <label class="flex items-center gap-2 text-sm text-gray-700">
    <input
      type="checkbox"
      name="${name}"
      value="true"
      class="size-4 accent-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
    />
    ${label}
  </label>`;

export const searchPage = `<!DOCTYPE html>
<html lang="en">
<head>
  ${head}
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Find a room</title>
</head>
<body class="min-h-lvh bg-gray-50">
  ${header}
  <main class="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
    <h1 class="text-2xl font-semibold text-gray-900">Find a room</h1>
    <p class="mt-1 text-sm text-gray-600">Filter by price, size, and what the room allows.</p>

    <form
      id="search-form"
      hx-get="/search/results"
      hx-target="#results"
      hx-swap="innerHTML"
      hx-trigger="submit, change delay:200ms"
      class="mt-6 rounded-lg border border-gray-200 bg-white p-5 shadow-sm"
    >
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        ${numberField("minPrice", "Min price", "0")}
        ${numberField("maxPrice", "Max price", "2000")}
        ${numberField("minSize", "Min size (m²)", "0")}
        ${numberField("maxSize", "Max size (m²)", "150")}
      </div>

      <div class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label for="availableFrom" class="mb-1 block text-sm font-medium text-gray-700">
            Available from
          </label>
          <input
            id="availableFrom"
            name="availableFrom"
            type="date"
            class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <fieldset class="sm:col-span-1 lg:col-span-3">
          <legend class="mb-1 block text-sm font-medium text-gray-700">Details</legend>
          <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            ${flagField("furnished", "Furnished")}
            ${flagField("ensuite", "Ensuite")}
            ${flagField("smoking", "Smoking allowed")}
            ${flagField("pets", "Pets allowed")}
          </div>
        </fieldset>
      </div>

      <div class="mt-5 flex items-center gap-3">
        <button
          type="submit"
          class="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 [.htmx-request_&]:cursor-progress [.htmx-request_&]:opacity-60"
        >
          Search
        </button>
        <a
          href="/search"
          class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Reset
        </a>
      </div>
    </form>

    <section
      id="results"
      hx-get="/search/results"
      hx-trigger="load"
      hx-swap="innerHTML"
      class="mt-8"
    ></section>
  </main>
</body>
</html>
`;
