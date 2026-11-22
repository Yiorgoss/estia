#!/usr/bin/env node
/*
 * Local development seed data for estia.
 *
 * The script drives a running server - a local dev server by default, or the
 * deployed test environment - through its own HTTP surface: the public auth
 * API, the private profile and listing APIs, and the real multipart photo
 * upload route. So the rows it creates are the rows the app would create for a
 * person: password hashes, provisioned profile rows, owned listings, R2 objects,
 * `listing_photos` rows, and the downscaled card images the Images binding
 * produces. Nothing here writes to the database directly.
 *
 * Safety: this is a development tool. It refuses to run when the environment
 * asks for production, when `--prod` or `--remote` is passed, or when the target
 * is neither a loopback address nor the named test host
 * (`estia.calisto.studio`). It is wired to its own `pnpm seed` and
 * `pnpm seed:test` scripts, so no build, deploy, or production startup path can
 * reach it.
 *
 * Re-running is safe: existing seeded accounts are signed in to, profiles are
 * upserted, listings are found by their deterministic seed titles, and only
 * missing photos are uploaded. See `docs/seed.md` for the logins table.
 */

import { pathToFileURL } from "node:url";

export const DEFAULT_BASE_URL = "http://127.0.0.1:5173";

/*
 * The one remote host this tool may write to: the deployed test environment
 * (`env.test` in `wrangler.jsonc`, served from a Cloudflare custom domain). The
 * host is named here rather than derived from an environment variable, so no
 * other remote address can ever become seedable by a typo.
 */
export const TEST_HOSTNAME = "estia.calisto.studio";
export const TEST_BASE_URL = `https://${TEST_HOSTNAME}`;

// Every seeded account shares this password. The app's only password rule is
// "not empty", so the shortest memorable value is allowed and no production
// validation is weakened for the seed.
export const SEED_PASSWORD = "test";

// A loopback address, in the forms a URL parser produces for one.
export const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Environment values that mean "this is not a dev machine". `prod` is the
// wrangler environment name this repository uses, so it is refused as well.
const NON_LOCAL_ENVIRONMENTS = new Set(["production", "prod", "staging", "stage", "remote"]);

// The environments `--env` may name. Only the deployed test environment is
// seedable remotely; `--env prod` and friends are refused by name.
const SEEDABLE_ENVIRONMENTS = new Set(["test"]);

// Flags that ask for a remote or production target. `--remote` is wrangler's
// own flag, so passing it here means the caller expected a wrangler command and
// not this script; refusing it keeps the two workflows apart.
const REMOTE_FLAGS = new Set([
  "--remote",
  "--remote=1",
  "--remote=true",
  "--prod",
  "--production",
]);

// The gallery's ceiling, mirrored from `src/db/schema/ListingPhoto.ts`. An image
// larger than this cannot pass the upload route, so the picture is requested at
// a smaller size instead.
export const LISTING_PHOTO_MAX_BYTES = 1024 * 1024;

// The image types the gallery's magic-byte check accepts. `picsum.photos`
// answers with a JPEG today, but the declaration follows the bytes so the seed
// does not depend on that.
const PHOTO_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/*
 * A refusal, rather than a failure: the script was asked to do something that is
 * only safe on a developer machine, and it did not try.
 */
export class SeedSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeedSafetyError";
  }
}

/*
 * The one gate in front of every network call. The target has to be a loopback
 * address or the named test host, because a production database is reachable by
 * neither. The environment checks are belt and braces for the same intent: a
 * shell that says "production" is not a shell this tool should act in, even
 * before the address is read.
 *
 * A remote target is only ever the test environment, and only over HTTPS: the
 * custom domain is HTTPS-only, so a plain-HTTP spelling is a mistake rather
 * than a supported target.
 */
