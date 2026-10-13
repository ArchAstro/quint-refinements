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

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    RequestVote,
    Vote,
    Append,
    Ack,
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
    /// Leader only: how much of its log each node is known to store.
    matched: BTreeMap<String, i64>,
}

/// One shape for all four kinds; fields a kind does not use stay empty.
#[derive(Clone)]
struct Msg {
    kind: Kind,
    src: String,
    dst: String,
    term: i64,
    log: Vec<i64>,
    commit: i64,
    ok: bool,
    index: i64,
}

impl Msg {
    fn new(kind: Kind, src: &str, dst: &str, term: i64) -> Self {
        let (src, dst) = (src.to_owned(), dst.to_owned());
        let (log, commit, ok, index) = (Vec::new(), 0, false, 0);
        Self {
            kind,
            src,
            dst,
            term,
            log,
            commit,
            ok,
            index,
        }
    }
}

/// How up to date a log is: last term first, then length.
fn rank(log: &[i64]) -> (i64, usize) {
    (log.last().copied().unwrap_or(0), log.len())
}

/// The code under test: Raft nodes in one process, and the messages between
/// them. Sent messages are kept, so any can be delivered late, out of order,
/// more than once, or never.
#[derive(Clone)]
struct Cluster {
    nodes: BTreeMap<String, Node>,
    msgs: Vec<Msg>,
}

