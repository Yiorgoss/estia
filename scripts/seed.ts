#!/usr/bin/env node
/*
 * Development seed data for estia, written with Effect.
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

import { Cause, Config, Console, Duration, Effect, Exit, Option, Ref, Schema } from "effect";
import { Cookies, FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpMethod } from "effect/http/HttpMethod";

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
export const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Environment values that mean "this is not a dev machine". `prod` is the
// wrangler environment name this repository uses, so it is refused as well.
const NON_LOCAL_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "production",
  "prod",
  "staging",
  "stage",
  "remote",
]);

// The environments `--env` may name. Only the deployed test environment is
// seedable remotely; `--env prod` and friends are refused by name.
const SEEDABLE_ENVIRONMENTS: ReadonlySet<string> = new Set(["test"]);

// Flags that ask for a remote or production target. `--remote` is wrangler's
// own flag, so passing it here means the caller expected a wrangler command and
// not this script; refusing it keeps the two workflows apart.
const REMOTE_FLAGS: ReadonlySet<string> = new Set([
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
const PHOTO_CONTENT_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);

/*
 * The failures the script can report. Each one is a schema-backed tagged error,
 * so a handler can branch on `_tag` and the CLI can print a cause without
 * guessing what went wrong.
 */

/*
 * A refusal, rather than a failure: the script was asked to do something that is
 * only safe on a developer machine or the test environment, and it did not try.
 */
export class SeedSafetyError extends Schema.TaggedError<SeedSafetyError>()("SeedSafetyError", {
  message: Schema.String,
}) {}

// Nothing answered the health check, so the target is not running or not
// deployed yet.
export class SeedNoServerError extends Schema.TaggedError<SeedNoServerError>()("SeedNoServerError", {
  healthUrl: Schema.String,
  target: Schema.String,
}) {}

// An API call was refused, or answered a body the seed could not read.
export class SeedRequestError extends Schema.TaggedError<SeedRequestError>()("SeedRequestError", {
  label: Schema.String,
  status: Schema.Number,
  detail: Schema.String,
}) {}

// A photo could not be fetched, was not an accepted image, or did not read back
// from the gallery.
export class SeedPhotoError extends Schema.TaggedError<SeedPhotoError>()("SeedPhotoError", {
  url: Schema.String,
  detail: Schema.String,
}) {}

export type SeedError = SeedSafetyError | SeedNoServerError | SeedRequestError | SeedPhotoError;

// The whole run can also fail while reading its own configuration.
export type SeedRunError = SeedError | Config.ConfigError;

/*
 * The accounts the seed creates. `role` is what the logins table says: an
 * account that both seeks and lists carries two filled profiles, which this app
 * models as a seeker profile and a lister profile on one account, with the
 * stored role left on `lister`.
 */
export interface SeedSeekerProfile {
  readonly name: string;
  readonly dateOfBirth: string;
  readonly gender: "male" | "female" | "NB";
  readonly bio: string;
  readonly smoking: 0 | 1;
  readonly pets: 0 | 1;
}

export interface SeedListerProfile {
  readonly name: string;
  readonly ownership: "owner" | "leaseholder";
}

export interface SeedUser {
  readonly email: string;
  readonly password: string;
  readonly role: "lister" | "seeker" | "both";
  readonly seeker?: SeedSeekerProfile;
  readonly lister?: SeedListerProfile;
}