export const assertSeedTarget = ({
  environment,
  nodeEnv,
  argv = [],
  baseUrl = DEFAULT_BASE_URL,
}) => {
  const environmentValue = String(environment ?? "")
    .trim()
    .toLowerCase();
  if (NON_LOCAL_ENVIRONMENTS.has(environmentValue)) {
    throw new SeedSafetyError(
      `Refusing to seed: ENVIRONMENT=${environment} is not a local or test environment.`,
    );
  }

  const nodeEnvValue = String(nodeEnv ?? "")
    .trim()
    .toLowerCase();
  if (NON_LOCAL_ENVIRONMENTS.has(nodeEnvValue)) {
    throw new SeedSafetyError(
      `Refusing to seed: NODE_ENV=${nodeEnv} is not a local or test environment.`,
    );
  }

  const remoteFlag = argv.find((argument) => REMOTE_FLAGS.has(argument));
  if (remoteFlag !== undefined) {
    throw new SeedSafetyError(
      `Refusing to seed: ${remoteFlag} targets a remote worker or production, and this script only seeds a local dev server or the test environment.`,
    );
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new SeedSafetyError(`Refusing to seed: "${baseUrl}" is not a URL.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SeedSafetyError(
      `Refusing to seed: ${url.protocol} is not an HTTP address a dev server or the test environment listens on.`,
    );
  }

  if (LOCAL_HOSTNAMES.has(url.hostname)) return url;

  if (url.hostname === TEST_HOSTNAME) {
    if (url.protocol !== "https:") {
      throw new SeedSafetyError(
        `Refusing to seed: the test environment is only reachable over HTTPS. Use ${TEST_BASE_URL}.`,
      );
    }
    // The deployed custom domain answers on the default HTTPS port; any other
    // port is a different listener, so it is not the test environment.
    if (url.port !== "" && url.port !== "443") {
      throw new SeedSafetyError(
        `Refusing to seed: ${url.host} is neither a local loopback address nor the test environment ${TEST_HOSTNAME}.`,
      );
    }
    return url;
  }

  throw new SeedSafetyError(
    `Refusing to seed: ${url.hostname} is neither a local loopback address nor the test environment ${TEST_HOSTNAME}. ` +
      `Set SEED_BASE_URL to http://127.0.0.1:<port> for a dev server, or use \`pnpm seed:test\` for ${TEST_HOSTNAME}.`,
  );
};

/*
 * The `--env` names on the command line, in both spellings the CLI accepts. A
 * missing value is reported as an empty one so `--env` alone is a readable
 * refusal instead of a silent local run.
 */
const environmentFlags = (argv) => {
  const values = [];
  argv.forEach((argument, index) => {
    if (argument === "--env" || argument === "-e") {
      values.push(argv[index + 1] ?? "");
    } else if (argument.startsWith("--env=")) {
      values.push(argument.slice("--env=".length));
    }
  });
  return values;
};

/*
 * Which target a run should use, before anything is fetched. `--env test` (or
 * the `--test` shorthand) names the deployed test environment; otherwise
 * `SEED_BASE_URL` and the local default decide, and the shared guard still has
 * the final word on every one of them.
 */
export const resolveSeedTarget = ({
  argv = [],
  environment,
  nodeEnv,
  baseUrl = DEFAULT_BASE_URL,
}) => {
  for (const requested of environmentFlags(argv)) {
    if (!SEEDABLE_ENVIRONMENTS.has(requested)) {
      throw new SeedSafetyError(
        `Refusing to seed: --env ${requested === "" ? "(no value)" : requested} is not a seedable environment. ` +
          `Only "test" may be seeded remotely, and a local dev server needs no --env.`,
      );
    }
  }

  const wantsTest = environmentFlags(argv).includes("test") || argv.includes("--test");
  return assertSeedTarget({
    environment,
    nodeEnv,
    argv,
    baseUrl: wantsTest ? TEST_BASE_URL : baseUrl,
  });
};

/*
 * The accounts the seed creates. `role` is what the logins table says: an
 * account that both seeks and lists carries two filled profiles, which this app
 * models as a seeker profile and a lister profile on one account, with the
 * stored role left on `lister`.
 */
export const SEED_USERS = [
  {
    email: "lister1@test.local",
    password: SEED_PASSWORD,
    role: "lister",
    lister: { name: "Anna Papadopoulou", ownership: "owner" },
  },
  {
    email: "lister2@test.local",
    password: SEED_PASSWORD,
    role: "lister",
    lister: { name: "Kostas Nikolaidis", ownership: "leaseholder" },
  },
  {
    email: "seeker1@test.local",
    password: SEED_PASSWORD,
    role: "seeker",
    seeker: {
      name: "Maria Georgiou",
      dateOfBirth: "1996-04-12",
      gender: "female",
      bio: "Nurse at Evangelismos, looking for a quiet room in central Athens.",
      smoking: 0,
      pets: 1,
    },
  },
  {
    email: "seeker2@test.local",
    password: SEED_PASSWORD,
    role: "seeker",
    seeker: {
      name: "Yiannis Dimitriou",
      dateOfBirth: "1991-11-03",
      gender: "male",
      bio: "Moving to Thessaloniki for a two-year contract. Non-smoker, no pets.",
      smoking: 0,
      pets: 0,
    },
  },
  {
    email: "both@test.local",
    password: SEED_PASSWORD,
    role: "both",
    seeker: {
      name: "Eleni Vasileiou",
      dateOfBirth: "1989-06-27",
      gender: "NB",
      bio: "Architect seeking a flat near the centre while letting a loft of my own.",
      smoking: 0,
      pets: 1,
    },
    lister: { name: "Eleni Vasileiou", ownership: "owner" },
  },
];

/*
 * The photo shapes the seed asks the image API for: one of each aspect ratio and
 * size the layout has to survive. The first shape of a listing is its card
 * image, so every listing opens with a landscape frame.
 */
export const PHOTO_SHAPES = {
  landscape: { width: 1200, height: 800 },
  portrait: { width: 600, height: 900 },
  square: { width: 800, height: 800 },
  panoramic: { width: 1600, height: 600 },
  tall: { width: 400, height: 1000 },
  small: { width: 320, height: 240 },
};

export const ALL_PHOTO_SHAPES = [
  "landscape",
  "portrait",
  "square",
  "panoramic",
  "tall",
  "small",
];

/*
 * Listings across the regions, kinds, and prices a search has to page through.
 * The title is the idempotency key: it is written once and looked up on every
 * later run, so a re-run reuses the row instead of creating a twin.
 */
export const SEED_LISTINGS = [
  {
    owner: "lister1@test.local",
    title: "Sunny one-bedroom in Koukaki",
    kind: "room",
    description:
      "A bright room in a 1960s block two streets from the Acropolis Museum. Shared kitchen and bathroom, balcony facing the courtyard.",
    priceMinor: 62000,
    regionCode: "attica",
    lat: 37.964,
    lng: 23.726,
    sizeSqm: 38,
    availableFrom: "2026-10-01",
    furnished: 1,
    ensuite: 0,
    smoking: 0,
    pets: 1,
    photos: ALL_PHOTO_SHAPES,
  },
  {
    owner: "lister1@test.local",
    title: "Sea-view flat in Chania old town",
    kind: "whole_property",
    description:
      "Two bedrooms in a restored Venetian house. Terrace looks over the harbour; heating and air conditioning included.",
    priceMinor: 115000,
    regionCode: "crete",
    lat: 35.5122,
    lng: 24.018,
    sizeSqm: 95,
    availableFrom: "2026-11-15",
    furnished: 1,
    ensuite: 1,
    smoking: 0,
    pets: 0,
    photos: ["panoramic", "landscape", "portrait", "square"],
  },
  {
    owner: "lister1@test.local",
    title: "Quiet studio near Aristotelous Square",
    kind: "room",
    description:
      "Studio on the fourth floor with a lift. Five minutes on foot to the seafront promenade and the bus to the airport.",
    priceMinor: 48000,
    regionCode: "central_macedonia",
    lat: 40.633,
    lng: 22.943,
    sizeSqm: 28,
    availableFrom: "2026-09-20",
    furnished: 0,
    ensuite: 0,
    smoking: 0,
    pets: 0,
    photos: ["tall", "square", "small"],
  },
  {
    owner: "lister2@test.local",
    title: "Renovated two-bedroom in Ano Poli",
    kind: "whole_property",
    description:
      "Stone house above the city walls with a small garden. Renovated in 2024, wood floors, wood stove for the winter.",
    priceMinor: 78000,
    regionCode: "central_macedonia",
    lat: 40.6469,
    lng: 22.9519,
    sizeSqm: 82,
    availableFrom: "2026-12-01",
    furnished: 0,
    ensuite: 1,
    smoking: 0,
    pets: 1,
    photos: ["landscape", "tall", "small"],
  },
  {
    owner: "lister2@test.local",
    title: "Shared house room in Mets",
    kind: "room",
    description:
      "One room in a three-bedroom flat shared with two students. Bills are split evenly and the kitchen is fully equipped.",
    priceMinor: 55000,
    regionCode: "attica",
    lat: 37.9639,
    lng: 23.7421,
    sizeSqm: 22,
    availableFrom: "2026-09-01",
    furnished: 1,
    ensuite: 0,
    smoking: 0,
    pets: 0,
    photos: ["portrait", "square"],
  },
  {
    owner: "lister2@test.local",
    title: "Student room in Patras centre",
    kind: "room",
    description:
      "Affordable room a ten-minute walk from the university, on a quiet street with a bakery and a supermarket next door.",
    priceMinor: 35000,
    regionCode: "western_greece",
    lat: 38.2466,
    lng: 21.7346,
    sizeSqm: 18,
    availableFrom: "2026-09-15",
    furnished: 1,
    ensuite: 0,
    smoking: 1,
    pets: 0,
    photos: ["small", "landscape"],
  },
  {
    owner: "both@test.local",
    title: "Loft with terrace in Exarchia",
    kind: "whole_property",
    description:
      "Top-floor loft with a planted terrace and a skylight over the living room. Suits one person or a couple.",
    priceMinor: 90000,
    regionCode: "attica",
    lat: 37.9865,
    lng: 23.7352,
    sizeSqm: 70,
    availableFrom: "2026-10-20",
    furnished: 1,
    ensuite: 1,
    smoking: 0,
    pets: 0,
    photos: ALL_PHOTO_SHAPES,
  },
  {
    owner: "both@test.local",
    title: "Room wanted: quiet flatmate in Heraklion",
    kind: "room_wanted",
    description:
      "Looking for a furnished room near the university hospital, up to 400 euros a month, move-in from November.",
    priceMinor: 40000,
    regionCode: "crete",
    lat: 35.3387,
    lng: 25.1442,
    sizeSqm: 20,
    availableFrom: "2026-11-01",
    furnished: 0,
    ensuite: 0,
    smoking: 0,
    pets: 0,
    photos: ["square", "portrait"],
  },
];

const CREDENTIAL_HEADERS = ["EMAIL", "PASSWORD", "ROLE"];

const credentialRows = (users) =>
  users.map((user) => [user.email, user.password, user.role]);

/*
 * The logins table printed at the end of a run and repeated in `docs/seed.md`.
 * Column widths follow the widest cell, so the same table reads the same in both
 * places and a new account never breaks the alignment.
 */
export const formatCredentialsTable = (users) => {
  const rows = [CREDENTIAL_HEADERS, ...credentialRows(users)];
  const widths = CREDENTIAL_HEADERS.map((header, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  const render = (row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]))
      .join("  ")
      .trimEnd();
  const rule = widths.map((width) => "-".repeat(width)).join("  ");
  return [render(CREDENTIAL_HEADERS), rule, ...credentialRows(users).map(render)].join("\n");
};

// --- the HTTP client -------------------------------------------------------

const cookieHeader = (jar) =>
  Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

/*
 * The session the server proves travels back as `Set-Cookie` on almost every
 * authenticated response, including a rotation of the pair. Keeping the latest
 * pair is what lets a long seed run keep the same session.
 */
const mergeCookies = (jar, response) => {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const raw of setCookies) {
    const [pair] = raw.split(";");
    const separator = pair.indexOf("=");
    if (separator > 0) {
      jar[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
    }
  }
};

const describeResponse = (result) =>
  result.text === "" ? "(empty body)" : result.text.replace(/\s+/g, " ").slice(0, 400);

const request = async (session, method, path, { payload, form } = {}) => {
  const headers = {};
  if (Object.keys(session.jar).length > 0) headers.cookie = cookieHeader(session.jar);

  let body;
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(payload);
  } else if (form !== undefined) {
    body = form;
  }

  const init = { method, headers, redirect: "manual" };
  if (body !== undefined) init.body = body;
  const response = await fetch(new URL(path, session.baseUrl), init);
  mergeCookies(session.jar, response);

  const text = await response.text();
  let json;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
};

