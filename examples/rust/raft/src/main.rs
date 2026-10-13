mod generated_refinement;

use std::collections::{BTreeMap, BTreeSet};

use generated_refinement::{Implementation, refine_all};
use quint_refinements::{NormalizedRuntimeEvidence, RuntimeValue};

#[derive(Clone, Copy, Debug, PartialEq)]
enum Role {
    Follower,
    Candidate,
    Leader,
}

#[derive(Clone)]
struct Node {
    term: i64,
    role: Role,
    voted_for: String,
    votes: BTreeSet<String>,
    /// The term of each entry; the commands themselves do not matter here.
    log: Vec<i64>,
    commit: i64,
}

/// The code under test: a Raft cluster whose nodes share one process.
#[derive(Clone)]
struct Cluster {
    nodes: BTreeMap<String, Node>,
}

impl Cluster {
    fn new(names: impl IntoIterator<Item = String>) -> Self {
        let node = Node {
            term: 0,
            role: Role::Follower,
            voted_for: String::new(),
            votes: BTreeSet::new(),
            log: Vec::new(),
            commit: 0,
        };
        Self {
            nodes: names.into_iter().map(|name| (name, node.clone())).collect(),
        }
    }

    fn quorum(&self) -> usize {
        self.nodes.len() / 2 + 1
    }

    fn node(&self, name: &str) -> Result<&Node, String> {
        self.nodes.get(name).ok_or(format!("no node {name}"))
    }

    fn node_mut(&mut self, name: &str) -> Result<&mut Node, String> {
        self.nodes.get_mut(name).ok_or(format!("no node {name}"))
    }

    fn timeout(&mut self, name: &str) -> Result<(), String> {
        let node = self.node_mut(name)?;
        if node.role == Role::Leader {
            return Err(format!("{name} leads; a leader does not time out"));
        }
        node.term += 1;
        node.role = Role::Candidate;
        node.voted_for = name.to_owned();
        node.votes = BTreeSet::from([name.to_owned()]);
        Ok(())
    }

    fn request_vote(&mut self, candidate: &str, voter: &str) -> Result<(), String> {
        let (term, log_len) = match self.node(candidate)? {
            c if c.role == Role::Candidate => (c.term, c.log.len()),
            _ => return Err(format!("{candidate} is not campaigning")),
        };
        let v = self.node_mut(voter)?;
        if term <= v.term || log_len < v.log.len() {
            return Err(format!("{voter} refuses to vote for {candidate}"));
        }
        v.term = term;
        v.role = Role::Follower;
        v.voted_for = candidate.to_owned();
        self.node_mut(candidate)?.votes.insert(voter.to_owned());
        Ok(())
    }

    fn become_leader(&mut self, name: &str) -> Result<(), String> {
        let quorum = self.quorum();
        let node = self.node_mut(name)?;
        if node.role != Role::Candidate || node.votes.len() < quorum {
            return Err(format!("{name} has no majority"));
        }
        node.role = Role::Leader;
        Ok(())
    }

    fn client_request(&mut self, leader: &str) -> Result<(), String> {
        let node = self.node_mut(leader)?;
        if node.role != Role::Leader {
            return Err(format!("{leader} is not the leader"));
        }
        node.log.push(node.term);
        Ok(())
    }

    fn append_entries(&mut self, leader: &str, follower: &str) -> Result<(), String> {
        let l = self.node(leader)?.clone();
        let f = self.node_mut(follower)?;
        if l.role != Role::Leader || l.term < f.term {
            return Err(format!("{follower} rejects stale leader {leader}"));
        }
        f.term = l.term;
        f.role = Role::Follower;
        f.log = l.log;
        f.commit = l.commit;
        Ok(())
    }