export const SEED_USERS: ReadonlyArray<SeedUser> = [
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

export interface SeedPhotoShape {
  readonly width: number;
  readonly height: number;
}

export type SeedPhotoShapeName = "landscape" | "portrait" | "square" | "panoramic" | "tall" | "small";

/*
 * The photo shapes the seed asks the image API for: one of each aspect ratio and
 * size the layout has to survive. The first shape of a listing is its card
 * image, so every listing opens with a landscape frame.
 */
export const PHOTO_SHAPES: Readonly<Record<SeedPhotoShapeName, SeedPhotoShape>> = {
  landscape: { width: 1200, height: 800 },
  portrait: { width: 600, height: 900 },
  square: { width: 800, height: 800 },
  panoramic: { width: 1600, height: 600 },
  tall: { width: 400, height: 1000 },
  small: { width: 320, height: 240 },
};

export const ALL_PHOTO_SHAPES: ReadonlyArray<SeedPhotoShapeName> = [
  "landscape",
  "portrait",
  "square",
  "panoramic",
  "tall",
  "small",
];

export interface SeedListing {
  readonly owner: string;
  readonly title: string;
  readonly kind: "room" | "whole_property" | "room_wanted";
  readonly description: string;
  readonly priceMinor: number;
  readonly regionCode: string;
  readonly lat: number;
  readonly lng: number;
  readonly sizeSqm: number;
  readonly availableFrom: string;
  readonly furnished: 0 | 1;
  readonly ensuite: 0 | 1;
  readonly smoking: 0 | 1;
  readonly pets: 0 | 1;
  readonly photos: ReadonlyArray<SeedPhotoShapeName>;
}

/*
 * Listings across the regions, kinds, and prices a search has to page through.
 * The title is the idempotency key: it is written once and looked up on every
 * later run, so a re-run reuses the row instead of creating a twin.
 */
export const SEED_LISTINGS: ReadonlyArray<SeedListing> = [
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

const CREDENTIAL_HEADERS: ReadonlyArray<string> = ["EMAIL", "PASSWORD", "ROLE"];

const credentialRows = (users: ReadonlyArray<SeedUser>): ReadonlyArray<ReadonlyArray<string>> =>
  users.map((user) => [user.email, user.password, user.role]);

/*
 * The logins table printed at the end of a run and repeated in `docs/seed.md`.
 * Column widths follow the widest cell, so the same table reads the same in both
 * places and a new account never breaks the alignment.
 */
export const formatCredentialsTable = (users: ReadonlyArray<SeedUser>): string => {
  const rows = [CREDENTIAL_HEADERS, ...credentialRows(users)];
  const widths = CREDENTIAL_HEADERS.map((_header, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  const render = (row: ReadonlyArray<string>): string =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  const rule = widths.map((width) => "-".repeat(width)).join("  ");
  return [render(CREDENTIAL_HEADERS), rule, ...credentialRows(users).map(render)].join("\n");
};

// --- the target guard ------------------------------------------------------

export interface SeedTargetInput {
  readonly environment?: string | undefined;
  readonly nodeEnv?: string | undefined;
  readonly argv?: ReadonlyArray<string>;
  readonly baseUrl?: string;
}

/*
 * The one gate in front of every network call, as a refusal effect. The target
 * has to be a loopback address or the named test host, because a production
 * database is reachable by neither. The environment checks are belt and braces
 * for the same intent: a shell that says "production" is not a shell this tool
 * should act in, even before the address is read.
 *
 * A remote target is only ever the test environment, and only over HTTPS: the
 * custom domain is HTTPS-only, so a plain-HTTP spelling is a mistake rather
 * than a supported target.
 */
export const assertSeedTarget = (
  input: SeedTargetInput,
): Effect.Effect<URL, SeedSafetyError> =>
  Effect.gen(function* () {
    const environmentValue = String(input.environment ?? "")
      .trim()
      .toLowerCase();
    if (NON_LOCAL_ENVIRONMENTS.has(environmentValue)) {
      return yield* Effect.fail(
        new SeedSafetyError({
          message: `Refusing to seed: ENVIRONMENT=${input.environment} is not a local or test environment.`,
        }),
      );
    }

    const nodeEnvValue = String(input.nodeEnv ?? "")
      .trim()
      .toLowerCase();
    if (NON_LOCAL_ENVIRONMENTS.has(nodeEnvValue)) {
      return yield* Effect.fail(
        new SeedSafetyError({
          message: `Refusing to seed: NODE_ENV=${input.nodeEnv} is not a local or test environment.`,
        }),
      );
    }

    const argv = input.argv ?? [];
    const remoteFlag = argv.find((argument) => REMOTE_FLAGS.has(argument));
    if (remoteFlag !== undefined) {
      return yield* Effect.fail(
        new SeedSafetyError({
          message: `Refusing to seed: ${remoteFlag} targets a remote worker or production, and this script only seeds a local dev server or the test environment.`,
        }),
      );
    }

    let url: URL;
    try {
      url = new URL(input.baseUrl ?? DEFAULT_BASE_URL);
    } catch {
      return yield* Effect.fail(
        new SeedSafetyError({
          message: `Refusing to seed: "${input.baseUrl}" is not a URL.`,
        }),
      );
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return yield* Effect.fail(
        new SeedSafetyError({
          message: `Refusing to seed: ${url.protocol} is not an HTTP address a dev server or the test environment listens on.`,
        }),
      );
    }

    if (LOCAL_HOSTNAMES.has(url.hostname)) return url;

    if (url.hostname === TEST_HOSTNAME) {
      if (url.protocol !== "https:") {
        return yield* Effect.fail(
          new SeedSafetyError({
            message: `Refusing to seed: the test environment is only reachable over HTTPS. Use ${TEST_BASE_URL}.`,
          }),
        );
      }
      // The deployed custom domain answers on the default HTTPS port; any other
      // port is a different listener, so it is not the test environment.
      if (url.port !== "" && url.port !== "443") {
        return yield* Effect.fail(
          new SeedSafetyError({
            message: `Refusing to seed: ${url.host} is neither a local loopback address nor the test environment ${TEST_HOSTNAME}.`,
          }),
        );
      }
      return url;
    }

    return yield* Effect.fail(
      new SeedSafetyError({
        message:
          `Refusing to seed: ${url.hostname} is neither a local loopback address nor the test environment ${TEST_HOSTNAME}. ` +
          `Set SEED_BASE_URL to http://127.0.0.1:<port> for a dev server, or use \`pnpm seed:test\` for ${TEST_HOSTNAME}.`,
      }),
    );
  });

/*
 * The `--env` names on the command line, in both spellings the CLI accepts. A
 * missing value is reported as an empty one so `--env` alone is a readable
 * refusal instead of a silent local run.
 */
const environmentFlags = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const values: Array<string> = [];
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
export const resolveSeedTarget = (
  input: SeedTargetInput,
): Effect.Effect<URL, SeedSafetyError> => {
  const argv = input.argv ?? [];
  return Effect.gen(function* () {
    for (const requested of environmentFlags(argv)) {
      if (!SEEDABLE_ENVIRONMENTS.has(requested)) {
        return yield* Effect.fail(
          new SeedSafetyError({
            message:
              `Refusing to seed: --env ${requested === "" ? "(no value)" : requested} is not a seedable environment. ` +
              `Only "test" may be seeded remotely, and a local dev server needs no --env.`,
          }),
        );
      }
    }

    const wantsTest = environmentFlags(argv).includes("test") || argv.includes("--test");
    return yield* assertSeedTarget({
      ...input,
      baseUrl: wantsTest ? TEST_BASE_URL : (input.baseUrl ?? DEFAULT_BASE_URL),
    });
  });
};

// --- the HTTP session ------------------------------------------------------

interface SeedSession {
  readonly baseUrl: URL;
  readonly jar: Ref.Ref<Record<string, string>>;
}

interface SeedResponse {
  readonly status: number;
  readonly text: string;
}

const cookieHeader = (jar: Record<string, string>): string =>
  Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

const isSuccessStatus = (status: number): boolean => status >= 200 && status < 300;

const describeBody = (text: string): string =>
  text === "" ? "(empty body)" : text.replace(/\s+/g, " ").slice(0, 400);

const requestFailure = (label: string, status: number, detail: string): SeedRequestError =>
  new SeedRequestError({ label, status, detail });

/*
 * One request through the shared Effect HTTP client. The cookie jar is merged
 * from the response's `Set-Cookie` headers after every call, which is how the
 * session the server proves travels through the rest of the run, including a
 * rotated pair.
 */
const request = (
  session: SeedSession,
  method: HttpMethod,
  path: string,
  options: { readonly payload?: unknown; readonly form?: FormData } = {},
): Effect.Effect<SeedResponse, SeedRequestError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const label = `${method} ${path}`;
    const url = new URL(path, session.baseUrl);
    const jar = yield* Ref.get(session.jar);
    const headers: Record<string, string> = {};
    const cookie = cookieHeader(jar);
    if (cookie !== "") headers["cookie"] = cookie;

    let body: HttpBody.HttpBody | undefined;
    if (options.payload !== undefined) {
      body = HttpBody.jsonUnsafe(options.payload);
    } else if (options.form !== undefined) {
      body = HttpBody.formData(options.form);
    }

    const clientRequest = HttpClientRequest.make(method)(
      url,
      body === undefined ? { headers } : { headers, body },
    );

    const response = yield* HttpClient.execute(clientRequest).pipe(
      Effect.mapError((error) => requestFailure(label, 0, String(error))),
      Effect.timeoutOrElse({
        duration: Duration.seconds(30),
        orElse: () => Effect.fail(requestFailure(label, 0, "the request timed out")),
      }),
    );

    const cookies = Cookies.toRecord(response.cookies);
    if (Object.keys(cookies).length > 0) {
      yield* Ref.update(session.jar, (current) => ({ ...current, ...cookies }));
    }

    const text = yield* response.text.pipe(
      Effect.mapError((error) => requestFailure(label, response.status, String(error))),
    );

    return { status: response.status, text };
  });

const expectSuccess = (
  label: string,
  response: SeedResponse,
): Effect.Effect<SeedResponse, SeedRequestError> =>
  isSuccessStatus(response.status)
    ? Effect.succeed(response)
    : Effect.fail(
        requestFailure(label, response.status, describeBody(response.text)),
      );

const jsonOf = (text: string): unknown => {
  try {
    return text === "" ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
};

/*
 * A response body decoded through a schema, with every failure - a refused
 * status, a non-JSON body, a shape the schema rejects - reported as one request
 * error naming the call.
 */
const decodeResponse = <A, I>(
  schema: Schema.Codec<A, I>,
  label: string,
  response: SeedResponse,
): Effect.Effect<A, SeedRequestError> =>
  Effect.gen(function* () {
    if (!isSuccessStatus(response.status)) {
      return yield* Effect.fail(
        requestFailure(label, response.status, describeBody(response.text)),
      );
    }
    const json = jsonOf(response.text);
    if (json === undefined) {
      return yield* Effect.fail(
        requestFailure(label, response.status, "the body was not JSON"),
      );
    }
    return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
      Effect.mapError((error) => requestFailure(label, response.status, String(error))),
    );
  });

// --- the API shapes the seed reads -----------------------------------------

const ListingSummary = Schema.Struct({
  id: Schema.Number,
  title: Schema.String,
  status: Schema.String,
});

const ListingPage = Schema.Struct({
  items: Schema.Array(ListingSummary),
});

const ListingCreated = Schema.Struct({
  id: Schema.Number,
  status: Schema.String,
});

const ListingDetail = Schema.Struct({
  photos: Schema.Array(Schema.Struct({ url: Schema.String })),
});

// --- seeding steps ---------------------------------------------------------

const waitForServer = (
  target: URL,
): Effect.Effect<void, SeedNoServerError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const healthUrl = new URL("/api/health", target);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const healthy = yield* HttpClient.get(healthUrl).pipe(
        Effect.map((response) => isSuccessStatus(response.status)),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (healthy) return;
      yield* Effect.sleep(Duration.seconds(1));
    }
    return yield* Effect.fail(
      new SeedNoServerError({ healthUrl: healthUrl.href, target: target.origin }),
    );
  });

