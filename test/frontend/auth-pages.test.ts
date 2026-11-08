import { decodeLoginForm, decodeRegisterForm } from "@/frontend/auth-form";
import { loginPage, registerPage } from "@/frontend/pages/auth";
import { assert, describe, it } from "@effect/vitest";

/*
 * The auth pages are plain server-rendered forms. These tests pin what the
 * browser needs from them: a well-formed document, a form that posts to the page
 * route, the repeat-password box the register route checks, and a button that
 * says what it does.
 */

describe("loginPage", () => {
  it("is a well-formed document with a form that posts to /login", () => {
    const page = loginPage();
    assert.include(page, "</head>");
    assert.notInclude(page, "</head\n");
    assert.include(page, 'name="viewport"');
    assert.include(page, 'action="/login"');
    assert.include(page, 'method="post"');
    assert.include(page, 'name="email"');
    assert.include(page, 'name="password"');
    assert.include(page, ">Sign in</button>");
    // The page route is the surface, so the JSON endpoint is not the action.
    assert.notInclude(page, "hx-post");
    assert.notInclude(page, "/api/auth/");
  });

  it("shows a message and keeps the address after a rejected submit", () => {
    const page = loginPage({
      email: "ada@example.com",
      message: "That email and password do not match.",
    });
    assert.include(page, 'value="ada@example.com"');
    assert.include(page, 'role="alert"');
    assert.include(page, "That email and password do not match.");
  });

  it("escapes an address echoed back into the form", () => {
    const page = loginPage({ email: '" onfocus="alert(1)' });
    assert.notInclude(page, '" onfocus="alert(1)');
    assert.include(page, "&quot; onfocus=&quot;alert(1)");
  });
});

describe("registerPage", () => {
  it("posts to /register with the repeat-password box and an honest button label", () => {
    const page = registerPage();
    assert.include(page, "</head>");
    assert.include(page, 'name="viewport"');
    assert.include(page, 'action="/register"');
    assert.include(page, 'name="password"');
    assert.include(page, 'name="repeat_password"');
    assert.include(page, 'for="repeat_password"');
    assert.include(page, ">Create account</button>");
    assert.notInclude(page, ">Login</button>");
  });
});

describe("the auth form decoders", () => {
  it("read the fields a browser submits", () => {
    const login = decodeLoginForm({ email: " ada@example.com ", password: "secret" });
    assert.isTrue(login.ok);
    if (login.ok)
      assert.deepStrictEqual(login.input, { email: "ada@example.com", password: "secret" });

    const register = decodeRegisterForm({
      email: "ada@example.com",
      password: "secret",
      repeat_password: "secret",
    });
    assert.isTrue(register.ok);
    if (register.ok)
      assert.deepStrictEqual(register.input, { email: "ada@example.com", password: "secret" });
  });

  it("keep a repeated field's first value, since a form can send one twice", () => {
    const result = decodeLoginForm({
      email: ["ada@example.com", "grace@example.com"],
      password: "secret",
    });
    assert.isTrue(result.ok);
    if (result.ok) assert.strictEqual(result.input.email, "ada@example.com");
  });

  it("report a mismatched repeat password", () => {
    const result = decodeRegisterForm({
      email: "ada@example.com",
      password: "secret",
      repeat_password: "secreto",
    });
    assert.isFalse(result.ok);
    if (!result.ok) assert.include(result.message, "do not match");
  });

  it("report a missing field", () => {
    const result = decodeRegisterForm({
      email: "ada@example.com",
      password: "",
      repeat_password: "",
    });
    assert.isFalse(result.ok);
    if (!result.ok) assert.strictEqual(result.message, "Choose a password.");
  });
});
