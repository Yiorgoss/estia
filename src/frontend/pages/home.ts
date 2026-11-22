import { pageShell } from "@/frontend/layout";

/*
 * The homepage is a directory, not a feed: one page listing every page a person
 * can visit, so nothing in the app is reachable only through a header or a link
 * buried inside another page. It reads no service and runs no query - every
 * entry here is a route that already exists.
 *
 * The private pages are listed for every visitor, exactly like the header's
 * private links: a signed-out visitor who follows one lands on the sign-in
 * prompt, so the entry carries a "Sign in" tag instead of being hidden.
 */

interface HomeLink {
  readonly href: string;
  readonly label: string;
  readonly note: string;
  // A page behind the session gate; the tag tells a visitor what to expect.
  readonly signedIn?: boolean;
}

interface HomeSection {
  readonly title: string;
  readonly links: ReadonlyArray<HomeLink>;
}

const sections: ReadonlyArray<HomeSection> = [
  {
    title: "Browse",
    links: [
      {
        href: "/search",
        label: "Search listings",
        note: "Filter published rooms, properties, and room-wanted ads, or reopen a saved search.",
      },
      {
        href: "/map",
        label: "Map",
        note: "See where the published listings are, on a map of Greece.",
      },
    ],
  },
  {
    title: "Your pages",
    links: [
      {
        href: "/listings/mine",
        label: "My listings",
        note: "Every listing you posted, drafts included.",
        signedIn: true,
      },
      {
        href: "/listings/new",
        label: "Post a listing",
        note: "Create a draft listing and add its photos.",
        signedIn: true,
      },
      {
        href: "/chats",
        label: "Chats",
        note: "Your conversations about listings.",
        signedIn: true,
      },
      {
        href: "/profile",
        label: "Profile",
        note: "Your profile, and your saved searches when you post listings.",
        signedIn: true,
      },
      {
        href: "/login",
        label: "Log in",
        note: "Sign in to an existing account.",
      },
      {
        href: "/register",
        label: "Register",
        note: "Create an account and pick a profile.",
      },
    ],
  },
];

const signInTag = (link: HomeLink) =>
  link.signedIn === true
    ? `<span class="ml-2 rounded-full border border-gray-300 px-2 py-0.5 text-xs font-normal text-gray-600">Sign in</span>`
    : "";

const linkCard = (link: HomeLink) => `
      <li>
        <a
          href="${link.href}"
          class="block h-full rounded-lg border border-gray-200 bg-white p-5 shadow-sm hover:border-blue-400 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <span class="flex flex-wrap items-center text-base font-semibold text-blue-700">
            ${link.label}${signInTag(link)}
          </span>
          <span class="mt-1 block text-sm text-gray-600">${link.note}</span>
        </a>
      </li>`;

const section = (section: HomeSection) => `
    <section class="mt-8">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-gray-500">${section.title}</h2>
      <ul class="mt-3 grid gap-3 sm:grid-cols-2">
        ${section.links.map(linkCard).join("\n")}
      </ul>
    </section>`;

export const homePage = () =>
  pageShell(
    "estia - rental listings in Greece",
    `<h1 class="text-2xl font-semibold text-gray-900">estia</h1>
    <p class="mt-2 text-sm text-gray-600">
      Rental listings in Greece: rooms, whole properties, and room-wanted ads.
    </p>
${sections.map(section).join("\n")}`,
  );
