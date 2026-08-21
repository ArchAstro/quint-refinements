// Quint-app → JSON artifact engine. Vocab and retrieve maps below are the
// first plugged-in app (Arch Gateway). A second Quint app should pass those
// as generateConformanceTraces options rather than forking this file.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const schemaVersion = 2;

// The generated artifact contains the readable, sorted 242-entry vocabulary.
// This separately reviewed digest prevents regeneration from silently blessing
// a misspelled state path, helper, name, or operator as a new dependency.
export const allowedRuntimeObservationDependencyDigest =
  "sha256:44eb554db5b790ed8b6bdb2494d9ec4f5a0ccca9be558e44d6b55e1e65493715";

export const allowedCapabilities = [
  "delivery.at_least_once",
  "ha.presence",
  "identity.enrollment",
  "identity.lifecycle",
  "lifecycle.failure",
  "liveness.assumptions",
  "model.structure",
  "platform.coordinator",
  "proof.safety",
  "resource.bounds",
  "routing.redundancy",
  "transport.basic",
];

export const allowedActions = [
  "advanceModel",
  "applyAckSendEffects",
  "advertisePresence",
  "ageConnections",
  "ageEnrollmentTokens",
  "ageIdentity",
  "agePresence",
  "applyDeliveredCancellation",
  "attemptCertificateConnection",
  "beginConnectionDrain",
  "beginReplicaDrain",
  "cancelAttempt",
  "cancelDelivery",
  "closeConnection",
  "closeDrainedConnection",
  "completeExecution",
  "connectorAcceptDelivery",
  "crashReplica",
  "createEnrollmentToken",
  "deliverDirectoryMessageAt",
  "deliverPlatformCancellationAt",
  "deliverPlatformInvocationAt",
  "deliverPlatformResultAt",
  "deliverPlatformUnavailableAt",
  "disconnectDeliveryConnection",
  "dropDirectoryMessageAt",
  "dropPlatformMessageAt",
  "emitConnectorResult",
  "enqueueDirectoryRefresh",
  "enqueueDirectoryRemoval",
  "enqueuePlatformCancellation",
  "enqueuePlatformInvocation",
  "enqueuePlatformResult",
  "enqueuePlatformUnavailable",
  "enqueueSelectedDelivery",
  "evictCompletedDedup",
  "expireAttempt",
  "finishReplicaDrain",
  "forceCloseExpiredDrain",
  "healConnectorGateway",
  "healGatewayDirectory",
  "healPlatformGateway",
  "heartbeatConnection",
  "ignoreStaleDeliveredCancellation",
  "installServiceCredential",
  "issueEnrollmentCertificate",
  "loseDelivery",
  "loseDeliveryAck",
  "loseEnrollmentResponse",
  "loseInvocationCoordinator",
  "losePendingResult",
  "observePresence",
  "openConnection",
  "openConnectionForRuntimeOwner",
  "partitionConnectorGateway",
  "partitionGatewayDirectory",
  "partitionPlatformGateway",
  "processDeliveryAck",
  "receiveConnectorResult",
  "receiveHello",
  "receiveLateConnectorResult",
  "recoverEnrollmentCertificate",
  "rejectUnboundConnectorResult",
  "refreshPresence",
  "rejectDuplicateDelivery",
  "rejectRevokedRenewal",
  "removePresence",
  "renewCertificate",
  "reportRoutedUnavailable",
  "reportUnavailable",
  "reserveEnrollmentToken",
  "restartReplica",
  "revokeServiceIdentity",
  "routeObservedAttempt",
  "selectConnection",
  "selectForAttempt",
  "selectForRoutedAttempt",
  "stutterModel",
  "terminateRuntimeOwner",
  "submitInvocation",
  "timeoutConnection",
];

// This is the complete expression language accepted in action arguments and
// observations. Extending it requires an explicit review of the future Rust
// adapter rather than silently serializing arbitrary Quint AST nodes.
export const allowedExpressionOperators = [
  "InvocationFailed",
  "InvocationSucceeded",
  "Present",
  "Rec",
  "Set",
  "actionAll",
  "activePresenceFor",
  "attemptValue",
  "connectionIdAvailable",
  "connectionValue",
  "contains",
  "dedupEntry",
  "dedupKey",
  "dedupValue",
  "deliveryIdsForAttempt",
  "deliveryValue",
  "eligibleConnection",
  "eq",
  "exists",
  "field",
  "filter",
  "forall",
  "get",
  "hasEligibleConnectionOnReplica",
  "iadd",
  "igt",
  "ilte",
  "length",
  "matchVariant",
  "neq",
  "nextEligible",
  "nextEligibleAfter",
  "not",
  "observationValue",
  "poolConnectionCount",
  "presenceRevisionAvailable",
  "presenceValue",
  "replicaPoolKey",
  "resultFor",
  "size",
  "tokenValue",
];

