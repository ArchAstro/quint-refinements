import {
  asInt,
  asText,
  fieldOf,
  int,
  list,
  map,
  record,
  text,
  textSet,
  type Evidence,
  type RuntimeValue,
} from "quint-refinements/runtime";

import type { Implementation } from "./generated_refinement.ts";

/** A node's Raft role. Its name is what the model's `role` holds. */
export type Role = "Follower" | "Candidate" | "Leader";

/** One Raft node. */
export interface Node {
  term: number;
  role: Role;
  votedFor: string;
  votes: Set<string>;
  /** The term of each entry; the commands do not matter here. */
  log: number[];
  commit: number;
}

function cloneNode(node: Node): Node {
  return { ...node, votes: new Set(node.votes), log: [...node.log] };
}

/** How up to date a log is: last term first, then length. */
function logRank(node: Node): [lastTerm: number, length: number] {
  return [node.log[node.log.length - 1] ?? 0, node.log.length];
}

function rankLess([term1, length1]: [number, number], [term2, length2]: [number, number]): boolean {
  return term1 < term2 || (term1 === term2 && length1 < length2);
}

/**
 * The code under test: a Raft cluster whose nodes share one process. It is
 * also the evidence a snapshot reports, so it exposes the model's `state`.
 */
export class Cluster implements Evidence {
  readonly nodes = new Map<string, Node>();

  constructor(names: readonly string[]) {
    for (const name of names) {
      this.nodes.set(name, { term: 0, role: "Follower", votedFor: "", votes: new Set(), log: [], commit: 0 });
    }
  }

  clone(): Cluster {
    const copy = new Cluster([]);
    for (const [name, node] of this.nodes) {
      copy.nodes.set(name, cloneNode(node));
    }
    return copy;
  }

  private quorum(): number {
    return Math.floor(this.nodes.size / 2) + 1;
  }

  private node(name: string): Node {
    const node = this.nodes.get(name);
    if (node === undefined) {
      throw new Error(`no node ${name}`);
    }
    return node;
  }

  timeout(name: string): void {
    const node = this.node(name);
    if (node.role === "Leader") {
      throw new Error(`${name} leads; a leader does not time out`);
    }
    node.term += 1;
    node.role = "Candidate";
    node.votedFor = name;
    node.votes = new Set([name]);
  }

  requestVote(candidate: string, voter: string): void {
    const candidateNode = this.node(candidate);
    if (candidateNode.role !== "Candidate") {
      throw new Error(`${candidate} is not campaigning`);
    }
    const voterNode = this.node(voter);
    if (candidateNode.term <= voterNode.term || rankLess(logRank(candidateNode), logRank(voterNode))) {
      throw new Error(`${voter} refuses to vote for ${candidate}`);
    }
    voterNode.term = candidateNode.term;
    voterNode.role = "Follower";
    voterNode.votedFor = candidate;
    candidateNode.votes.add(voter);
  }

  becomeLeader(name: string): void {
    const node = this.node(name);
    if (node.role !== "Candidate" || node.votes.size < this.quorum()) {
      throw new Error(`${name} has no majority`);
    }
    node.role = "Leader";
  }

  clientRequest(leader: string): void {
    const node = this.node(leader);
    if (node.role !== "Leader") {
      throw new Error(`${leader} is not the leader`);
    }
    node.log.push(node.term);
  }

  appendEntries(leader: string, follower: string): void {
    const leaderNode = cloneNode(this.node(leader));
    const followerNode = this.node(follower);
    if (leader === follower || leaderNode.role !== "Leader" || leaderNode.term < followerNode.term) {
      throw new Error(`${follower} rejects stale leader ${leader}`);
    }
    followerNode.term = leaderNode.term;
    followerNode.role = "Follower";
    followerNode.log = leaderNode.log;
    followerNode.commit = Math.max(followerNode.commit, leaderNode.commit);
  }

  commitEntry(leader: string, index: number): void {
    // Raft commits by counting only entries from the leader's own term.
    // Only the leader writes those, so it holds every one it counts.
    const leaderNode = this.node(leader);
    let stored = 0;
    for (const node of this.nodes.values()) {
      if (index >= 1 && node.log[index - 1] === leaderNode.term) {
        stored += 1;
      }
    }
    if (leaderNode.role !== "Leader" || index <= leaderNode.commit || stored < this.quorum()) {
      throw new Error(`${leader} cannot commit entry ${index}`);
    }
    leaderNode.commit = index;
  }

  /** Exposes the model's `state`: `{ nodes: str -> Node }`. */
  resolveName(name: string): RuntimeValue | undefined {
    if (name !== "state") {
      return undefined;
    }
    return record({
      nodes: map(
        [...this.nodes].map(([nodeName, node]) => [
          text(nodeName),
          record({
            term: int(node.term),
            role: text(node.role),
            votedFor: text(node.votedFor),
            votes: textSet(node.votes),
            log: list(node.log.map(int)),
            commit: int(node.commit),
          }),
        ]),
      ),
    });
  }
}

function names(args: readonly RuntimeValue[], count: number): string[] {
  if (args.length !== count) {
    throw new Error(`expected ${count} arguments: ${args.length}`);
  }
  return args.map(asText);
}

/** Connects Cluster to the generated Implementation interface. */
export class RaftAdapter implements Implementation {
  readonly cluster: Cluster;

  constructor(cluster: Cluster) {
    this.cluster = cluster;
  }

  /** Builds a Cluster from the scenario's generated initial state. */
  static fromState(initial: RuntimeValue): RaftAdapter {
    const nodes = fieldOf(initial, "nodes");
    if (nodes.kind !== "map") {
      throw new Error(`expected a nodes map, got ${nodes.kind}`);
    }
    return new RaftAdapter(new Cluster(nodes.entries.map(([name]) => asText(name))));
  }

  /** The copy is unaffected by later actions. */
  snapshot(): Evidence {
    return this.cluster.clone();
  }

  timeout(args: readonly RuntimeValue[]): void {
    this.cluster.timeout(names(args, 1)[0]!);
  }

  /** The model passes (voter, candidate). */
  grantVote(args: readonly RuntimeValue[]): void {
    const [voter, candidate] = names(args, 2);
    this.cluster.requestVote(candidate!, voter!);
  }

  becomeLeader(args: readonly RuntimeValue[]): void {
    this.cluster.becomeLeader(names(args, 1)[0]!);
  }

  clientRequest(args: readonly RuntimeValue[]): void {
    this.cluster.clientRequest(names(args, 1)[0]!);
  }

  appendEntries(args: readonly RuntimeValue[]): void {
    const [leader, follower] = names(args, 2);
    this.cluster.appendEntries(leader!, follower!);
  }

  commit(args: readonly RuntimeValue[]): void {
    const [leader, index] = args;
    if (args.length !== 2) {
      throw new Error(`commit expects a node and an index: ${args.length} arguments`);
    }
    this.cluster.commitEntry(asText(leader), Number(asInt(index)));
  }
}
