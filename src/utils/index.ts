export const toHex = (uInt8Arr: Uint8Array) => {
  return Array.from(uInt8Arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};
