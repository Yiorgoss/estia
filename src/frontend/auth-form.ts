import { UserCredentials } from "@/db/schema/User";

/*
 * The sign-in and registration pages are ordinary forms, so the browser submits
 * their fields as `application/x-www-form-urlencoded`. This module reads that
 * body and turns it into the same `UserCredentials` the JSON API decodes, so both
 * surfaces run the auth service with the same input, and it names what is wrong
 * in words the page can show.
 *
 * An HTML form submits every named field, so absent and blank are the same thing
 * here. A repeated field keeps its first value.
 */

export type AuthFormParams = Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;

export type AuthFormResult<A> =
  | { readonly ok: true; readonly input: A }
  | { readonly ok: false; readonly message: string };

const text = (params: AuthFormParams, name: string): string => {
  const value = params[name];
  if (typeof value === "string") return value;
  return Array.isArray(value) ? (value[0] ?? "") : "";
};

// The page echoes the address back after a rejected submit, so it is read once
// and trimmed here rather than in each error branch.
export const authFormEmail = (params: AuthFormParams): string => text(params, "email").trim();

export const decodeLoginForm = (
  params: AuthFormParams,
): AuthFormResult<typeof UserCredentials.Type> => {
  const email = authFormEmail(params);
  const password = text(params, "password");
  if (email === "") return { ok: false, message: "Enter the email address for your account." };
  if (password === "") return { ok: false, message: "Enter your password." };
  return { ok: true, input: { email, password } };
};

export const decodeRegisterForm = (
  params: AuthFormParams,
): AuthFormResult<typeof UserCredentials.Type> => {
  const email = authFormEmail(params);
  const password = text(params, "password");
  const repeated = text(params, "repeat_password");
  if (email === "") return { ok: false, message: "Enter the email address you want to use." };
  if (password === "") return { ok: false, message: "Choose a password." };
  // The repeat box exists to catch a typo before an account is created, so a
  // mismatch is reported instead of being dropped from the request.
  if (password !== repeated) {
    return {
      ok: false,
      message: "The two passwords do not match. Type the same password in both boxes.",
    };
  }
  return { ok: true, input: { email, password } };
};
