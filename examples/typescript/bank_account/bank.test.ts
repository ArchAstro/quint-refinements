import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { RuntimeValue } from "quint-refinements/runtime";

import { Bank, BankAdapter } from "./bank.ts";
import { refineAll, refineAllSync } from "./generated_refinement.ts";

interface Expectation {
  scenario: string;
  evaluatedObligations: number;
  finalState: { balance: number };
}

const expected = JSON.parse(
  readFileSync(new URL("../../../conformance/cases/bank_withdraw/expected.json", import.meta.url), "utf8"),
) as Expectation;

test("generated Quint withdrawal drives the real bank and checks its snapshot", () => {
  // Setup: the compile step generated the scenario and the TypeScript adapter.
  // Boundary: generated ownership passes withdraw(4) to the real Bank.
  const results = refineAllSync(BankAdapter.fromState);

  // Outcome: all guards and the assignment match the shared binding corpus.
  assert.equal(results.length, 1, "only withdrawRun should be generated");
  const [result] = results;
  assert.equal(result?.scenario, expected.scenario);
  assert.equal(result?.evaluatedObligations, expected.evaluatedObligations);
  assert.equal(result?.implementation.bank.balance, expected.finalState.balance);
});

test("the async runner accepts the same synchronous bank", async () => {
  const results = await refineAll(BankAdapter.fromState);
  assert.deepEqual(
    results.map(({ scenario, evaluatedObligations }) => ({ scenario, evaluatedObligations })),
    [{ scenario: expected.scenario, evaluatedObligations: expected.evaluatedObligations }],
  );
});

/** Adds to the balance instead of taking from it. */
class DepositingBank extends BankAdapter {
  override withdraw(): void {
    this.bank.balance += 4;
  }
}

/** Forgets to take the money out. */
class ForgetfulBank extends BankAdapter {
  override withdraw(): void {}
}

test("a bank that deposits instead of withdrawing is reported as a divergence", () => {
  assert.throws(
    () => refineAllSync(initial => new DepositingBank(BankAdapter.fromState(initial).bank)),
    {
      message: "bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(14)",
    },
  );
});

test("a bank that ignores withdrawals is reported as a divergence", async () => {
  await assert.rejects(
    refineAll(initial => new ForgetfulBank(BankAdapter.fromState(initial).bank)),
    {
      message: "bank.withdrawRun:withdraw next: assign state diverged at state.balance expected Int(6), observed Int(10)",
    },
  );
});

test("a bank whose starting balance disagrees with the model is rejected before any action", () => {
  class BrokeBank extends BankAdapter {
    constructor() {
      super(new Bank(1));
    }
  }
  // The model starts with 10; the snapshot taken before the first action
  // already disagrees with it.
  assert.throws(() => refineAllSync(() => new BrokeBank()), /Rust fixture does not match Quint initial state: state\.balance expected Int\(10\), observed Int\(1\)/);
});

/** Talks to a remote ledger: every method returns a promise. */
class RemoteBank {
  readonly bank: Bank;

  constructor(bank: Bank) {
    this.bank = bank;
  }

  async snapshot() {
    await Promise.resolve();
    return new BankAdapter(this.bank).snapshot();
  }

  async withdraw(args: readonly RuntimeValue[]): Promise<void> {
    await Promise.resolve();
    new BankAdapter(this.bank).withdraw(args);
  }
}

test("an implementation with promise-returning methods runs under refineAll", async () => {
  const results = await refineAll(async initial => new RemoteBank(BankAdapter.fromState(initial).bank));
  assert.equal(results[0]?.evaluatedObligations, expected.evaluatedObligations);
  assert.equal(results[0]?.implementation.bank.balance, expected.finalState.balance);
});

test("the synchronous runner rejects a promise instead of checking a stale snapshot", () => {
  assert.throws(
    // The type system cannot tell a promise from void, so the runner checks at run time.
    () => refineAllSync(initial => new RemoteBank(BankAdapter.fromState(initial).bank) as unknown as BankAdapter),
    { message: /^snapshot returned a promise; use the asynchronous runner \(refineAll\)/ },
  );
});
