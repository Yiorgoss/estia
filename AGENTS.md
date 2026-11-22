## INSTRUCTIONS

When writing Effect code, inspect @vendor/effect/ for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

Use the Effect (`effect`) TypeScript library to write all scripts in this repository.

## Vendored Repositories

This project vendors external repositories under @vendor/

- Use vendored repositories as read-only reference material when working with related libraries
- Prefer examples and patterns from the vendored source code over generated guesses or web search results
- Do not edit files under @vendor/ unless explicitly asked
- Do not import from @vendor/ - application code should continue importing from normal package dependencies