const openSession = (baseUrl: URL): Effect.Effect<SeedSession> =>
  Effect.map(Ref.make<Record<string, string>>({}), (jar) => ({ baseUrl, jar }));

const signIn = (
  session: SeedSession,
  user: SeedUser,
): Effect.Effect<"signed in" | "registered", SeedRequestError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const label = `Sign in as ${user.email}`;
    const login = yield* request(session, "POST", "/api/auth/login", {
      payload: { email: user.email, password: user.password },
    });
    if (login.status === 200) return "signed in" as const;

    if (login.status !== 401) {
      yield* expectSuccess(label, login);
    }

    const registerLabel = `Register ${user.email}`;
    const registered = yield* request(session, "POST", "/api/auth/register", {
      payload: { email: user.email, password: user.password },
    });
    if (registered.status === 409) {
      return yield* Effect.fail(
        requestFailure(
          registerLabel,
          409,
          `${user.email} already exists with another password. Delete that local account, or change the seed password.`,
        ),
      );
    }
    yield* expectSuccess(registerLabel, registered);
    return "registered" as const;
  });

/*
 * An account's stored role decides which profile the API will accept, so the
 * seed moves the account to the role it is filling first. Asking for the role
 * the account already holds is a no-op the service answers with the profile.
 */
const ensureRole = (
  session: SeedSession,
  email: string,
  role: "seeker" | "lister",
): Effect.Effect<void, SeedRequestError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const label = `Switch ${email} to ${role}`;
    const response = yield* request(session, "POST", `/api/users/change-role?role=${role}`);
    yield* expectSuccess(label, response);
  });