    fn commit(&mut self, leader: &str, index: i64) -> Result<(), String> {
        let stored = self
            .nodes
            .values()
            .filter(|node| node.log.len() as i64 >= index)
            .count();
        let quorum = self.quorum();
        let l = self.node_mut(leader)?;
        let own_term = index >= 1 && l.log.get(index as usize - 1) == Some(&l.term);
        if l.role != Role::Leader || index <= l.commit || !own_term || stored < quorum {
            return Err(format!("{leader} cannot commit entry {index}"));
        }
        l.commit = index;
        Ok(())
    }
}

/// The model's `state`: `{ nodes: str -> Node }`.
impl NormalizedRuntimeEvidence for Cluster {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        use RuntimeValue::{Int, List, Map, Record, Set, Text};
        if name != "state" {
            return Err(format!("unknown model name {name}"));
        }
        let nodes = self.nodes.iter().map(|(name, n)| {
            let fields = [
                ("term", Int(n.term)),
                ("role", Text(format!("{:?}", n.role))),
                ("votedFor", Text(n.voted_for.clone())),
                ("votes", Set(n.votes.iter().cloned().map(Text).collect())),
                ("log", List(n.log.iter().copied().map(Int).collect())),
                ("commit", Int(n.commit)),
            ];
            let fields = fields.map(|(field, value)| (field.to_owned(), value));
            (Text(name.clone()), Record(fields.into()))
        });
        Ok(Record([("nodes".to_owned(), Map(nodes.collect()))].into()))
    }

    fn resolve_call(&self, _: &str, _: &[RuntimeValue]) -> Option<Result<RuntimeValue, String>> {
        None
    }
}

fn args<const N: usize>(arguments: &[RuntimeValue]) -> Result<&[RuntimeValue; N], String> {
    arguments
        .try_into()
        .map_err(|_| format!("expected {N} arguments: {arguments:?}"))
}

fn text(value: &RuntimeValue) -> Result<&str, String> {
    match value {
        RuntimeValue::Text(text) => Ok(text),
        other => Err(format!("expected a node name: {other:?}")),
    }
}

impl Implementation for Cluster {
    type Evidence = Cluster;

    fn from_initial_state(initial_state: &RuntimeValue) -> Result<Self, String> {
        let RuntimeValue::Record(state) = initial_state else {
            return Err(format!("expected a record: {initial_state:?}"));
        };
        let Some(RuntimeValue::Map(nodes)) = state.get("nodes") else {
            return Err(format!("expected a nodes map: {state:?}"));
        };
        let names = nodes.keys().map(|name| text(name).map(str::to_owned));
        Ok(Cluster::new(names.collect::<Result<Vec<_>, _>>()?))
    }

    fn snapshot(&self) -> Cluster {
        self.clone()
    }

    fn timeout(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [node] = args(arguments)?;
        self.timeout(text(node)?)
    }

    fn grant_vote(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [voter, candidate] = args(arguments)?;
        self.request_vote(text(candidate)?, text(voter)?)
    }

    fn become_leader(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [node] = args(arguments)?;
        self.become_leader(text(node)?)
    }

    fn client_request(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [leader] = args(arguments)?;
        self.client_request(text(leader)?)
    }

    fn append_entries(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [leader, follower] = args(arguments)?;
        self.append_entries(text(leader)?, text(follower)?)
    }

    fn commit(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [leader, RuntimeValue::Int(index)] = args(arguments)? else {
            return Err(format!("commit expects a node and an index: {arguments:?}"));
        };
        self.commit(text(leader)?, *index)
    }
}

fn main() {
    match refine_all::<Cluster>() {
        Ok(results) => {
            for result in results {
                println!(
                    "{} refined {} obligations",
                    result.scenario, result.evaluated_obligations
                );
            }
        }
        Err(error) => {
            eprintln!("refinement failed: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Cluster, refine_all};

    #[test]
    fn cluster_refines_every_raft_scenario() {
        if let Err(error) = refine_all::<Cluster>() {
            panic!("refinement failed: {error}");
        }
    }
}
