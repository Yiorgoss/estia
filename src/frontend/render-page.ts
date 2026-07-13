export const renderPage = () => {

  return `
      <!doctype html>
      <html>
        <head>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
        </head>
        <body class="min-h-lvh">
          <nav class="w-full border-b border-gray-200 bg-white">
            <div class="mx-auto h-16 container flex items-center justify-end px-4 sm:px-6 lg:px-8">

              <div class="flex justify-end items-center gap-6">
                <a
                  href="/"
                  class="text-sm font-medium text-gray-700 hover:text-blue-600"
                >
                  Home
                </a>

                <a
                  href="/login"
                  class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Login
                </a>
              </div>
            </div>
          </nav>
          <main class="pt-[20vh]">
            <form action="/login" method="post" class="w-full max-w-md mx-auto mt-6 space-y-5">
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
}