const seekerPayload = (profile: SeedSeekerProfile): unknown => ({
  name: profile.name,
  dateOfBirth: Date.parse(`${profile.dateOfBirth}T00:00:00Z`),
  gender: profile.gender,
  bio: profile.bio,
  smoking: profile.smoking,
  pets: profile.pets,
});

const listerPayload = (profile: SeedListerProfile): unknown => ({
  name: profile.name,
  ownership: profile.ownership,
});

const saveProfile = (
  session: SeedSession,
  email: string,
  role: "seeker" | "lister",
  user: SeedUser,
): Effect.Effect<void, SeedRequestError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const label = `Save the ${role} profile of ${email}`;
    if (role === "seeker") {
      const profile = user.seeker;
      if (profile === undefined) {
        return yield* Effect.fail(
          requestFailure(label, 0, `${email} has no seeking profile in the seed plan`),
        );
      }
      const response = yield* request(session, "PUT", "/api/users/profile", {
        payload: seekerPayload(profile),
      });
      yield* expectSuccess(label, response);
      return;
    }

    const profile = user.lister;
    if (profile === undefined) {
      return yield* Effect.fail(
        requestFailure(label, 0, `${email} has no listing profile in the seed plan`),
      );
    }
    const response = yield* request(session, "PUT", "/api/users/profile", {
      payload: listerPayload(profile),
    });
    yield* expectSuccess(label, response);
  });

