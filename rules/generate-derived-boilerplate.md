---
name: Generate Derived Integration Boilerplate
description: Generate adapters and configuration from an authoritative parsed source instead of requiring users to duplicate derivable structure by hand.
date: 2026-08-26
---

# Generate Derived Integration Boilerplate

When a compiler, schema parser, or other authoritative source can expose the structure needed by an integration, the public workflow must derive configuration and adapter scaffolding from that parsed source. Users should provide domain decisions and implementation code, not repeat action names, fields, operators, or entry points that the tool can already discover.

A narrow exception is configuration that represents a real user choice and cannot be inferred. Keep that input declarative and minimal, and explain why it is required.

## Positive example

```console
npx tool new account-model
# Edit the authoritative model.
npx tool compile account-model.qnt
```

The compile command reuses the model parser, derives the action and state vocabulary, emits the generated artifact, and creates the typed adapter boundary. The user implements only the generated primitive hooks.

## Counterexample

```javascript
export const config = {
  actions: ["withdraw"],
  fields: ["balance"],
  operators: ["subtract", "greaterThanOrEqual"],
};
```

This repeats facts already present in the parsed model. It can drift independently, adds setup work, and makes users understand generator internals before they can connect an implementation.
