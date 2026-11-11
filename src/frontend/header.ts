/*
 * The same navigation for every visitor, signed in or not. The private links are
 * deliberately not gated: a signed-out visitor who follows one lands on the
 * sign-in prompt page, not a bare 401.
 */
export const header = `
  <nav class="w-full border-b border-gray-200 bg-white">
    <div class="mx-auto min-h-16 container flex items-center justify-end px-4 py-2 sm:px-6 lg:px-8">

      <div class="flex flex-wrap justify-end items-center gap-x-2 gap-y-2 sm:gap-x-6">
        <a
          href="/"
          class="text-sm font-medium text-gray-700 hover:text-blue-600"
        >
          Home
        </a>

        <a
          href="/search"
          class="text-sm font-medium text-gray-700 hover:text-blue-600"
        >
          Search
        </a>

        <a
          href="/map"
          class="text-sm font-medium text-gray-700 hover:text-blue-600"
        >
          Map
        </a>

        <a
          href="/listings/mine"
          class="text-sm font-medium text-gray-700 hover:text-blue-600"
        >
          My listings
        </a>

        <a
          href="/enquiries"
          class="text-sm font-medium text-gray-700 hover:text-blue-600"
        >
          Enquiries
        </a>

        <a
          href="/profile"
          class="text-sm font-medium text-gray-700 hover:text-blue-600"
        >
          Profile
        </a>

        <a
          href="/login"
          class="rounded-md border-2 border-blue-700 px-4 py-2 text-sm font-medium text-blue-700 hover:text-white transition-colors duration-300 hover:bg-blue-700"
        >
          Login
        </a>
        <a
          href="/register"
          class="rounded-md bg-blue-700 border-blue-700 border-2 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          register
        </a>
      </div>
    </div>
  </nav>
 `;
