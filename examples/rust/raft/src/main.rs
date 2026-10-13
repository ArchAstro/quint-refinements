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

impl Node {
    /// How up to date the log is: last term first, then length.
    fn log_rank(&self) -> (i64, usize) {
        (self.log.last().copied().unwrap_or(0), self.log.len())
    }
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
        name.clone_into(&mut node.voted_for);
        node.votes = BTreeSet::from([name.to_owned()]);
        Ok(())
    }

    fn request_vote(&mut self, candidate: &str, voter: &str) -> Result<(), String> {
        let (term, rank) = match self.node(candidate)? {
            c if c.role == Role::Candidate => (c.term, c.log_rank()),
            _ => return Err(format!("{candidate} is not campaigning")),
        };
        let v = self.node_mut(voter)?;
        if term <= v.term || rank < v.log_rank() {
            return Err(format!("{voter} refuses to vote for {candidate}"));
        }
        v.term = term;
        v.role = Role::Follower;
        candidate.clone_into(&mut v.voted_for);
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
        if leader == follower || l.role != Role::Leader || l.term < f.term {
            return Err(format!("{follower} rejects stale leader {leader}"));
        }
        f.term = l.term;
        f.role = Role::Follower;
        f.log = l.log;
        f.commit = f.commit.max(l.commit);
        Ok(())
    }

    fn commit(&mut self, leader: &str, index: i64) -> Result<(), String> {
        // Raft commits by counting only entries from the leader's own term.
        // Only the leader writes those, so it holds every one it counts.
        let term = self.node(leader)?.term;
        let position = usize::try_from(index - 1).ok();
        let holds = |node: &Node| position.and_then(|i| node.log.get(i)) == Some(&term);
        let stored = self.nodes.values().filter(|node| holds(node)).count();
        let quorum = self.quorum();
        let l = self.node_mut(leader)?;
        if l.role != Role::Leader || index <= l.commit || stored < quorum {
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

    /// The election restriction, on logs no scenario reaches.
    #[test]
    fn votes_go_to_logs_at_least_as_up_to_date() {
        let vote = |candidate: Vec<i64>, voter: Vec<i64>| {
            let mut c = Cluster::new(["c", "v"].map(String::from));
            c.timeout("c").unwrap();
            c.nodes.get_mut("c").unwrap().log = candidate;
            c.nodes.get_mut("v").unwrap().log = voter;
            c.request_vote("c", "v").is_ok()
        };
        assert!(vote(vec![2], vec![1, 1]), "a newer last term beats length");
        assert!(!vote(vec![1, 1], vec![2]), "an older last term loses");
        assert!(!vote(vec![2], vec![2, 2]), "same last term: shorter loses");
        assert!(vote(vec![2, 2], vec![2, 2]), "an equal log wins");
    }

    /// Scenarios only take steps the model allows, so they never reach the
    /// code that refuses a step. This test does.
    #[test]
    fn cluster_refuses_what_raft_refuses() {
        let mut c = Cluster::new(["n1", "n2", "n3"].map(String::from));
        assert!(c.request_vote("n1", "n2").is_err(), "n1 is not campaigning");
        assert!(c.client_request("n1").is_err(), "n1 is not the leader");
        c.timeout("n1").unwrap();
        assert!(c.become_leader("n1").is_err(), "one vote is not a majority");
        c.request_vote("n1", "n2").unwrap();
        assert!(c.request_vote("n1", "n2").is_err(), "one vote per term");
        assert!(c.become_leader("n2").is_err(), "n2 is not a candidate");
        c.become_leader("n1").unwrap();
        assert!(c.become_leader("n1").is_err(), "n1 already leads");
        assert!(
            c.request_vote("n1", "n3").is_err(),
            "a leader is not campaigning"
        );
        assert!(c.timeout("n1").is_err(), "a leader does not time out");
        assert!(c.append_entries("n2", "n3").is_err(), "n2 is not a leader");
        assert!(
            c.append_entries("n1", "n1").is_err(),
            "a leader is not its own follower"
        );
        assert!(c.commit("n1", 1).is_err(), "the log is empty");
        c.client_request("n1").unwrap();
        assert!(c.commit("n1", 1).is_err(), "only n1 stores the entry");
        c.append_entries("n1", "n2").unwrap();
        c.timeout("n3").unwrap();
        c.timeout("n3").unwrap();
        assert!(c.request_vote("n3", "n2").is_err(), "n3's log is shorter");
        c.timeout("n2").unwrap();
        c.timeout("n2").unwrap();
        c.request_vote("n2", "n3").unwrap();
        c.become_leader("n2").unwrap();
        assert!(c.append_entries("n1", "n2").is_err(), "n1's term is stale");
        assert!(c.commit("n2", 1).is_err(), "entry 1 is from an older term");
        c.client_request("n2").unwrap();
        c.append_entries("n2", "n3").unwrap();
        assert!(c.commit("n3", 2).is_err(), "n3 is not the leader");
        c.commit("n2", 2).unwrap();
        assert!(c.commit("n2", 2).is_err(), "entry 2 is already committed");
    }
}
