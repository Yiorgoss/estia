import { homePage } from "@/frontend/pages/home";
import { assert, describe, it } from "@effect/vitest";

/*
 * The homepage is a directory: its whole job is to name every page a person can
 * visit in this app, and to say which ones need a session. These tests pin the
 * set of links, so a new page or a renamed route shows up here as a failure
 * rather than as a page only the header knows about.
 */

// Every user-facing page route the app serves, and the label the homepage uses
// for it. Contextual pages (`/listings/:id`, `/chats/:id`, `/listings/:id/edit`)
// have no fixed href, so they are reached from these pages, not from the
// directory.
const expectedLinks: ReadonlyArray<readonly [string, string]> = [
  ["/search", "Search listings"],
  ["/map", "Map"],
  ["/listings/mine", "My listings"],
  ["/listings/new", "Post a listing"],
  ["/chats", "Chats"],
  ["/profile", "Profile"],
  ["/login", "Log in"],
  ["/register", "Register"],
];

// The tag markup, not the words: a note may mention signing in as well.
const SIGN_IN_TAG = ">Sign in</span>";

const hrefsIn = (html: string): ReadonlyArray<string> =>
  Array.from(html.matchAll(/href="([^"]+)"/g), (match) => match[1] ?? "");

const mainRegion = (html: string): string => {
  const start = html.indexOf("<main");
  assert.notStrictEqual(start, -1, "homepage is missing a <main> region");
  const end = html.indexOf("</main>", start);
  assert.notStrictEqual(end, -1, "homepage is missing a closing </main> tag");
  return html.slice(start, end);
};

const cardFor = (html: string, href: string): string => {
  const start = html.indexOf(`href="${href}"`);
  assert.notStrictEqual(start, -1, `homepage is missing the ${href} link`);
  const end = html.indexOf("</a>", start);
  assert.notStrictEqual(end, -1, `homepage link ${href} is missing a closing </a> tag`);
  return html.slice(start, end);
};

describe("homePage", () => {
  it("links every user-facing page", () => {
    const main = mainRegion(homePage());
    const hrefs = hrefsIn(main);

    for (const [href, label] of expectedLinks) {
      assert.include(hrefs, href, `homepage is missing the ${href} link`);
      assert.include(cardFor(main, href), label, `homepage is missing the ${label} label`);
    }
  });

  it("renders inside the shared page shell", () => {
    const html = homePage();

    assert.include(html, "<!DOCTYPE html>");
    assert.include(html, "<title>estia - rental listings in Greece</title>");
    // The same navigation every other page shows, so the directory is reachable
    // from anywhere and back again.
    assert.include(html, "Home");
    assert.include(html, "<main");
  });

  it("marks the pages that need a session and leaves the public ones unmarked", () => {
    // The header repeats four of these links without a tag, so the directory is
    // read from the main region only.
    const main = mainRegion(homePage());

    for (const gated of ["/listings/mine", "/listings/new", "/chats", "/profile"]) {
      assert.include(cardFor(main, gated), SIGN_IN_TAG, `${gated} is not marked`);
    }

    for (const open of ["/search", "/map", "/login", "/register"]) {
      assert.notInclude(cardFor(main, open), SIGN_IN_TAG, `${open} is marked`);
    }
  });

  it("adds no link that no route serves", () => {
    // The directory may only point at routes the app really has; anything else
    // would be a dead end for the visitor who follows it.
    const knownRoutes = new Set([
      "/search",
      "/map",
      "/listings/mine",
      "/listings/new",
      "/chats",
      "/profile",
      "/login",
      "/register",
      "/",
    ]);

    for (const href of hrefsIn(homePage())) {
      assert.isTrue(knownRoutes.has(href), `homepage links ${href}, which is not a known route`);
    }
  });
});
