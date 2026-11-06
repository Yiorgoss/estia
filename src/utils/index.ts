export const toHex = (uInt8Arr: Uint8Array) => {
  return Array.from(uInt8Arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const htmlEscapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// Room listings are user input, so anything interpolated into server-rendered
// HTML has to go through this first.
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => htmlEscapes[char] ?? char);