const seedUser = (
  session: SeedSession,
  user: SeedUser,
): Effect.Effect<"signed in" | "registered", SeedRequestError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const outcome = yield* signIn(session, user);

    // A dual-role account fills both profile rows: the seeking one first, then
    // the switch to listing, so the account ends up holding both.
    if (user.role === "seeker" || user.role === "both") {
      yield* ensureRole(session, user.email, "seeker");
      yield* saveProfile(session, user.email, "seeker", user);
    }
    if (user.role === "lister" || user.role === "both") {
      yield* ensureRole(session, user.email, "lister");
      yield* saveProfile(session, user.email, "lister", user);
    }

    return outcome;
  });

const listingPayload = (listing: SeedListing): unknown => ({
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

const photoSeed = (listing: SeedListing, shape: SeedPhotoShapeName): string =>
  `estia-${listing.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}-${shape}`;

interface SeedPhoto {
  readonly shape: SeedPhotoShapeName;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/*
 * One picture from the public image API, at the requested shape. The redirect to
 * the image host is followed by the client, the bytes are checked against the
 * gallery's rules, and a picture over the size ceiling is asked for again at
 * half the dimensions so a seed run never fails on an unlucky photograph.
 */
const fetchPhoto = (
  listing: SeedListing,
  shapeName: SeedPhotoShapeName,
): Effect.Effect<SeedPhoto, SeedPhotoError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const shape = PHOTO_SHAPES[shapeName];
    let width = shape.width;
    let height = shape.height;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const url = `https://picsum.photos/seed/${photoSeed(listing, shapeName)}/${width}/${height}`;
      const response = yield* HttpClient.get(url).pipe(
        Effect.mapError((error) => new SeedPhotoError({ url, detail: String(error) })),
        Effect.timeoutOrElse({
          duration: Duration.seconds(60),
          orElse: () => Effect.fail(new SeedPhotoError({ url, detail: "the request timed out" })),
        }),
      );

      if (!isSuccessStatus(response.status)) {
        return yield* Effect.fail(
          new SeedPhotoError({ url, detail: `the image API answered HTTP ${response.status}` }),
        );
      }

      const declared = (response.headers["content-type"] ?? "").toLowerCase();
      const contentType = declared.split(";")[0]?.trim() ?? "";
      if (!PHOTO_CONTENT_TYPES.has(contentType)) {
        return yield* Effect.fail(
          new SeedPhotoError({ url, detail: `the image API answered ${declared || "no content type"}` }),
        );
      }

      const bytes = new Uint8Array(
        yield* response.arrayBuffer.pipe(
          Effect.mapError((error) => new SeedPhotoError({ url, detail: String(error) })),
        ),
      );

      if (bytes.length <= LISTING_PHOTO_MAX_BYTES) {
        return { shape: shapeName, contentType, bytes } satisfies SeedPhoto;
      }

      width = Math.max(160, Math.floor(width / 2));
      height = Math.max(160, Math.floor(height / 2));
    }

    return yield* Effect.fail(
      new SeedPhotoError({
        url: `https://picsum.photos/seed/${photoSeed(listing, shapeName)}/${shape.width}/${shape.height}`,
        detail: `could not fetch a ${shapeName} photo small enough for the gallery`,
      }),
    );
  });