const expectSuccess = (result, label) => {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`${label} answered HTTP ${result.status}: ${describeResponse(result)}`);
  }
  return result;
};

// --- seeding steps ---------------------------------------------------------

const waitForServer = async (baseUrl) => {
  const healthUrl = new URL("/api/health", baseUrl);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // The dev server is still compiling, or not started at all yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `No server answered ${healthUrl}. ` +
      (baseUrl.hostname === TEST_HOSTNAME
        ? `Check that ${TEST_BASE_URL} is deployed (\`pnpm deploy:test\`), then run \`pnpm seed:test\` again.`
        : "Start one with `pnpm dev`, then run `pnpm seed` again."),
  );
};

const signIn = async (session, user) => {
  const login = await request(session, "POST", "/api/auth/login", {
    payload: { email: user.email, password: user.password },
  });
  if (login.status === 200) return "signed in";

  if (login.status !== 401) {
    expectSuccess(login, `Sign in as ${user.email}`);
  }

  const registered = await request(session, "POST", "/api/auth/register", {
    payload: { email: user.email, password: user.password },
  });
  if (registered.status === 409) {
    throw new Error(
      `${user.email} already exists with another password. Delete that local account, or change the seed password.`,
    );
  }
  expectSuccess(registered, `Register ${user.email}`);
  return "registered";
};