export const allowedExpressionNames = [
  "Absent",
  "AgeExpired",
  "CertificateConnectionAccepted",
  "CertificateConnectionRejected",
  "CertificateExpired",
  "ConnectionClosed",
  "ConnectionEligible",
  "ConnectionTimedOut",
  "ServiceCertificateIssued",
  "ServiceEnrolled",
  "ServiceNotEnrolled",
  "ConnectorExecutionStarted",
  "ConnectorDeliveryAccepted",
  "DeliveryAckLost",
  "ConnectorResultRejected",
  "ServicePendingEnrollment",
  "ServiceRevoked",
  "DedupCompleted",
  "DedupInFlight",
  "DeliveryCancelled",
  "DeliveryCommitted",
  "DeliveryCommittedOutcome",
  "DeliveryLost",
  "DeliveryUnavailableOutcome",
  "DuplicateResultIgnored",
  "CsrDigestA",
  "CsrDigestB",
  "EnrollmentCertificateIssued",
  "EnrollmentConflictRejected",
  "EnrollmentExpiredRejected",
  "EnrollmentIdentityRejected",
  "EnrollmentRecovered",
  "EnrollmentReservationJoined",
  "EnrollmentResponseLost",
  "EnrollmentTokenReserved",
  "ExecutionCancelled",
  "ExecutionRunning",
  "FunctionRejected",
  "HelloAccepted",
  "HelloRejectedDuplicate",
  "HelloRejectedFunctions",
  "HelloRejectedIdentity",
  "IdempotencyConflict",
  "InvocationAccepted",
  "InvocationAmbiguous",
  "InvocationAmbiguousOutcome",
  "invocationCorrelationInv",
  "InvocationCancelled",
  "InvocationDelivering",
  "InvocationExpired",
  "InvocationRejected",
  "InvocationRejectedInvalid",
  "InvocationRouting",
  "InvocationSettled",
  "InvocationSettledOutcome",
  "LinkPartitioned",
  "LinkReachable",
  "PlatformMessageDropped",
  "PresenceActive",
  "PresenceCleanupSkipped",
  "PresenceExpired",
  "PresenceRemoved",
  "PresenceRouteUnavailable",
  "ReplicaDown",
  "ResultA",
  "StaleCancellationIgnored",
  "TokenAvailable",
  "TokenConsumed",
  "TokenExpired",
  "TokenReserved",
  "attemptA",
  "attemptB",
  "callerRetryAttempt",
  "certificateA1",
  "certificateA2",
  "certificateA3",
  "certificateB1",
  "certificateValues",
  "connectionA1",
  "connectionSpecificCleanupInv",
  "connectionAKey",
  "connectionBKey",
  "failureConnectionAKey",
  "failureConnectionBKey",
  "serviceEnrollmentA",
  "serviceEnrollmentAAlt",
  "serviceEnrollmentAReplacement",
  "serviceEnrollmentB",
  "controlDerivedCertificateBindingInv",
  "crossFunctionAttempt",
  "csrA",
  "csrAReplacement",
  "csrSubstitution",
  "dedupCompletedA",
  "dedupConflictA",
  "dedupInFlightA",
  "deliveryA1",
  "deliveryA2",
  "deliveryAttemptIds",
  "deliverySafetyInv",
  "eligibleSelectionInv",
  "equallyExpiringAttempt",
  "executionValues",
  "expiringAttempt",
  "failureSafetyInv",
  "gatewayA",
  "gatewayB",
  "helloA1",
  "helloA2",
  "helloA3",
  "helloB1",
  "identitySafetyInv",
  "initialTopology",
  "invalidFunctionAttempt",
  "maxCertificates",
  "maxClockSkew",
  "maxConnections",
  "maxServiceEnrollments",
  "maxDeliveryAttempts",
  "maxInvocationAttempts",
  "maxOrganizations",
  "maxPresenceRecords",
  "maxReplicas",
  "maxServiceSpecs",
  "maxTimestamp",
  "mismatchedHello",
  "overloadAttempt",
  "poolA",
  "poolAAlt",
  "poolB",
  "poolSafetyInv",
  "presenceA",
  "presenceCleanupInv",
  "presenceRecords",
  "presenceSafetyInv",
  "renewedCertificateA1",
  "routeObservationBindingInv",
  "safetyInv",
  "serviceA",
  "serviceAAlt",
  "serviceB",
  "state",
  "sameTenantAlternateServiceAttempt",
  "terminalCleanupInv",
  "tokenRecords",
  "tunnelAttemptA",
  "unknownFunctionHello",
  "wrongConnectionTunnelResult",
  "wrongServiceHelloA3",
];

const allowedActionSet = new Set(allowedActions);
const allowedCapabilitySet = new Set(allowedCapabilities);
const allowedExpressionOperatorSet = new Set(allowedExpressionOperators);
const allowedExpressionNameSet = new Set(allowedExpressionNames);
const modelOnlyAssertionNames = new Set([
  ...allowedExpressionNames.filter(name => name.endsWith("Inv")),
  "deliveryAttemptIds",
  "executionValues",
  "initialTopology",
  "maxCertificates",
  "maxClockSkew",
  "maxConnections",
  "maxServiceEnrollments",
  "maxDeliveryAttempts",
  "maxInvocationAttempts",
  "maxOrganizations",
  "maxPresenceRecords",
  "maxReplicas",
  "maxServiceSpecs",
  "maxTimestamp",
  "presenceRecords",
  "tokenRecords",
]);
const modelOnlyAssertionOperators = new Set([
  "connectionIdAvailable",
  "eligibleConnection",
  "hasEligibleConnectionOnReplica",
  "nextEligible",
  "nextEligibleAfter",
  "presenceRevisionAvailable",
]);

function fail(context, message) {
  throw new Error(`${context}: ${message}`);
}