const uploadPhoto = (
  session: SeedSession,
  listingId: number,
  photo: SeedPhoto,
): Effect.Effect<void, SeedRequestError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const label = `Upload the ${photo.shape} photo to listing ${listingId}`;
    const form = new FormData();
    form.append(
      "photos",
      new Blob([photo.bytes], { type: photo.contentType }),
      `seed-${photo.shape}.${photo.contentType.split("/")[1] ?? "jpg"}`,
    );
    const response = yield* request(session, "POST", `/listings/${listingId}/photos`, { form });
    // The upload route answers a person with a redirect back to the edit page,
    // which the HTTP client follows, so a stored photo lands on that page's 200.
    if (response.status === 200 || response.status === 303) return;
    return yield* Effect.fail(requestFailure(label, response.status, describeBody(response.text)));
  });

const publicListing = (
  session: SeedSession,
  listingId: number,
): Effect.Effect<Option.Option<typeof ListingDetail.Type>, SeedRequestError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const label = `Read listing ${listingId}`;
    const response = yield* request(session, "GET", `/api/listings/${listingId}`);
    if (response.status === 404) return Option.none();
    return Option.some(yield* decodeResponse(ListingDetail, label, response));
  });

const mineListings = (
  session: SeedSession,
): Effect.Effect<
  ReadonlyArray<typeof ListingSummary.Type>,
  SeedRequestError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const response = yield* request(session, "GET", "/api/listings/mine?limit=50");
    const page = yield* decodeResponse(ListingPage, "Read the owner's listings", response);
    return page.items;
  });