impl Cluster {
    fn new(names: &[String]) -> Self {
        let node = Node {
            term: 0,
            role: Role::Follower,
            voted_for: String::new(),
            votes: BTreeSet::new(),
            log: Vec::new(),
            commit: 0,
            matched: names.iter().map(|name| (name.clone(), 0)).collect(),
        };
        let nodes = names.iter().map(|name| (name.clone(), node.clone()));
        Self {
            nodes: nodes.collect(),
            msgs: Vec::new(),
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
        let c = self.node(candidate)?;
        if candidate == voter || c.role != Role::Candidate {
            return Err(format!("{candidate} is not campaigning"));
        }
        let log = c.log.clone();
        let msg = Msg {
            log,
            ..Msg::new(Kind::RequestVote, candidate, voter, c.term)
        };
        self.msgs.push(msg);
        Ok(())
    }

    fn become_leader(&mut self, name: &str) -> Result<(), String> {
        let quorum = self.quorum();
        let node = self.node_mut(name)?;
        if node.role != Role::Candidate || node.votes.len() < quorum {
            return Err(format!("{name} has no majority"));
        }
        node.role = Role::Leader;
        node.matched.values_mut().for_each(|matched| *matched = 0);
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

    fn send_append(&mut self, leader: &str, follower: &str) -> Result<(), String> {
        let l = self.node(leader)?;
        if leader == follower || l.role != Role::Leader {
            return Err(format!("{leader} is not the leader"));
        }
        let (log, commit) = (l.log.clone(), l.commit);
        let msg = Msg {
            log,
            commit,
            ..Msg::new(Kind::Append, leader, follower, l.term)
        };
        self.msgs.push(msg);
        Ok(())
    }

    /// Deliver message `i`, which must be of `kind`, and send any reply.
    fn deliver(&mut self, i: i64, kind: Kind) -> Result<(), String> {
        let m = usize::try_from(i)
            .ok()
            .and_then(|i| self.msgs.get(i))
            .filter(|m| m.kind == kind)
            .cloned()
            .ok_or(format!("no {kind:?} message {i}"))?;
        let node = self.node_mut(&m.dst)?;
        if m.term > node.term {
            node.term = m.term;
            node.role = Role::Follower;
            node.voted_for.clear();
        }
        let current = m.term == node.term;
        let reply = match kind {
            Kind::RequestVote => {
                let free = node.voted_for.is_empty() || node.voted_for == m.src;
                let ok = current && free && rank(&m.log) >= rank(&node.log);
                if ok {
                    m.src.clone_into(&mut node.voted_for);
                }
                Some(Msg {
                    ok,
                    ..Msg::new(Kind::Vote, &m.dst, &m.src, node.term)
                })
            }
            Kind::Vote => {
                if m.ok && current && node.role == Role::Candidate {
                    node.votes.insert(m.src);
                }
                None
            }
            Kind::Append => {
                let index = i64::try_from(m.log.len()).map_err(|e| e.to_string())?;
                if current {
                    node.role = Role::Follower;
                    // A late append from this leader must not shorten the log.
                    if !node.log.starts_with(&m.log) {
                        node.log.clone_from(&m.log);
                    }
                    node.commit = node.commit.max(m.commit);
                }
                Some(Msg {
                    ok: current,
                    index,
                    ..Msg::new(Kind::Ack, &m.dst, &m.src, node.term)
                })
            }
            Kind::Ack => {
                if m.ok && current && node.role == Role::Leader {
                    let matched = node.matched.entry(m.src).or_default();
                    *matched = (*matched).max(m.index);
                }
                None
            }
        };
        self.msgs.extend(reply);
        Ok(())
    }

    fn commit(&mut self, leader: &str, index: i64) -> Result<(), String> {
        let quorum = self.quorum();
        let l = self.node_mut(leader)?;
        let own_term = usize::try_from(index - 1).ok().and_then(|i| l.log.get(i)) == Some(&l.term);
        let stored = l
            .matched
            .iter()
            .filter(|(n, m)| *n == leader || **m >= index)
            .count();
        if l.role != Role::Leader || index <= l.commit || !own_term || stored < quorum {
            return Err(format!("{leader} cannot commit entry {index}"));
        }
        l.commit = index;
        Ok(())
    }
}

/// The model's `state`: `{ nodes: str -> Node, msgs: List[Msg] }`.
impl NormalizedRuntimeEvidence for Cluster {
    fn resolve_name(&self, name: &str) -> Result<RuntimeValue, String> {
        use RuntimeValue::{Bool, Int, List, Map, Record, Set, Text};
        if name != "state" {
            return Err(format!("unknown model name {name}"));
        }
        let record = |fields: Vec<(&str, RuntimeValue)>| {
            Record(fields.into_iter().map(|(f, v)| (f.to_owned(), v)).collect())
        };
        let log = |log: &[i64]| List(log.iter().copied().map(Int).collect());
        let nodes = self.nodes.iter().map(|(name, n)| {
            let matched = n.matched.iter().map(|(k, v)| (Text(k.clone()), Int(*v)));
            let node = record(vec![
                ("term", Int(n.term)),
                ("role", Text(format!("{:?}", n.role))),
                ("votedFor", Text(n.voted_for.clone())),
                ("votes", Set(n.votes.iter().cloned().map(Text).collect())),
                ("log", log(&n.log)),
                ("commit", Int(n.commit)),
                ("matched", Map(matched.collect())),
            ]);
            (Text(name.clone()), node)
        });
        let msgs = self.msgs.iter().map(|m| {
            record(vec![
                ("kind", Text(format!("{:?}", m.kind))),
                ("src", Text(m.src.clone())),
                ("dst", Text(m.dst.clone())),
                ("term", Int(m.term)),
                ("log", log(&m.log)),
                ("commit", Int(m.commit)),
                ("ok", Bool(m.ok)),
                ("index", Int(m.index)),
            ])
        });
        Ok(record(vec![
            ("nodes", Map(nodes.collect())),
            ("msgs", List(msgs.collect())),
        ]))
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

fn int(value: &RuntimeValue) -> Result<i64, String> {
    match value {
        RuntimeValue::Int(value) => Ok(*value),
        other => Err(format!("expected an integer: {other:?}")),
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
        Ok(Cluster::new(&names.collect::<Result<Vec<_>, _>>()?))
    }

    fn snapshot(&self) -> Cluster {
        self.clone()
    }

    fn timeout(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [node] = args(arguments)?;
        self.timeout(text(node)?)
    }

    fn request_vote(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [candidate, voter] = args(arguments)?;
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

    fn send_append(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [leader, follower] = args(arguments)?;
        self.send_append(text(leader)?, text(follower)?)
    }

    fn receive_request_vote(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [i] = args(arguments)?;
        self.deliver(int(i)?, Kind::RequestVote)
    }

    fn receive_vote(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [i] = args(arguments)?;
        self.deliver(int(i)?, Kind::Vote)
    }

    fn receive_append(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [i] = args(arguments)?;
        self.deliver(int(i)?, Kind::Append)
    }

    fn receive_ack(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [i] = args(arguments)?;
        self.deliver(int(i)?, Kind::Ack)
    }

    fn commit(&mut self, arguments: &[RuntimeValue]) -> Result<(), String> {
        let [leader, index] = args(arguments)?;
        self.commit(text(leader)?, int(index)?)
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
    use super::{Cluster, Kind, Msg, Role, refine_all};

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
            let mut c = Cluster::new(&["c", "v"].map(String::from));
            c.timeout("c").unwrap();
            c.nodes.get_mut("c").unwrap().log = candidate;
            c.nodes.get_mut("v").unwrap().log = voter;
            c.request_vote("c", "v").unwrap();
            c.deliver(0, Kind::RequestVote).unwrap();
            c.msgs[1].ok
        };
        assert!(vote(vec![2], vec![1, 1]), "a newer last term beats length");
        assert!(!vote(vec![1, 1], vec![2]), "an older last term loses");
        assert!(!vote(vec![2], vec![2, 2]), "same last term: shorter loses");
        assert!(vote(vec![2, 2], vec![2, 2]), "an equal log wins");
    }

    /// Branches that need histories too long for a scenario.
    #[test]
    fn leaders_count_only_what_followers_store_now() {
        let mut c = Cluster::new(&["n1", "n2", "n3"].map(String::from));
        let n1 = c.nodes.get_mut("n1").unwrap();
        (n1.term, n1.role, n1.log) = (2, Role::Leader, vec![1]);
        n1.matched.insert("n2".to_owned(), 1);
        assert!(c.commit("n1", 1).is_err(), "entry 1 is from an older term");
        let n2 = c.nodes.get_mut("n2").unwrap();
        (n2.term, n2.log) = (2, vec![2]);
        n2.matched.insert("n3".to_owned(), 1);
        assert!(c.commit("n2", 1).is_err(), "n2 is not the leader");
        let refused = Msg {
            ok: false,
            index: 1,
            ..Msg::new(Kind::Ack, "n3", "n1", 2)
        };
        c.msgs.push(refused);
        c.deliver(0, Kind::Ack).unwrap();
        assert_eq!(
            c.nodes["n1"].matched["n3"], 0,
            "a refused ack counts nothing"
        );
    }

    /// An append from an older term changes nothing but the reply.
    #[test]
    fn a_rejected_append_changes_nothing() {
        let mut c = Cluster::new(&["n1", "n2"].map(String::from));
        c.nodes.get_mut("n2").unwrap().term = 2;
        let stale = Msg {
            log: vec![1],
            commit: 1,
            ..Msg::new(Kind::Append, "n1", "n2", 1)
        };
        c.msgs.push(stale);
        c.deliver(0, Kind::Append).unwrap();
        let n2 = &c.nodes["n2"];
        assert_eq!((n2.role, n2.commit, n2.log.len()), (Role::Follower, 0, 0));
        assert!(!c.msgs[1].ok);
    }

    /// Scenarios only take steps the model allows, so they never reach the
    /// code that refuses a step. This test does.
    #[test]
    fn cluster_refuses_what_raft_refuses() {
        let mut c = Cluster::new(&["n1", "n2", "n3"].map(String::from));
        assert!(c.request_vote("n1", "n2").is_err(), "n1 is not campaigning");
        assert!(c.send_append("n1", "n2").is_err(), "n1 is not the leader");
        assert!(c.client_request("n1").is_err(), "n1 is not the leader");
        assert!(c.deliver(0, Kind::Vote).is_err(), "nothing was sent");
        c.timeout("n1").unwrap();
        assert!(c.request_vote("n1", "n1").is_err(), "no request to itself");
        assert!(c.become_leader("n1").is_err(), "one vote is not a majority");
        c.request_vote("n1", "n2").unwrap(); // 0
        assert!(c.deliver(0, Kind::Append).is_err(), "0 is a vote request");
        c.deliver(0, Kind::RequestVote).unwrap(); // 1
        c.deliver(1, Kind::Vote).unwrap();
        assert!(c.become_leader("n2").is_err(), "n2 is not a candidate");
        c.become_leader("n1").unwrap();
        assert!(c.become_leader("n1").is_err(), "n1 already leads");
        assert!(
            c.request_vote("n1", "n3").is_err(),
            "a leader is not campaigning"
        );
        assert!(c.timeout("n1").is_err(), "a leader does not time out");
        assert!(c.send_append("n1", "n1").is_err(), "no append to itself");
        assert!(c.commit("n1", 1).is_err(), "the log is empty");
        c.client_request("n1").unwrap();
        assert!(c.commit("n1", 1).is_err(), "only n1 stores the entry");
        c.send_append("n1", "n2").unwrap(); // 2
        c.deliver(2, Kind::Append).unwrap(); // 3
        c.deliver(3, Kind::Ack).unwrap();
        c.commit("n1", 1).unwrap();
        assert!(c.commit("n1", 1).is_err(), "entry 1 is already committed");
    }
}
