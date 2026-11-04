import { head } from "../head";
import { header } from "../header";

export const createRoom = `<!DOCTYPE html>
<html lang="en">
<head>
  ${head}
  <style>
    :root {
      --bg: #f7f7f5;
      --surface: #ffffff;
      --text: #1d2327;
      --muted: #5f6b73;
      --border: #cfd6da;
      --accent: #1f6f5c;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #14181a;
        --surface: #1d2326;
        --text: #e8ecee;
        --muted: #98a4ab;
        --border: #38444a;
        --accent: #4fb89e;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2rem 1rem;
      background: var(--bg);
      color: var(--text);
      font: 16px/1.5 system-ui, sans-serif;
    }
    form {
      max-width: 560px;
      margin: 0 auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.5rem;
    }
    h1 { font-size: 1.4rem; margin: 0 0 1.25rem; }
    label { display: block; font-weight: 600; margin-bottom: .25rem; }
    .field { margin-bottom: 1rem; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    input[type=text], input[type=number], input[type=date], textarea {
      width: 100%;
      padding: .55rem .65rem;
      font: inherit;
      color: var(--text);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
    }
    textarea { min-height: 120px; resize: vertical; }
    input:focus-visible, textarea:focus-visible, button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    fieldset {
      border: 1px solid var(--border);
      border-radius: 6px;
      margin: 0 0 1rem;
      padding: .75rem 1rem;
    }
    legend { font-weight: 600; padding: 0 .35rem; }
    .check { display: flex; align-items: center; gap: .5rem; margin: .25rem 0; }
    .check label { margin: 0; font-weight: 400; }
    .hint { color: var(--muted); font-size: .85rem; }
    button {
      font: inherit;
      font-weight: 600;
      color: #fff;
      background: var(--accent);
      border: 0;
      border-radius: 6px;
      padding: .65rem 1.25rem;
      cursor: pointer;
    }
    .htmx-request button { opacity: .6; }
    #result { margin-top: 1rem; }
    @media (max-width: 480px) { .row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  ${header}
<form hx-post="/listings"
      hx-target="#result"
      hx-swap="innerHTML">

  <h1>New listing</h1>

  <div class="field">
    <label for="lister_id">Lister ID</label>
    <input type="number" id="lister_id" name="lister_id" min="1" required>
  </div>

  <div class="row">
    <div class="field">
      <label for="price">Price (per month)</label>
      <input type="number" id="price" name="price" min="0" step="0.01" required>
    </div>
    <div class="field">
      <label for="size">Size (m²)</label>
      <input type="number" id="size" name="size" min="0" step="0.1" required>
    </div>
  </div>

  <div class="field">
    <label for="location">Location</label>
    <input type="text" id="location" name="location" required>
  </div>

  <div class="field">
    <label for="description">Description</label>
    <textarea id="description" name="description" required></textarea>
  </div>

  <div class="field">
    <label for="availableFrom">Available from</label>
    <input type="date" id="availableFrom" name="availableFrom" required>
  </div>

  <fieldset>
    <legend>Details</legend>
    <div class="check">
      <input type="checkbox" id="furnished" name="furnished" value="true">
      <label for="furnished">Furnished</label>
    </div>
    <div class="check">
      <input type="checkbox" id="ensuite" name="ensuite" value="true">
      <label for="ensuite">Ensuite bathroom</label>
    </div>
    <div class="check">
      <input type="checkbox" id="smoking" name="smoking" value="true">
      <label for="smoking">Smoking allowed</label>
    </div>
    <div class="check">
      <input type="checkbox" id="pets" name="pets" value="true">
      <label for="pets">Pets allowed</label>
    </div>
    <p class="hint">Unchecked boxes are not sent, so treat a missing field as false on the server.</p>
  </fieldset>

  <button type="submit">Save listing</button>

  <div id="result" aria-live="polite"></div>
</form>

</body>
</html>
`;
