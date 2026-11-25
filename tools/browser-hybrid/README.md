# Commander V1-04 — Hybrid Browser CLI

A working owner-local browser automation product. The run modes use open-source engines, not a new scraping model:

- `auto`: Playwright 1.65.0 on a Chromium/Edge browser when available, then the existing Commander CDP engine, then Firefox/geckodriver.
- `playwright`: explicitly require Playwright Chromium, no fallback.
- `chromium`: Playwright Chromium if installed, otherwise Commander CDP.
- `firefox`: Selenium WebDriver 4.51 on Windows; the existing Commander Firefox WebDriver/geckodriver on Linux. Both use isolated managed profiles.
- `stagehand`: Browserbase Stagehand 4.4 local browser SDK (Chromium) with deterministic locators, DOM assertions and screenshots. Explicit opt-in; no AI provider or account token is used.

Playwright, Selenium and GeckoDriver are trusted open-source packages. Selenium uses the system Firefox; Playwright uses the system Chromium/Edge. This avoids downloading or reinventing browser engines.

The utility runs an **independent managed browser**. It never attaches to a personal signed-in browser, reads browser credential stores, sends passwords/cookies, or silently takes the user's desktop.

## Install in this directory

```
npm ci --ignore-scripts --no-audit --no-fund
node cli.mjs doctor
node cli.mjs smoke --engine=auto
node cli.mjs smoke --engine=firefox
node cli.mjs smoke --engine=stagehand
node cli.mjs run --engine=auto --url=https://example.com --steps=example-workflow.json --screenshot=example.png
```

The default `smoke` test starts a temporary, loopback-only HTML server and proves navigation, fill, click, text verification, image capture, redaction and cleanup. The real-site command uses Example Domain and creates `example.png` only if the path does not already exist.

For a portable user-local copy outside the repository, set `RC_BROWSER_CORE` to the **absolute path** of the installed Commander's `src/browser-tools.mjs` before using the native CDP or Firefox backend. `RC_BROWSER_DEPS` can point to an existing trusted Node package directory containing `playwright` or `playwright-core` (e.g. the preexisting `browser-hybrid/v1` runtime); installing a duplicate package is unnecessary in that case. Playwright Chromium launches a separate headless process and does not require a custom core module.

Workflows are JSON arrays of at most 32 steps: `navigate`, `fill`, `click`, `wait`, `expectText`, `expectTitle` or `screenshot`. No arbitrary JavaScript evaluation, personal profile mounting, password extraction, implicit uploads/downloads or unbounded background agents. Each flow closes its owned browser in `finally`. Screenshot output is an ordinary local PNG.

## Optional local AI observation (host-only Ollama)

A **real** Stagehand V4 `observe()` integration can be exercised against a synthetic localhost HTML fixture, with no personal browser session or external page:

```bash
# Requires an Ollama daemon at http://127.0.0.1:11434 and a locally installed model.
npm run ai:smoke
# Example when a different local model is installed:
RC_OLLAMA_MODEL=qwen3.5:4b node stagehand-ollama-smoke.mjs
```

`ollama-provider.mjs` accepts only `127.0.0.1:11434/api/chat`, text-only messages, structured JSON output, bounded prompts and inference timeout. It uses `think:false`, no cloud credentials, and rejects arbitrary remote endpoints. AI observation only *selects* the synthetic fixture's input; deterministic Browser SDK locators verify the selector and result. It does **not** grant autonomous actions against private pages. Successful end-to-end observations were verified on Emad PC with `qwen3.5:4b` and Emad Laptop with `qwen3:4b-instruct`; Emad Server's trial exceeded the inference deadline. Treat slow/unavailable local models as `NOT_READY`, not as a completed Agent. The regular `auto` engine is non-AI.

## Explicit real-site, localhost-model observation

On an explicitly authorized website, run a single-origin Stagehand+Ollama observation through the main CLI. The model only returns a CSS selector; the browser validates that it is unique and visible before any explicitly scripted action. A workflow can reference the selected element using `"selector":"@observed"` for `wait`, `fill`, or `click`. For `fill`, password inputs are not accepted.

```bash
# Real public website; requires a locally installed, responsive Ollama model.
node cli.mjs run --engine=stagehand --ai-model=qwen3.5:4b --allow-origin=https://example.com --url=https://example.com --steps=example-ai-workflow.json

# End-to-end AI fixture on localhost (no outside page context).
RC_OLLAMA_MODEL=qwen3.5:4b npm run ai:cli-smoke
```

The model mode is **opt-in**: `auto` and `stagehand` without `--ai-model` are deterministic. Both `--ai-model` and exact `--allow-origin` are mandatory; insecure non-loopback HTTP destinations and cross-origin navigation are rejected. The runner checks the active page origin before and after steps, validates observed selectors, and refuses an unresolved selector. This is not a network sandbox: embedded third-party resources are not blocked, and an explicitly scripted click may cause external side effects. Avoid unreviewed workflows on consequential pages. No personal signed-in browser profile is loaded.
## Scope and acceptance

This tool is a **source/portable canary**, not the signed Version 12 system installer. The repository's separate `browser_owner_route_plan` and guarded file-transfer APIs remain fail-closed until native V1-01 trusted grants and V1-03 same-owner consent arrive. Stagehand 4.4 is installed as a pinned dependency and has a verified deterministic, local-only backend selected with `--engine=stagehand`. Stagehand `observe()` is available on explicitly allowlisted origins using a host-local Ollama model. `act()` / `extract()` and autonomous site navigation remain disabled. Only in opt-in `--ai-model` mode, webpage context relevant to observation is passed to the host-local Ollama daemon. No cloud LLM provider or private user profile is attached. The production V1-08 writer owns release deployment and rollback.