export function parseConformanceCapabilities(doc, context = "declaration") {
  const directives = (doc ?? "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("@conformance"));
  if (directives.length !== 1) {
    fail(context, `expected exactly one @conformance directive, found ${directives.length}`);
  }
  const match = directives[0].match(
    /^@conformance requires = \[([a-z0-9._]+(?:, [a-z0-9._]+)*)\]$/,
  );
  if (!match) {
    fail(context, "malformed @conformance directive");
  }
  const capabilities = match[1].split(", ");
  if (new Set(capabilities).size !== capabilities.length) {
    fail(context, "duplicate capability in @conformance directive");
  }
  for (const capability of capabilities) {
    if (!allowedCapabilitySet.has(capability)) {
      fail(context, `unknown conformance capability ${capability}`);
    }
  }
  return capabilities.sort();
}

export function encodeExpression(node, context = "expression", boundNames = new Set()) {
  return encodeExpressionNode(node, context, boundNames, true);
}

/// Guard conjuncts use the full Quint expression AST. Observe chapters keep
/// the closed adapter vocabulary.
export function encodeGuardExpression(node, context = "expression", boundNames = new Set()) {
  return encodeExpressionNode(node, context, boundNames, false);
}

function encodeExpressionNode(node, context, boundNames, closedVocab) {
  if (!node || typeof node !== "object") {
    fail(context, "expected a Quint AST node");
  }

  if (["bool", "int", "str"].includes(node.kind)) {
    return { kind: node.kind, value: node.value };
  }
  if (node.kind === "name") {
    if (
      closedVocab &&
      !allowedExpressionNameSet.has(node.name) &&
      !boundNames.has(node.name)
    ) {
      fail(context, `unsupported expression name ${node.name}`);
    }
    return { kind: "name", value: node.name };
  }
  if (node.kind === "lambda") {
    const parameters = node.params.map(parameter => parameter.name);
    const nestedBoundNames = new Set([...boundNames, ...parameters]);
    return {
      kind: "lambda",
      parameters,
      body: encodeExpressionNode(node.expr, `${context}.body`, nestedBoundNames, closedVocab),
    };
  }
  if (node.kind === "let") {
    const name = node.opdef?.name;
    const nestedBoundNames = new Set(boundNames);
    if (name) {
      nestedBoundNames.add(name);
    }
    return {
      kind: "let",
      name,
      value: encodeExpressionNode(
        node.opdef.expr,
        `${context}.let.value`,
        boundNames,
        closedVocab,
      ),
      body: encodeExpressionNode(node.expr, `${context}.let.body`, nestedBoundNames, closedVocab),
    };
  }
  if (node.kind === "app") {
    if (closedVocab && !allowedExpressionOperatorSet.has(node.opcode)) {
      fail(context, `unsupported expression operator ${node.opcode}`);
    }
    return {
      kind: "call",
      operator: node.opcode,
      arguments: (node.args ?? []).map((argument, index) =>
        encodeExpressionNode(
          argument,
          `${context}.${node.opcode}[${index}]`,
          boundNames,
          closedVocab,
        )
      ),
    };
  }

  fail(context, `unsupported expression kind ${node.kind}`);
}

function expressionIsModelOnly(node) {
  if (node.kind === "name") {
    return modelOnlyAssertionNames.has(node.name);
  }
  if (node.kind === "app") {
    return modelOnlyAssertionOperators.has(node.opcode) ||
      node.args.some(expressionIsModelOnly);
  }
  if (node.kind === "lambda") {
    return expressionIsModelOnly(node.expr);
  }
  return false;
}

function collectExpressionNames(node, names) {
  if (node.kind === "name") {
    names.add(node.name);
  } else if (node.kind === "app") {
    node.args.forEach(argument => collectExpressionNames(argument, names));
  } else if (node.kind === "lambda") {
    collectExpressionNames(node.expr, names);
    node.params.forEach(parameter => names.delete(parameter.name));
  } else if (node.kind === "let") {
    collectExpressionNames(node.opdef?.expr, names);
    collectExpressionNames(node.expr, names);
    if (node.opdef?.name) {
      names.delete(node.opdef.name);
    }
  }
}

function flattenThen(node) {
  if (node.kind === "app" && node.opcode === "then") {
    return [...flattenThen(node.args[0]), node.args[1]];
  }
  return [node];
}

function isStateSelfAssignment(node) {
  return node.kind === "app" &&
    node.opcode === "assign" &&
    node.args.length === 2 &&
    node.args[0].kind === "name" &&
    node.args[0].name === "state" &&
    node.args[1].kind === "name" &&
    node.args[1].name === "state";
}

function encodeObservation(node, context) {
  const assertions = [];
  let stateAssignmentCount = 0;

  for (const member of node.args) {
    if (member.kind === "app" && member.opcode === "assert" && member.args.length === 1) {
      const scope = expressionIsModelOnly(member.args[0]) ? "model" : "runtime";
      const expression = encodeExpression(
        member.args[0],
        `${context}.assert[${assertions.length}]`,
      );
      assertions.push({
        scope,
        expression,
        ...(scope === "runtime"
          ? { dependencies: observationDependencies(expression) }
          : {}),
      });
    } else if (isStateSelfAssignment(member)) {
      stateAssignmentCount += 1;
    } else {
      fail(context, "observation blocks may contain only assertions and state' = state");
    }
  }

  if (assertions.length === 0 || stateAssignmentCount !== 1) {
    fail(context, "observation blocks require assertions and exactly one state' = state");
  }
  return { kind: "observe", assertions };
}

function expressionPath(expression) {
  if (expression.kind === "name") {
    return expression.value;
  }
  if (
    expression.kind === "call" &&
    expression.operator === "field" &&
    expression.arguments.length === 2 &&
    expression.arguments[1].kind === "str"
  ) {
    const base = expressionPath(expression.arguments[0]);
    return base ? `${base}.${expression.arguments[1].value}` : undefined;
  }
  if (expression.kind === "call") {
    return expression.operator;
  }
  return undefined;
}

export function observationDependencies(expression, boundNames = new Set()) {
  const dependencies = new Set();

  function visit(node, bindings) {
    if (node.kind === "name") {
      if (!bindings.has(node.value)) {
        dependencies.add(`name:${node.value}`);
      }
      return;
    }
    if (node.kind === "lambda") {
      visit(node.body, new Set([...bindings, ...node.parameters]));
      return;
    }
    if (node.kind === "let") {
      visit(node.value, bindings);
      const nested = new Set(bindings);
      if (typeof node.name === "string") {
        nested.add(node.name);
      }
      visit(node.body, nested);
      return;
    }
    if (node.kind === "call") {
      dependencies.add(`operator:${node.operator}`);
      const path = expressionPath(node);
      if (node.operator === "field" && path) {
        dependencies.add(`path:${path}`);
      }
      node.arguments.forEach(argument => visit(argument, bindings));
    }
  }

  visit(expression, boundNames);
  return [...dependencies].sort();
}

export function validateRuntimeObservationDependencies(
  dependencies,
  context = "runtime observation dependency vocabulary",
) {
  const sorted = [...dependencies].sort();
  if (new Set(sorted).size !== sorted.length) {
    fail(context, "contains duplicate dependencies");
  }
  const digest = `sha256:${crypto.createHash("sha256").update(sorted.join("\0")).digest("hex")}`;
  if (digest !== allowedRuntimeObservationDependencyDigest) {
    fail(
      context,
      `changed from reviewed digest ${allowedRuntimeObservationDependencyDigest} to ${digest}`,
    );
  }
  return digest;
}

function substituteNames(node, mapping) {
  if (!node || typeof node !== "object") {
    return node;
  }
  if (node.kind === "name" && mapping.has(node.name)) {
    return mapping.get(node.name);
  }
  if (node.kind === "app") {
    return {
      ...node,
      args: (node.args ?? []).map(argument => substituteNames(argument, mapping)),
    };
  }
  if (node.kind === "lambda") {
    const nested = new Map(mapping);
    for (const parameter of node.params ?? []) {
      nested.delete(parameter.name);
    }
    return { ...node, expr: substituteNames(node.expr, nested) };
  }
  if (node.kind === "let") {
    return {
      ...node,
      opdef: node.opdef
        ? { ...node.opdef, expr: substituteNames(node.opdef.expr, mapping) }
        : node.opdef,
      expr: substituteNames(node.expr, mapping),
    };
  }
  return node;
}

function flattenActionAll(node) {
  if (node?.kind === "app" && node.opcode === "actionAll") {
    return (node.args ?? []).flatMap(flattenActionAll);
  }
  if (node?.kind === "let") {
    return flattenActionAll(node.expr);
  }
  return node ? [node] : [];
}

function isAssignment(node) {
  return node?.kind === "app" && node.opcode === "assign";
}

const alwaysRetrieveable = new Set([
  "operator:eq",
  "operator:neq",
  "operator:not",
  "operator:actionAll",
]);

// Keep in sync with IDENTITY_OBSERVATIONS / TRANSPORT_OBSERVATIONS /
// PLATFORM_COORDINATOR_OBSERVATIONS in services/rust/arch-gateway/src/lib.rs.
const identityRetrieve = [
  "name:AgeExpired",
  "name:ConnectionClosed",
  "name:CsrDigestA",
  "name:EnrollmentConflictRejected",
  "name:EnrollmentExpiredRejected",
  "name:EnrollmentIdentityRejected",
  "name:EnrollmentRecovered",
  "name:EnrollmentReservationJoined",
  "name:HelloRejectedIdentity",
  "name:ServiceCertificateIssued",
  "name:ServiceEnrolled",
  "name:ServiceNotEnrolled",
  "name:ServicePendingEnrollment",
  "name:TokenConsumed",
  "name:TokenExpired",
  "name:TokenReserved",
  "name:certificateA1",
  "name:certificateValues",
  "name:csrSubstitution",
  "name:poolB",
  "name:serviceEnrollmentA",
  "name:serviceEnrollmentAAlt",
  "name:serviceEnrollmentAReplacement",
  "name:serviceEnrollmentB",
  "operator:actionAll",
  "operator:filter",
  "operator:tokenValue",
  "path:certificate.service_id",
  "path:certificateA1.id",
  "path:connection.lifecycle",
  "path:connectionValue.pool_key",
  "path:connectionValue.service_id",
  "path:csrSubstitution.requested_binding",
  "path:csrSubstitution.requests_extra_san",
  "path:get.binding",
  "path:get.lifecycle",
  "path:serviceEnrollmentA.binding",
  "path:serviceEnrollmentA.binding.service_id",
  "path:serviceEnrollmentAAlt.binding",
  "path:serviceEnrollmentAAlt.binding.service_id",
  "path:serviceEnrollmentAReplacement.binding",
  "path:serviceEnrollmentAReplacement.binding.service_id",
  "path:serviceEnrollmentB.binding",
  "path:serviceEnrollmentB.binding.service_id",
  "path:state.certificates",
  "path:state.enrollment_tokens",
  "path:state.last_identity_outcome",
  "path:state.last_pool_outcome",
  "path:state.pending_enrollment_responses",
  "path:state.service_enrollments",
  "path:tokenValue.age",
  "path:tokenValue.csr_digest",
  "path:tokenValue.issued_certificate_id",
  "path:tokenValue.lifecycle",
];

const transportRetrieve = [
  "name:Absent",
  "name:CertificateConnectionAccepted",
  "name:CertificateConnectionRejected",
  "name:ConnectorExecutionStarted",
  "name:ConnectorResultRejected",
  "name:DedupCompleted",
  "name:DeliveryCommitted",
  "name:DeliveryLost",
  "name:FunctionRejected",
  "name:IdempotencyConflict",
  "name:InvocationSettled",
  "name:InvocationSettledOutcome",
  "name:ResultA",
  "name:attemptA",
  "name:connectionAKey",
  "name:connectionBKey",
  "name:failureConnectionAKey",
  "name:failureConnectionBKey",
  "name:crossFunctionAttempt",
  "name:gatewayA",
  "name:poolA",
  "name:poolAAlt",
  "name:state",
  "operator:InvocationFailed",
  "operator:InvocationSucceeded",
  "operator:Present",
  "operator:Rec",
  "operator:Set",
  "operator:attemptValue",
  "operator:contains",
  "operator:connectionValue",
  "operator:deliveryValue",
  "operator:dedupEntry",
  "operator:dedupValue",
  "operator:eq",
  "operator:field",
  "operator:get",
  "operator:length",
  "operator:matchVariant",
  "operator:neq",
  "operator:not",
  "operator:poolConnectionCount",
  "operator:replicaPoolKey",
  "operator:resultFor",
  "operator:size",
  "path:attemptA.id",
  "path:crossFunctionAttempt.id",
  "path:dedupValue.lifecycle",
  "path:attemptValue.lifecycle",
  "path:connection.service_id",
  "path:connectionValue.queue_depth",
  "path:deliveryValue.attempt_id",
  "path:deliveryValue.connection_id",
  "path:deliveryValue.lifecycle",
  "path:gatewayA.id",
  "path:state.acknowledged_delivery_ids",
  "path:state.applied_delivery_ack_ids",
  "path:state.allocated_delivery_ids",
  "path:state.connections",
  "path:state.last_delivery_outcome",
  "path:state.private_side_effects",
  "path:state.pending_connector_results",
  "path:state.provisional_selection",
  "path:state.results",
  "path:state.round_robin_cursors",
  "path:state.service_credentials",
  "path:state.settlement_counts",
  "path:state.tunnel_frames",
];

const platformRetrieve = [
  "name:DuplicateResultIgnored",
  "name:callerRetryAttempt",
  "path:attemptA.idempotency_key",
  "path:attemptA.logical_call_id",
  "path:callerRetryAttempt.id",
  "path:callerRetryAttempt.idempotency_key",
  "path:callerRetryAttempt.logical_call_id",
];

export function retrieveForCapabilities(capabilities) {
  const retrieve = new Set(alwaysRetrieveable);
  const has = name => capabilities.includes(name);
  if (has("identity.enrollment") || has("identity.lifecycle")) {
    identityRetrieve.forEach(dependency => retrieve.add(dependency));
    // Identity runners pass IDENTITY ∪ TRANSPORT.
    transportRetrieve.forEach(dependency => retrieve.add(dependency));
  }
  if (
    has("transport.basic") ||
    has("routing.redundancy") ||
    has("delivery.at_least_once")
  ) {
    transportRetrieve.forEach(dependency => retrieve.add(dependency));
    retrieve.add("path:state.last_identity_outcome");
    retrieve.add("path:state.last_pool_outcome");
  }
  if (has("platform.coordinator")) {
    platformRetrieve.forEach(dependency => retrieve.add(dependency));
  }
  return retrieve;
}

const lastOutcomeRetrieve = [
  "name:Absent",
  "name:attemptA",
  "name:attemptB",
  "name:state",
  "operator:eq",
  "operator:field",
  "operator:get",
  "operator:neq",
  "operator:not",
  "path:attemptA.id",
  "path:attemptB.id",
  "path:state.last_delivery_outcome",
  "path:state.last_failure_outcome",
  "path:state.last_identity_outcome",
  "path:state.last_pool_outcome",
  "path:state.last_presence_outcome",
  "path:state.private_side_effects",
];

const snapshotRetrieve = [
  ...lastOutcomeRetrieve,
  "name:gatewayA",
  "name:poolA",
  "name:poolAAlt",
  "operator:connectionValue",
  "operator:contains",
  "operator:deliveryValue",
  "operator:poolConnectionCount",
  "operator:replicaPoolKey",
  "path:connection.service_id",
  "path:connectionValue.queue_depth",
  "path:state.allocated_delivery_ids",
  "path:state.connections",
  "path:state.provisional_selection",
  "path:state.round_robin_cursors",
  "path:state.tunnel_frames",
];

// Action-granularity retrieve: identity snapshots project enrollment maps;
// Task 3 snapshots project connections, cursors, and last_* tags.
export function actionGuardRetrieve(capabilities) {
  const has = name => capabilities.includes(name);
  if (has("identity.enrollment") || has("identity.lifecycle")) {
    return retrieveForCapabilities(capabilities);
  }
  if (has("delivery.at_least_once")) {
    return new Set([...alwaysRetrieveable, ...lastOutcomeRetrieve]);
  }
  if (has("routing.redundancy") || has("transport.basic")) {
    return new Set([...alwaysRetrieveable, ...snapshotRetrieve]);
  }
  return new Set(alwaysRetrieveable);
}

function encodedIsModelOnly(expression) {
  if (expression?.kind === "name") {
    return modelOnlyAssertionNames.has(expression.value);
  }
  if (expression?.kind === "call") {
    return modelOnlyAssertionOperators.has(expression.operator) ||
      (expression.arguments ?? []).some(encodedIsModelOnly);
  }
  if (expression?.kind === "lambda") {
    return encodedIsModelOnly(expression.body);
  }
  if (expression?.kind === "let") {
    return encodedIsModelOnly(expression.value) || encodedIsModelOnly(expression.body);
  }
  return false;
}

export function classifyGuardAssertion(expression, retrieve) {
  const dependencies = observationDependencies(expression);
  const runtime = !encodedIsModelOnly(expression) &&
    dependencies.every(dependency => retrieve.has(dependency));
  if (runtime) {
    return { scope: "runtime", expression, dependencies };
  }
  return { scope: "model", expression };
}

export function extractGuardAssertions(definition, argumentNodes, context, retrieve) {
  return extractActionObligations(definition, argumentNodes, context, retrieve).guards;
}

/// Split a Quint `all { }` action into unprimed conjuncts (before) and
/// `x' = e` assignments (after). `val`/`let` unwraps to its body; it is not
/// itself a conjunct.
export function extractActionObligations(definition, argumentNodes, context, retrieve) {
  if (!definition) {
    return { guards: [], next: [] };
  }
  if (!definition.expr) {
    fail(context, "action definition has no body to encode as conjuncts");
  }
  let body = definition.expr;
  const mapping = new Map();
  if (body.kind === "lambda") {
    (body.params ?? []).forEach((parameter, index) => {
      if (argumentNodes[index]) {
        mapping.set(parameter.name, argumentNodes[index]);
      }
    });
    body = body.expr;
  }
  const guards = [];
  const next = [];
  for (const [index, conjunct] of flattenActionAll(body).entries()) {
    if (!conjunct) {
      continue;
    }
    const substituted = substituteNames(conjunct, mapping);
    const kind = isAssignment(conjunct) ? "next" : "guard";
    const encoded = encodeGuardExpression(substituted, `${context}.${kind}[${index}]`);
    const classified = classifyGuardAssertion(encoded, retrieve);
    if (kind === "next") {
      next.push(classified);
    } else {
      guards.push(classified);
    }
  }
  return { guards, next };
}

function encodeItfValue(value) {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return { kind: "str", value };
  }
  if (typeof value === "boolean") {
    return { kind: "bool", value };
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return { kind: "int", value };
  }
  if (typeof value === "object") {
    if (value["#bigint"] !== undefined) {
      const parsed = Number(value["#bigint"]);
      if (Number.isInteger(parsed)) {
        return { kind: "int", value: parsed };
      }
    }
    // Unit variants become string tags so next does not depend on the
    // closed observation name vocabulary (EnrollmentTokenCreated and
    // ConnectionOpened are model outcomes, not Observe names).
    if (
      typeof value.tag === "string" &&
      value.value?.["#tup"] &&
      value.value["#tup"].length === 0
    ) {
      return { kind: "str", value: value.tag };
    }
  }
  return undefined;
}