const publishListing = (
  session: SeedSession,
  listingId: number,
): Effect.Effect<void, SeedRequestError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const response = yield* request(session, "POST", `/api/listings/${listingId}/publish`);
    yield* expectSuccess(`Publish listing ${listingId}`, response);
  });

/*
 * Proves the seeded gallery is readable the way a browser reads it: every
 * original and every card image answers 200 with an image type. This is the
 * check that R2, the `listing_photos` row, and the thumbnails all really exist.
 */
const verifyPhotos = (
  session: SeedSession,
  listingId: number,
): Effect.Effect<number, SeedRequestError | SeedPhotoError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const detail = yield* publicListing(session, listingId);
    const photos = Option.isSome(detail) ? detail.value.photos : [];

    for (const photo of photos) {
      for (const path of [photo.url, `${photo.url}/card`]) {
        const url = new URL(path, session.baseUrl);
        const response = yield* HttpClient.get(url).pipe(
          Effect.mapError((error) => new SeedPhotoError({ url: url.href, detail: String(error) })),
          Effect.timeoutOrElse({
            duration: Duration.seconds(60),
            orElse: () => Effect.fail(new SeedPhotoError({ url: url.href, detail: "the request timed out" })),
          }),
        );
        if (!isSuccessStatus(response.status)) {
          return yield* Effect.fail(
            new SeedPhotoError({ url: url.href, detail: `answered HTTP ${response.status}` }),
          );
        }
        const contentType = response.headers["content-type"] ?? "";
        if (!contentType.toLowerCase().startsWith("image/")) {
          return yield* Effect.fail(
            new SeedPhotoError({ url: url.href, detail: `answered ${contentType || "no content type"}` }),
          );
        }
        yield* response.arrayBuffer.pipe(
          Effect.mapError((error) => new SeedPhotoError({ url: url.href, detail: String(error) })),
          Effect.asVoid,
        );
      }
    }

    return photos.length;
  });

interface SeededListing {
  readonly listingId: number;
  readonly photos: number;
  readonly reused: boolean;
}

const seedListing = (
  session: SeedSession,
  listing: SeedListing,
  existing: typeof ListingSummary.Type | undefined,
): Effect.Effect<SeededListing, SeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    let listingId: number;
    let status: string;

    if (existing === undefined) {
      const label = `Create "${listing.title}"`;
      const created = yield* decodeResponse(
        ListingCreated,
        label,
        yield* request(session, "POST", "/api/listings", { payload: listingPayload(listing) }),
      );
      listingId = created.id;
      status = created.status;
    } else {
      listingId = existing.id;
      status = existing.status;
    }

    if (status !== "published") {
      yield* publishListing(session, listingId);
    }

    const detail = yield* publicListing(session, listingId);
    const alreadyUploaded = Option.isSome(detail) ? detail.value.photos.length : 0;
    const wanted = listing.photos.slice(alreadyUploaded);

    for (const shapeName of wanted) {
      const photo = yield* fetchPhoto(listing, shapeName);
      yield* uploadPhoto(session, listingId, photo);
    }

    const photos = yield* verifyPhotos(session, listingId);
    return { listingId, photos, reused: existing !== undefined };
  });

// --- the program -----------------------------------------------------------