/*
 * An account's stored role decides which profile the API will accept, so the
 * seed moves the account to the role it is filling first. Asking for the role
 * the account already holds is a no-op the service answers with the profile.
 */
const ensureRole = async (session, email, role) => {
  const switched = await request(session, "POST", `/api/users/change-role?role=${role}`);
  expectSuccess(switched, `Switch ${email} to ${role}`);
};

const seekerPayload = (profile) => ({
  name: profile.name,
  dateOfBirth: Date.parse(`${profile.dateOfBirth}T00:00:00Z`),
  gender: profile.gender,
  bio: profile.bio,
  smoking: profile.smoking,
  pets: profile.pets,
});

const listerPayload = (profile) => ({ name: profile.name, ownership: profile.ownership });

const saveProfile = async (session, email, role, user) => {
  const payload = role === "seeker" ? seekerPayload(user.seeker) : listerPayload(user.lister);
  const saved = await request(session, "PUT", "/api/users/profile", { payload });
  expectSuccess(saved, `Save the ${role} profile of ${email}`);
};

const seedUser = async (session, user) => {
  const outcome = await signIn(session, user);

  // A dual-role account fills both profile rows: the seeking one first, then the
  // switch to listing, so the account ends up holding both.
  if (user.role === "seeker" || user.role === "both") {
    await ensureRole(session, user.email, "seeker");
    await saveProfile(session, user.email, "seeker", user);
  }
  if (user.role === "lister" || user.role === "both") {
    await ensureRole(session, user.email, "lister");
    await saveProfile(session, user.email, "lister", user);
  }

  return outcome;
};

