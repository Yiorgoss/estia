import { header } from "../header";

export const registerPage = `
<!doctype html>
<html>
  <head>
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  </head>
  <body class="min-h-lvh">
    ${header}
    <main class="pt-[20vh]">
      <form action="/register" method="post" class="w-full max-w-md mx-auto mt-6 space-y-5">
        <div>
          <label
            for="email"
            class="mb-1 block text-sm font-medium text-gray-700"
          >
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autocomplete="email"
            required
            class="w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label
            for="password"
            class="mb-1 block text-sm font-medium text-gray-700"
          >
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="password"
            required
            class="w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div>
          <label
            for="password"
            class="mb-1 block text-sm font-medium text-gray-700"
          >
            Repeat Password
          </label>
          <input
            id="repeat_password"
            name="repeat_password"
            type="password"
            autocomplete="password"
            required
            class="w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>


        <button
          type="submit"
          class="w-full rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          Login
        </button>
      </form>
    </main>
  </body>

</html>
    `
