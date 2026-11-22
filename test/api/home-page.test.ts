import { call, register } from "../support/api";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

/*
 * The homepage as a browser sees it: a real request to `/` through the real
 * public router. It used to answer a placeholder paragraph, so these tests also
 * hold the replacement in place - the page must be HTML, must carry the app's
 * page links, and must not link anywhere the app does not serve.
 *
 * Every href is followed here. A gated page answers the sign-in prompt with a
 * 401 for a signed-out visitor, which is a working page; only a 404 means the
 * homepage sent someone to a route that does not exist.
 */

const linksIn = (html: string): ReadonlyArray<string> =>
  Array.from(new Set(Array.from(html.matchAll(/href="([^"]+)"/g), (match) => match[1] ?? "")));

const mainRegion = (html: string): string => {
  const start = html.indexOf("<main");
  assert.notStrictEqual(start, -1, "the homepage is missing a <main> region");
  const end = html.indexOf("</main>", start);
  assert.notStrictEqual(end, -1, "the homepage is missing a closing </main> tag");
  return html.slice(start, end);
};

const EXPECTED_LINKS = [
  "/search",
  "/map",
  "/listings/mine",
  "/listings/new",
  "/chats",
  "/profile",
  "/login",
  "/register",
] as const;

describe("GET /", () => {
  it.effect("answers 200 with the homepage and no placeholder body", () =>
    Effect.gen(function* () {
      const response = yield* call("/");

      assert.strictEqual(response.status, 200);
      assert.include(response.headers.get("content-type") ?? "", "text/html");
      assert.include(response.body, "<!DOCTYPE html>");
      assert.include(response.body, "<title>estia - rental listings in Greece</title>");
      assert.notInclude(response.body, "Hello!");
    }),
  );

  it.effect("links every user-facing page", () =>
    Effect.gen(function* () {
      const response = yield* call("/");
      const links = linksIn(mainRegion(response.body));

      for (const href of EXPECTED_LINKS) {
        assert.include(links, href, `the homepage does not link ${href}`);
      }
    }),
  );

  it.effect("links only routes the app serves", () =>
    Effect.gen(function* () {
      const home = yield* call("/");

      for (const href of linksIn(home.body)) {
        const response = yield* call(href);
        assert.notStrictEqual(response.status, 404, `the homepage links ${href}, which is a 404`);
      }
    }),
  );

  it.effect("shows the same page to a signed-in caller", () =>
    Effect.gen(function* () {
      const user = yield* register("home");
      const signedIn = yield* call("/", { headers: { cookie: user.cookie } });
      const anonymous = yield* call("/");

      // No session is read at all, so the directory cannot leak or vary by
      // account.
      assert.strictEqual(signedIn.status, 200);
      assert.strictEqual(signedIn.body, anonymous.body);
    }),
  );
});