const seedProgram = (target: URL): Effect.Effect<void, SeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    yield* waitForServer(target);

    const listingsByOwner = new Map<string, Array<SeedListing>>();
    for (const listing of SEED_LISTINGS) {
      const owned = listingsByOwner.get(listing.owner) ?? [];
      owned.push(listing);
      listingsByOwner.set(listing.owner, owned);
    }

    let listingCount = 0;
    let photoCount = 0;

    for (const user of SEED_USERS) {
      const session = yield* openSession(target);
      const outcome = yield* seedUser(session, user);
      yield* Console.log(`  ${user.email} (${user.role}): ${outcome}`);

      const existing = new Map(
        (yield* mineListings(session)).map((item) => [item.title, item] as const),
      );
      for (const listing of listingsByOwner.get(user.email) ?? []) {
        const seeded = yield* seedListing(session, listing, existing.get(listing.title));
        listingCount += 1;
        photoCount += seeded.photos;
        const verb = seeded.reused ? "reused" : "created";
        yield* Console.log(
          `    ${verb} "${listing.title}" (id ${seeded.listingId}, ${seeded.photos} photos)`,
        );
      }
    }

    const table = formatCredentialsTable(SEED_USERS);
    yield* Console.log("");
    yield* Console.log(
      `Seed complete against ${target.origin}: ${SEED_USERS.length} accounts, ${listingCount} listings, ${photoCount} photos.`,
    );
    yield* Console.log("");
    yield* Console.log(table);
    yield* Console.log("");
    yield* Console.log(`Password for every seeded account: ${SEED_PASSWORD}`);
    yield* Console.log(
      "`both` holds a filled seeking profile and a filled listing profile; its stored role is lister.",
    );
    yield* Console.log("");
  });

/*
 * The run: read the environment through `Config`, choose the target through the
 * guard, and seed. `argv` stays an argument because command-line arguments are
 * not configuration, and because the guard's tests drive it directly.
 */
export const seed = (
  argv: ReadonlyArray<string>,
): Effect.Effect<void, SeedRunError> =>
  Effect.gen(function* () {
    const environment = yield* Config.String("ENVIRONMENT").pipe(Config.withDefault(""));
    const nodeEnv = yield* Config.String("NODE_ENV").pipe(Config.withDefault(""));
    const baseUrl = yield* Config.String("SEED_BASE_URL").pipe(
      Config.withDefault(DEFAULT_BASE_URL),
    );

    const target = yield* resolveSeedTarget({ argv, environment, nodeEnv, baseUrl });

    if (target.hostname === TEST_HOSTNAME) {
      yield* Console.log(`Seeding the shared test environment ${target.origin}`);
    } else {
      yield* Console.log(`Seeding ${target.origin}`);
    }

    yield* seedProgram(target);
  }).pipe(Effect.provide(FetchHttpClient.layer));

const isDirectInvocation = (): boolean =>
  process.argv[1] !== undefined && import.meta.filename === process.argv[1];

/*
 * One line per failure, in the words the person running the script needs. The
 * cause is only rendered for a defect, where there is no typed error to explain.
 */
const reportFailure = (cause: Cause.Cause<SeedRunError>): void => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) {
    const error = failure.value;
    switch (error._tag) {
      case "SeedSafetyError":
        console.error(`seed: ${error.message}`);
        console.error("seed: nothing was written.");
        return;
      case "SeedNoServerError":
        console.error(
          error.target === TEST_BASE_URL
            ? `seed: no server answered ${error.healthUrl}. Check that ${TEST_BASE_URL} is deployed (\`pnpm deploy:test\`), then run \`pnpm seed:test\` again.`
            : `seed: no server answered ${error.healthUrl}. Start one with \`pnpm dev\`, then run \`pnpm seed\` again.`,
        );
        return;
      case "SeedRequestError":
        console.error(
          `seed: ${error.label} answered HTTP ${error.status}: ${error.detail}`,
        );
        return;
      case "SeedPhotoError":
        console.error(`seed: ${error.url}: ${error.detail}`);
        return;
      case "ConfigError":
        console.error(`seed: ${error.message}`);
        return;
    }
  }
  console.error(`seed: ${Cause.pretty(cause)}`);
};

if (isDirectInvocation()) {
  const exit = await Effect.runPromiseExit(seed(process.argv.slice(2)));
  if (Exit.isFailure(exit)) {
    reportFailure(exit.cause);
    process.exitCode = 1;
  }
}
