#!/usr/bin/env node
// Installs the Rust evaluator that `quint run` needs, retrying the download.
//
// Quint fetches the evaluator on first use with one unauthenticated GitHub API
// request and no retry, so a single 504 or rate-limit answer fails the calling
// command. CI runs this first, so later `quint run` calls find the evaluator
// already installed. It is a no-op when the evaluator is present.

import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { getRustEvaluatorPath, QUINT_EVALUATOR_VERSION } = require(
  "@informalsystems/quint/dist/src/rust/binaryManager.js",
);

const attempts = Number(process.env.QUINT_EVALUATOR_ATTEMPTS ?? 6);
const baseDelayMs = Number(process.env.QUINT_EVALUATOR_RETRY_MS ?? 10_000);

for (let attempt = 1; ; attempt += 1) {
  try {
    const evaluator = await getRustEvaluatorPath();
    console.log(`Rust evaluator ${QUINT_EVALUATOR_VERSION} ready at ${evaluator}`);
    break;
  } catch (error) {
    if (attempt >= attempts) {
      console.error(`giving up after ${attempt} attempts: ${error.message}`);
      process.exit(1);
    }
    const delayMs = baseDelayMs * attempt;
    console.error(`attempt ${attempt} failed (${error.message}); retrying in ${delayMs / 1000}s`);
    await sleep(delayMs);
  }
}
