package main

import (
	"fmt"
	"slices"
	"sort"

	refinements "github.com/ArchAstro/quint-refinements/bindings/go"
)

// Role is a node's Raft role. Its name is what the model's `role` holds.
type Role string

const (
	Follower  Role = "Follower"
	Candidate Role = "Candidate"
	Leader    Role = "Leader"
)

// Node is one Raft node.
type Node struct {
	term     int64
	role     Role
	votedFor string
	votes    map[string]bool
	// log holds the term of each entry; the commands do not matter here.
	log    []int64
	commit int64
}

func (n *Node) clone() *Node {
	c := *n
	c.votes = make(map[string]bool, len(n.votes))
	for v := range n.votes {
		c.votes[v] = true
	}
	c.log = slices.Clone(n.log)
	return &c
}

// logRank says how up to date the log is: last term first, then length.
func (n *Node) logRank() (int64, int) {
	var last int64
	if len(n.log) > 0 {
		last = n.log[len(n.log)-1]
	}
	return last, len(n.log)
}

// rankLess reports whether rank (t1, l1) is below (t2, l2).
func rankLess(t1 int64, l1 int, t2 int64, l2 int) bool {
	return t1 < t2 || (t1 == t2 && l1 < l2)
}

// Cluster is the code under test: a Raft cluster whose nodes share one process.
type Cluster struct {
	nodes map[string]*Node
}

// NewCluster builds a cluster of fresh followers.
func NewCluster(names ...string) *Cluster {
	c := &Cluster{nodes: map[string]*Node{}}
	for _, name := range names {
		c.nodes[name] = &Node{role: Follower, votes: map[string]bool{}}
	}
	return c
}

func (c *Cluster) clone() *Cluster {
	out := &Cluster{nodes: make(map[string]*Node, len(c.nodes))}
	for name, n := range c.nodes {
		out.nodes[name] = n.clone()
	}
	return out
}

func (c *Cluster) quorum() int { return len(c.nodes)/2 + 1 }

func (c *Cluster) node(name string) (*Node, error) {
	n, ok := c.nodes[name]
	if !ok {
		return nil, fmt.Errorf("no node %s", name)
	}
	return n, nil
}

func (c *Cluster) timeout(name string) error {
	n, err := c.node(name)
	if err != nil {
		return err
	}
	if n.role == Leader {
		return fmt.Errorf("%s leads; a leader does not time out", name)
	}
	n.term++
	n.role = Candidate
	n.votedFor = name
	n.votes = map[string]bool{name: true}
	return nil
}

func (c *Cluster) requestVote(candidate, voter string) error {
	cn, err := c.node(candidate)
	if err != nil {
		return err
	}
	if cn.role != Candidate {
		return fmt.Errorf("%s is not campaigning", candidate)
	}
	term := cn.term
	rt, rl := cn.logRank()
	v, err := c.node(voter)
	if err != nil {
		return err
	}
	vt, vl := v.logRank()
	if term <= v.term || rankLess(rt, rl, vt, vl) {
		return fmt.Errorf("%s refuses to vote for %s", voter, candidate)
	}
	v.term = term
	v.role = Follower
	v.votedFor = candidate
	cn.votes[voter] = true
	return nil
}

func (c *Cluster) becomeLeader(name string) error {
	quorum := c.quorum()
	n, err := c.node(name)
	if err != nil {
		return err
	}
	if n.role != Candidate || len(n.votes) < quorum {
		return fmt.Errorf("%s has no majority", name)
	}
	n.role = Leader
	return nil
}

func (c *Cluster) clientRequest(leader string) error {
	n, err := c.node(leader)
	if err != nil {
		return err
	}
	if n.role != Leader {
		return fmt.Errorf("%s is not the leader", leader)
	}
	n.log = append(n.log, n.term)
	return nil
}

func (c *Cluster) appendEntries(leader, follower string) error {
	l, err := c.node(leader)
	if err != nil {
		return err
	}
	l = l.clone()
	f, err := c.node(follower)
	if err != nil {
		return err
	}
	if leader == follower || l.role != Leader || l.term < f.term {
		return fmt.Errorf("%s rejects stale leader %s", follower, leader)
	}
	f.term = l.term
	f.role = Follower
	f.log = l.log
	f.commit = max(f.commit, l.commit)
	return nil
}

func (c *Cluster) commitEntry(leader string, index int64) error {
	// Raft commits by counting only entries from the leader's own term.
	// Only the leader writes those, so it holds every one it counts.
	ln, err := c.node(leader)
	if err != nil {
		return err
	}
	term := ln.term
	stored := 0
	for _, n := range c.nodes {
		if i := index - 1; i >= 0 && i < int64(len(n.log)) && n.log[i] == term {
			stored++
		}
	}
	if ln.role != Leader || index <= ln.commit || stored < c.quorum() {
		return fmt.Errorf("%s cannot commit entry %d", leader, index)
	}
	ln.commit = index
	return nil
}

