import { asInt, int, record, stateEvidence, type Evidence, type RuntimeValue } from "quint-refinements/runtime";

import type { Implementation } from "./generated_refinement.ts";

/** The code under test: a one-account bank. */
export class Bank {
  balance: number;

  constructor(balance: number) {
    this.balance = balance;
  }

  withdraw(amount: number): void {
    if (amount <= 0) {
      throw new Error("withdrawal must be positive");
    }
    if (this.balance < amount) {
      throw new Error("insufficient funds");
    }
    this.balance -= amount;
  }
}

/**
 * Connects Bank to the generated Implementation interface. The generated
 * method takes Quint's arguments; the real one takes a number.
 */
export class BankAdapter implements Implementation {
  readonly bank: Bank;

  constructor(bank: Bank) {
    this.bank = bank;
  }

  /** Builds a Bank from the scenario's generated initial state. */
  static fromState(initial: RuntimeValue): BankAdapter {
    if (initial.kind !== "record") {
      throw new Error(`expected a bank record, got ${initial.kind}`);
    }
    return new BankAdapter(new Bank(Number(asInt(initial.fields.get("balance")))));
  }

  /** What the refinement checker may observe after each action. */
  snapshot(): Evidence {
    return stateEvidence(record({ balance: int(this.bank.balance) }));
  }

  withdraw(args: readonly RuntimeValue[]): void {
    const [amount] = args;
    this.bank.withdraw(Number(asInt(amount)));
  }
}