const listingPayload = (listing) => ({
  kind: listing.kind,
  title: listing.title,
  description: listing.description,
  priceMinor: listing.priceMinor,
  regionCode: listing.regionCode,
  lat: listing.lat,
  lng: listing.lng,
  sizeSqm: listing.sizeSqm,
  availableFrom: Date.parse(`${listing.availableFrom}T00:00:00Z`),
  furnished: listing.furnished,
  ensuite: listing.ensuite,
  smoking: listing.smoking,
  pets: listing.pets,
});

const photoSeed = (listing, shape) =>
  `estia-${listing.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}-${shape}`;

/*
 * One picture from the public image API, at the requested shape. The redirect to
 * the image host is followed, the bytes are checked against the gallery's rules,
 * and a picture over the size ceiling is asked for again at half the dimensions
 * so a seed run never fails on an unlucky photograph.
 */
const fetchPhoto = async (listing, shapeName) => {
  const shape = PHOTO_SHAPES[shapeName];
  let width = shape.width;
  let height = shape.height;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const url = `https://picsum.photos/seed/${photoSeed(listing, shapeName)}/${width}/${height}`;
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      throw new Error(`The image API answered HTTP ${response.status} for ${url}`);
    }

    const declared = (response.headers.get("content-type") ?? "").toLowerCase();
    const contentType = declared.split(";")[0].trim();
    if (!PHOTO_CONTENT_TYPES.has(contentType)) {
      throw new Error(`The image API answered ${declared || "no content type"} for ${url}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length <= LISTING_PHOTO_MAX_BYTES) {
      return { shape: shapeName, dimensions: `${width}x${height}`, contentType, bytes };
    }

    width = Math.max(160, Math.floor(width / 2));
    height = Math.max(160, Math.floor(height / 2));
  }

  throw new Error(`Could not fetch a ${shapeName} photo small enough for the gallery`);
};

const uploadPhoto = async (session, listingId, photo) => {
  const form = new FormData();
  form.append(
    "photos",
    new Blob([photo.bytes], { type: photo.contentType }),
    `seed-${photo.shape}.${photo.contentType.split("/")[1]}`,
  );

  const uploaded = await request(session, "POST", `/listings/${listingId}/photos`, { form });
  // The upload route answers a person with a redirect back to the edit page.
  if (uploaded.status !== 303 && uploaded.status !== 200) {
    throw new Error(
      `Uploading the ${photo.shape} photo to listing ${listingId} answered HTTP ${uploaded.status}: ${describeResponse(uploaded)}`,
    );
  }
};

const publicListing = async (session, listingId) => {
  const detail = await request(session, "GET", `/api/listings/${listingId}`);
  if (detail.status === 404) return undefined;
  expectSuccess(detail, `Read listing ${listingId}`);
  return detail.json;
};

const mineListings = async (session) => {
  const mine = await request(session, "GET", "/api/listings/mine?limit=50");
  expectSuccess(mine, "Read the owner's listings");
  return mine.json.items;
};

const publishListing = async (session, listingId) => {
  const published = await request(session, "POST", `/api/listings/${listingId}/publish`);
  expectSuccess(published, `Publish listing ${listingId}`);
};

/*
 * Proves the seeded gallery is readable the way a browser reads it: every
 * original and every card image answers 200 with an image type. This is the
 * check that R2, the `listing_photos` row, and the thumbnails all really exist.
 */
const verifyPhotos = async (session, listingId) => {
  const detail = await publicListing(session, listingId);
  const photos = detail?.photos ?? [];
  for (const photo of photos) {
    for (const path of [photo.url, `${photo.url}/card`]) {
      const response = await fetch(new URL(path, session.baseUrl));
      if (!response.ok) {
        throw new Error(`${path} answered HTTP ${response.status}`);
      }
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.startsWith("image/")) {
        throw new Error(`${path} answered ${contentType || "no content type"}`);
      }
      await response.arrayBuffer();
    }
  }
  return photos.length;
};

const seedListing = async (session, listing, existing) => {
  let listingId;
  let status;

  if (existing === undefined) {
    const created = await request(session, "POST", "/api/listings", {
      payload: listingPayload(listing),
    });
    expectSuccess(created, `Create "${listing.title}"`);
    listingId = created.json.id;
    status = created.json.status;
  } else {
    listingId = existing.id;
    status = existing.status;
  }

  if (status !== "published") {
    await publishListing(session, listingId);
  }

  const detail = await publicListing(session, listingId);
  const alreadyUploaded = detail?.photos?.length ?? 0;
  const wanted = listing.photos.slice(alreadyUploaded);

  for (const shapeName of wanted) {
    const photo = await fetchPhoto(listing, shapeName);
    await uploadPhoto(session, listingId, photo);
  }

  const total = await verifyPhotos(session, listingId);
  return { listingId, uploaded: wanted.length, total };
};

const run = async ({ argv, env }) => {
  const baseUrl = env.SEED_BASE_URL ?? DEFAULT_BASE_URL;
  const target = resolveSeedTarget({
    argv,
    environment: env.ENVIRONMENT,
    nodeEnv: env.NODE_ENV,
    baseUrl,
  });

  if (target.hostname === TEST_HOSTNAME) {
    console.log(`Seeding the shared test environment ${target.origin}`);
  } else {
    console.log(`Seeding ${target.origin}`);
  }
  await waitForServer(target);

  const listingsByOwner = new Map();
  for (const listing of SEED_LISTINGS) {
    const owned = listingsByOwner.get(listing.owner) ?? [];
    owned.push(listing);
    listingsByOwner.set(listing.owner, owned);
  }

  let listingCount = 0;
  let photoCount = 0;

  for (const user of SEED_USERS) {
    const session = { baseUrl: target, jar: {} };
    const outcome = await seedUser(session, user);
    console.log(`  ${user.email} (${user.role}): ${outcome}`);

    const existing = new Map((await mineListings(session)).map((item) => [item.title, item]));
    for (const listing of listingsByOwner.get(user.email) ?? []) {
      const seeded = await seedListing(session, listing, existing.get(listing.title));
      listingCount += 1;
      photoCount += seeded.total;
      const reused = existing.has(listing.title) ? "reused" : "created";
      console.log(
        `    ${reused} "${listing.title}" (id ${seeded.listingId}, ${seeded.total} photos)`,
      );
    }
  }

  const table = formatCredentialsTable(SEED_USERS);
  console.log("");
  console.log(
    `Seed complete against ${target.origin}: ${SEED_USERS.length} accounts, ${listingCount} listings, ${photoCount} photos.`,
  );
  console.log("");
  console.log(table);
  console.log("");
  console.log("Password for every seeded account: " + SEED_PASSWORD);
  console.log(
    "`both` holds a filled seeking profile and a filled listing profile; its stored role is lister.",
  );
  console.log("");

  return table;
};

const isDirectInvocation = () =>
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectInvocation()) {
  run({ argv: process.argv.slice(2), env: process.env }).catch((error) => {
    if (error instanceof SeedSafetyError) {
      console.error(`seed: ${error.message}`);
      console.error("seed: nothing was written.");
    } else {
      console.error(`seed: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  });
}