// ResolveName exposes the model's `state`: `{ nodes: str -> Node }`.
func (c *Cluster) ResolveName(name string) (refinements.RuntimeValue, error) {
	if name != "state" {
		return nil, fmt.Errorf("unknown model name %s", name)
	}
	names := make([]string, 0, len(c.nodes))
	for name := range c.nodes {
		names = append(names, name)
	}
	sort.Strings(names)
	entries := make([]refinements.MapEntry, 0, len(names))
	for _, name := range names {
		n := c.nodes[name]
		votes := make([]string, 0, len(n.votes))
		for v := range n.votes {
			votes = append(votes, v)
		}
		log := make(refinements.List, 0, len(n.log))
		for _, t := range n.log {
			log = append(log, refinements.Int(t))
		}
		entries = append(entries, refinements.MapEntry{
			Key: refinements.Text(name),
			Value: refinements.Record{
				"term":     refinements.Int(n.term),
				"role":     refinements.Text(n.role),
				"votedFor": refinements.Text(n.votedFor),
				"votes":    refinements.TextSet(votes...),
				"log":      log,
				"commit":   refinements.Int(n.commit),
			},
		})
	}
	return refinements.Record{"nodes": refinements.NewMap(entries...)}, nil
}

// ResolveCall resolves no operators: the model's own are evaluated by the runtime.
func (*Cluster) ResolveCall(string, []refinements.RuntimeValue) (refinements.RuntimeValue, bool, error) {
	return nil, false, nil
}

func text(value refinements.RuntimeValue) (string, error) {
	t, ok := value.(refinements.Text)
	if !ok {
		return "", fmt.Errorf("expected a node name: %s", value)
	}
	return string(t), nil
}

// texts reads exactly n node names.
func texts(arguments []refinements.RuntimeValue, n int) ([]string, error) {
	if len(arguments) != n {
		return nil, fmt.Errorf("expected %d arguments: %v", n, arguments)
	}
	out := make([]string, n)
	for i, a := range arguments {
		s, err := text(a)
		if err != nil {
			return nil, err
		}
		out[i] = s
	}
	return out, nil
}

// adapter connects Cluster to the generated Implementation interface.
type adapter struct{ *Cluster }

// newAdapter builds a Cluster from the scenario's generated initial state.
func newAdapter(initial refinements.RuntimeValue) (*adapter, error) {
	state, ok := initial.(refinements.Record)
	if !ok {
		return nil, fmt.Errorf("expected a record: %s", initial)
	}
	nodes, ok := state["nodes"].(refinements.Map)
	if !ok {
		return nil, fmt.Errorf("expected a nodes map: %s", state)
	}
	var names []string
	for _, e := range nodes.Entries() {
		name, err := text(e.Key)
		if err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return &adapter{Cluster: NewCluster(names...)}, nil
}

// Snapshot implements Implementation; the copy is unaffected by later actions.
func (a *adapter) Snapshot() refinements.Evidence { return a.Cluster.clone() }

// Timeout implements Implementation.
func (a *adapter) Timeout(arguments []refinements.RuntimeValue) error {
	s, err := texts(arguments, 1)
	if err != nil {
		return err
	}
	return a.timeout(s[0])
}

// GrantVote implements Implementation; the model passes (voter, candidate).
func (a *adapter) GrantVote(arguments []refinements.RuntimeValue) error {
	s, err := texts(arguments, 2)
	if err != nil {
		return err
	}
	return a.requestVote(s[1], s[0])
}

// BecomeLeader implements Implementation.
func (a *adapter) BecomeLeader(arguments []refinements.RuntimeValue) error {
	s, err := texts(arguments, 1)
	if err != nil {
		return err
	}
	return a.becomeLeader(s[0])
}

// ClientRequest implements Implementation.
func (a *adapter) ClientRequest(arguments []refinements.RuntimeValue) error {
	s, err := texts(arguments, 1)
	if err != nil {
		return err
	}
	return a.clientRequest(s[0])
}

// AppendEntries implements Implementation.
func (a *adapter) AppendEntries(arguments []refinements.RuntimeValue) error {
	s, err := texts(arguments, 2)
	if err != nil {
		return err
	}
	return a.appendEntries(s[0], s[1])
}

// Commit implements Implementation.
func (a *adapter) Commit(arguments []refinements.RuntimeValue) error {
	if len(arguments) == 2 {
		if index, ok := arguments[1].(refinements.Int); ok {
			leader, err := text(arguments[0])
			if err != nil {
				return err
			}
			return a.commitEntry(leader, int64(index))
		}
	}
	return fmt.Errorf("commit expects a node and an index: %v", arguments)
}