function itfInt(value) {
  if (value == null) {
    return 0;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "object" && value["#bigint"] !== undefined) {
    const parsed = Number(value["#bigint"]);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function encodedEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stateFieldEq(field, encoded) {
  const expression = {
    kind: "call",
    operator: "eq",
    arguments: [
      {
        kind: "call",
        operator: "field",
        arguments: [
          { kind: "name", value: "state" },
          { kind: "str", value: field },
        ],
      },
      encoded,
    ],
  };
  return {
    scope: "runtime",
    expression,
    dependencies: observationDependencies(expression),
  };
}

const ITF_NEXT_FIELDS = [
  "last_identity_outcome",
  "last_pool_outcome",
  "last_delivery_outcome",
  "last_failure_outcome",
  "last_presence_outcome",
];

function attemptIdExpr(attemptId) {
  if (attemptId === "attempt-1") {
    return {
      kind: "call",
      operator: "field",
      arguments: [
        { kind: "name", value: "attemptA" },
        { kind: "str", value: "id" },
      ],
    };
  }
  if (attemptId === "attempt-2") {
    return {
      kind: "call",
      operator: "field",
      arguments: [
        { kind: "name", value: "attemptB" },
        { kind: "str", value: "id" },
      ],
    };
  }
  return undefined;
}

function attachItfActionNext(steps, itf, context) {
  const states = itf?.states;
  if (!Array.isArray(states) || states.length !== steps.length) {
    fail(
      context,
      `ITF state count ${states?.length ?? 0} does not match step count ${steps.length}`,
    );
  }
  for (const step of steps) {
    if (step.kind !== "action") {
      continue;
    }
    const after = states[step.index]?.state;
    const before = states[step.index - 1]?.state;
    if (!after) {
      fail(context, `missing ITF state for action ${step.action} at index ${step.index}`);
    }
    const next = [];
    for (const field of ITF_NEXT_FIELDS) {
      const encoded = encodeItfValue(after[field]);
      if (!encoded) {
        continue;
      }
      const previous = encodeItfValue(before?.[field]);
      if (encodedEqual(encoded, previous)) {
        continue;
      }
      next.push(stateFieldEq(field, encoded));
    }
    const sideEffects = after.private_side_effects?.["#map"];
    const previousSideEffects = before?.private_side_effects?.["#map"];
    if (Array.isArray(sideEffects)) {
      for (const [attemptId, count] of sideEffects) {
        const previous = Array.isArray(previousSideEffects)
          ? previousSideEffects.find(entry => entry[0] === attemptId)?.[1]
          : undefined;
        const afterCount = itfInt(count);
        const beforeCount = itfInt(previous);
        if (afterCount === beforeCount || afterCount === undefined) {
          continue;
        }
        const attempt = attemptIdExpr(attemptId);
        const encoded = encodeItfValue(count);
        if (!attempt || !encoded) {
          continue;
        }
        const expression = {
          kind: "call",
          operator: "eq",
          arguments: [
            {
              kind: "call",
              operator: "get",
              arguments: [
                {
                  kind: "call",
                  operator: "field",
                  arguments: [
                    { kind: "name", value: "state" },
                    { kind: "str", value: "private_side_effects" },
                  ],
                },
                attempt,
              ],
            },
            encoded,
          ],
        };
        next.push({
          scope: "runtime",
          expression,
          dependencies: observationDependencies(expression),
        });
      }
    }
    if (next.length === 0) {
      for (const field of ITF_NEXT_FIELDS) {
        const encoded = encodeItfValue(after[field]);
        if (encoded) {
          next.push(stateFieldEq(field, encoded));
          break;
        }
      }
    }
    if (next.length === 0 && !(step.next ?? []).length) {
      fail(context, `action ${step.action} produced no next from Quint assign or ITF`);
    }
    step.next = [...(step.next ?? []), ...next];
  }
}

function indexActionDefinitions(modules) {
  const actions = new Map();
  for (const module of modules ?? []) {
    for (const declaration of module.declarations ?? []) {
      if (declaration.kind === "def" && declaration.qualifier === "action") {
        actions.set(declaration.name, declaration);
      }
    }
  }
  return actions;
}

function encodeAction(node, context, fixtureNames, actionDefs, retrieve) {
  let action;
  let args;
  if (node.kind === "name") {
    action = node.name;
    args = [];
  } else if (node.kind === "app") {
    action = node.opcode;
    args = node.args;
  } else {
    fail(context, `unsupported action expression kind ${node.kind}`);
  }

  if (!allowedActionSet.has(action)) {
    fail(context, `unsupported action ${action}`);
  }
  args.forEach(argument => collectExpressionNames(argument, fixtureNames));
  const encoded = {
    kind: "action",
    action,
    arguments: args.map((argument, index) =>
      encodeExpression(argument, `${context}.${action}[${index}]`)
    ),
  };
  const { guards, next } = extractActionObligations(
    actionDefs?.get(action),
    args,
    `${context}.${action}`,
    retrieve,
  );
  if (guards.length > 0) {
    encoded.guards = guards;
  }
  if (next.length > 0) {
    encoded.next = next;
  }
  return encoded;
}

export function extractRun(
  declaration,
  source,
  moduleName,
  fixtureNames = new Set(),
  actionDefs = new Map(),
) {
  const context = `${source}:${declaration.name}`;
  const requiredCapabilities = parseConformanceCapabilities(declaration.doc, context);
  const retrieve = actionGuardRetrieve(requiredCapabilities);
  const nodes = flattenThen(declaration.expr);
  const initial = nodes.shift();
  if (
    initial?.kind !== "name" ||
    !["initModel", "initIdentityModel"].includes(initial.name)
  ) {
    fail(context, "run must begin with a supported initializer");
  }

  const steps = [{ kind: "init", action: initial.name, arguments: [] }];
  for (const [index, node] of nodes.entries()) {
    const context = `${source}:${declaration.name}:step ${index + 1}`;
    steps.push(
      node.kind === "app" && node.opcode === "actionAll"
        ? encodeObservation(node, context)
        : encodeAction(node, context, fixtureNames, actionDefs, retrieve),
    );
  }

  if (!steps.some(step => step.kind === "observe")) {
    fail(context, "run has no asserted observation");
  }

  return {
    source,
    module: moduleName,
    fixtureNamespace: moduleName,
    name: declaration.name,
    requiredCapabilities,
    steps: steps.map((step, index) => ({ index, ...step })),
  };
}

function compileScenario(quint, specDir, source, outputPath) {
  const moduleName = path.basename(source, ".qnt");
  const init = moduleName.includes("identity") || moduleName.includes("safety")
    ? "initIdentityModel"
    : "initModel";
  const result = spawnSync(
    quint,
    [
      "compile",
      source,
      `--main=${moduleName}`,
      `--init=${init}`,
      "--step=stutterModel",
      "--target=json",
      "--flatten=false",
      `--out=${outputPath}`,
      "--verbosity=0",
    ],
    {
      cwd: specDir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(`Quint compile failed for ${source}:\n${result.stderr ?? ""}`);
  }
  const compiled = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  const module = compiled.modules.find(candidate => candidate.name === moduleName);
  if (!module) {
    throw new Error(`Quint compile did not return module ${moduleName}`);
  }
  return { module, modules: compiled.modules ?? [] };
}

function writeFixtureWorkspace(specDir, temporaryDir) {
  for (const source of fs.readdirSync(specDir).filter(file => file.endsWith(".qnt"))) {
    const sourceText = fs.readFileSync(path.join(specDir, source), "utf8");
    const moduleStarts = [...sourceText.matchAll(/^module /gm)].map(match => match.index);
    const secondModule = moduleStarts[1] ?? -1;
    const copied = source.endsWith("_scenarios.qnt") && secondModule !== -1
      ? sourceText.slice(0, secondModule)
      : sourceText;
    fs.writeFileSync(path.join(temporaryDir, source), copied);
  }
}

function concreteValue(node, context) {
  if (["bool", "int", "str"].includes(node.kind)) {
    return node.value;
  }
  if (node.kind === "name") {
    return { tag: node.name, value: { "#tup": [] } };
  }
  if (node.kind !== "app") {
    fail(context, `fixture evaluation produced unsupported kind ${node.kind}`);
  }

  const values = node.args.map((argument, index) =>
    concreteValue(argument, `${context}.${node.opcode}[${index}]`)
  );
  if (node.opcode === "Rec") {
    if (values.length % 2 !== 0) {
      fail(context, "record fixture has an odd number of entries");
    }
    return Object.fromEntries(
      Array.from({ length: values.length / 2 }, (_, index) => [
        values[index * 2],
        values[index * 2 + 1],
      ]),
    );
  }
  if (node.opcode === "Set") {
    return { "#set": values };
  }
  if (node.opcode === "List") {
    return values;
  }
  if (node.opcode === "Tup") {
    return { "#tup": values };
  }
  if (node.opcode === "Map") {
    return { "#map": values };
  }
  return {
    tag: node.opcode,
    value: values.length === 0
      ? { "#tup": [] }
      : values.length === 1
        ? values[0]
        : { "#tup": values },
  };
}

function resolveFixtures(quint, temporaryDir, source, moduleName, fixtureNames) {
  if (fixtureNames.size === 0) {
    return {};
  }
  const sortedNames = [...fixtureNames].sort();
  const recordExpression = `{ ${sortedNames.map((name, index) => `fixture_${index}: ${name}`).join(", ")} }`;
  // Fixture values are pure Quint expressions. Keep evaluation in-process so
  // first-use Rust backend download progress cannot contaminate captured stdout.
  const evaluation = spawnSync(
    quint,
    [
      "-q",
      "--backend=typescript",
      "-r",
      `${source}::${moduleName}`,
      recordExpression,
    ],
    {
      cwd: temporaryDir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (
    evaluation.status !== 0 ||
    /(^|\n)(syntax |static analysis |runtime )?error:/im.test(evaluation.stdout)
  ) {
    throw new Error(
      `Quint fixture evaluation failed for ${moduleName}:\n${evaluation.stdout ?? ""}${evaluation.stderr ?? ""}`,
    );
  }

  const captureSource = [
    "module conformance_fixture_capture {",
    "  import connector_types.* from \"./connector_types\"",
    "  import connector_invocation_types.* from \"./connector_invocation_types\"",
    `  import ${moduleName}.* from "./${path.basename(source, ".qnt")}"`,
    `  pure val exportedFixtures = ${evaluation.stdout.trim()}`,
    "  var dummy: bool",
    "  action init = dummy' = false",
    "  action step = dummy' = dummy",
    "}",
    "",
  ].join("\n");
  const captureSourcePath = path.join(temporaryDir, "conformance_fixture_capture.qnt");
  const captureOutputPath = path.join(temporaryDir, "conformance_fixture_capture.json");
  fs.writeFileSync(captureSourcePath, captureSource);
  const capture = spawnSync(
    quint,
    [
      "compile",
      path.basename(captureSourcePath),
      "--main=conformance_fixture_capture",
      "--target=json",
      "--flatten=false",
      `--out=${captureOutputPath}`,
      "--verbosity=0",
    ],
    {
      cwd: temporaryDir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  if (capture.status !== 0) {
    const compilerOutput = fs.existsSync(captureOutputPath)
      ? fs.readFileSync(captureOutputPath, "utf8")
      : "no compiler output file";
    let compilerErrors = compilerOutput;
    try {
      const parsed = JSON.parse(compilerOutput);
      compilerErrors = (parsed.errors ?? []).map(error => error.explanation).join("\n");
    } catch {
      // Preserve non-JSON compiler output verbatim.
    }
    throw new Error(
      `Quint fixture capture failed for ${moduleName} (status ${capture.status}, signal ${capture.signal}, error ${capture.error?.message ?? "none"}):\n${capture.stderr ?? ""}\n${compilerErrors}`,
    );
  }
  const compiled = JSON.parse(fs.readFileSync(captureOutputPath, "utf8"));
  const captureModule = compiled.modules.find(module => module.name === "conformance_fixture_capture");
  const declaration = captureModule?.declarations.find(
    candidate => candidate.name === "exportedFixtures",
  );
  if (!declaration) {
    throw new Error(`fixture capture did not return exportedFixtures for ${moduleName}`);
  }
  const indexedFixtures = concreteValue(declaration.expr, `${moduleName}.fixtures`);
  return Object.fromEntries(
    sortedNames.map((name, index) => [name, indexedFixtures[`fixture_${index}`]]),
  );
}

function digestModel(specDir) {
  const sources = fs.readdirSync(specDir)
    .filter(file => file.endsWith(".qnt"))
    .sort();
  const hash = crypto.createHash("sha256");
  for (const source of sources) {
    hash.update(source);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(specDir, source)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function generateConformanceTraces({ root, specDir }) {
  const quint = path.join(root, "node_modules/.bin/quint");
  const sources = fs.readdirSync(specDir)
    .filter(file => /^connector(?:_[a-z]+)*_scenarios\.qnt$/.test(file))
    .sort();
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "arch-gateway-conformance-"));

  try {
    writeFixtureWorkspace(specDir, temporaryDir);
    const scenarios = [];
    const fixtures = {};
    for (const source of sources) {
      const outputPath = path.join(temporaryDir, `${source}.json`);
      const { module, modules } = compileScenario(quint, specDir, source, outputPath);
      const actionDefs = indexActionDefinitions(modules);
      const fixtureNames = new Set();
      for (const declaration of module.declarations) {
        if (declaration.kind === "def" && declaration.qualifier === "run") {
          scenarios.push(
            extractRun(declaration, source, module.name, fixtureNames, actionDefs),
          );
        }
      }
      fixtures[module.name] = resolveFixtures(
        quint,
        temporaryDir,
        source,
        module.name,
        fixtureNames,
      );
      const itfDir = path.join(temporaryDir, `${module.name}-itf`);
      fs.mkdirSync(itfDir, { recursive: true });
      const test = spawnSync(
        quint,
        [
          "test",
          source,
          `--main=${module.name}`,
          "--match=Run$",
          "--seed=0xdeadc01b",
          "--max-samples=1",
          "--backend=typescript",
          `--out-itf=${path.join(itfDir, "out_{test}_{seq}.itf.json")}`,
          "--verbosity=0",
        ],
        {
          cwd: specDir,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      if (test.status !== 0) {
        throw new Error(
          `Quint test traces failed for ${source}:\n${test.stderr ?? ""}${test.stdout ?? ""}`,
        );
      }
      const traces = new Map(
        fs.readdirSync(itfDir)
          .filter(file => file.endsWith(".itf.json"))
          .map(file => {
            const match = file.match(/^out_(.+)_(\d+)\.itf.json$/);
            const parsed = JSON.parse(fs.readFileSync(path.join(itfDir, file), "utf8"));
            return [match?.[1] ?? file, parsed];
          }),
      );
      for (const scenario of scenarios.filter(candidate => candidate.module === module.name)) {
        const itf = traces.get(scenario.name);
        if (!itf) {
          throw new Error(`missing ITF trace for ${scenario.module}.${scenario.name}`);
        }
        attachItfActionNext(
          scenario.steps,
          itf,
          `${scenario.source}:${scenario.name}`,
        );
      }
    }
    if (scenarios.length === 0) {
      throw new Error("no asserted Quint runs were discovered");
    }
    const usedCapabilities = new Set(
      scenarios.flatMap(scenario => scenario.requiredCapabilities),
    );
    const unusedCapabilities = allowedCapabilities.filter(
      capability => !usedCapabilities.has(capability),
    );
    if (unusedCapabilities.length > 0) {
      throw new Error(`unused conformance capabilities: ${unusedCapabilities.join(", ")}`);
    }
    const runtimeObservationDependencies = [...new Set(
      scenarios.flatMap(scenario =>
        scenario.steps
          .filter(step => step.kind === "observe")
          .flatMap(step => step.assertions)
          .filter(assertion => assertion.scope === "runtime")
          .flatMap(assertion => assertion.dependencies)
      ),
    )].sort();
    const runtimeObservationDependencyDigest = validateRuntimeObservationDependencies(
      runtimeObservationDependencies,
    );
    return {
      schemaVersion,
      modelDigest: digestModel(specDir),
      vocabulary: {
        actions: allowedActions,
        capabilities: allowedCapabilities,
        expressionOperators: allowedExpressionOperators,
        expressionNames: allowedExpressionNames,
        runtimeObservationDependencies,
        runtimeObservationDependencyDigest,
      },
      fixtures,
      scenarios,
    };
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}
