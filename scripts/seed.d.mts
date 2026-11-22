/*
 * The public surface of `scripts/seed.mjs`. The seed script is plain Node ESM
 * because it runs outside the Worker bundle, and this declaration is what lets
 * the unit tests type-check against the same file the CLI runs.
 */

export interface SeedPhotoShape {
  readonly width: number;
  readonly height: number;
}

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
  readonly photos: ReadonlyArray<string>;
}

export declare const DEFAULT_BASE_URL: string;
export declare const SEED_PASSWORD: string;
export declare const LOCAL_HOSTNAMES: ReadonlySet<string>;
export declare const LISTING_PHOTO_MAX_BYTES: number;
export declare const SEED_USERS: ReadonlyArray<SeedUser>;
export declare const PHOTO_SHAPES: Readonly<Record<string, SeedPhotoShape>>;
export declare const ALL_PHOTO_SHAPES: ReadonlyArray<string>;
export declare const SEED_LISTINGS: ReadonlyArray<SeedListing>;

export declare class SeedSafetyError extends Error {}

export declare const assertLocalTarget: (input: {
  readonly environment?: string | undefined;
  readonly nodeEnv?: string | undefined;
  readonly argv?: ReadonlyArray<string>;
  readonly baseUrl?: string;
}) => URL;

export declare const formatCredentialsTable: (users: ReadonlyArray<SeedUser>) => string;
