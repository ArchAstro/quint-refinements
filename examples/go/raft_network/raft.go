package main

import (
	"fmt"
	"slices"
	"sort"

	refinements "github.com/ArchAstro/quint-refinements/bindings/go"
)

type role string

const (
	follower  role = "Follower"
	candidate role = "Candidate"
	leader    role = "Leader"
)

type kind string

const (
	kindRequestVote kind = "RequestVote"
	kindVote        kind = "Vote"
	kindAppend      kind = "Append"
	kindAck         kind = "Ack"
)

type node struct {
	term     int64
	role     role
	votedFor string
	votes    map[string]bool
	// The term of each entry; the commands themselves do not matter here.
	log    []int64
	commit int64
	// Leader only: how much of its log each node is known to store.
	matched map[string]int64
}

func (n *node) clone() *node {
	c := *n
	c.votes = make(map[string]bool, len(n.votes))
	for k, v := range n.votes {
		c.votes[k] = v
	}
	c.log = slices.Clone(n.log)
	c.matched = make(map[string]int64, len(n.matched))
	for k, v := range n.matched {
		c.matched[k] = v
	}
	return &c
}

// msg is one shape for all four kinds; fields a kind does not use stay empty.
type msg struct {
	kind     kind
	src, dst string
	term     int64
	log      []int64
	commit   int64
	ok       bool
	index    int64
}

func newMsg(k kind, src, dst string, term int64) msg {
	return msg{kind: k, src: src, dst: dst, term: term}
}

// rank is how up to date a log is: last term first, then length.
func rank(log []int64) (int64, int) {
	var last int64
	if len(log) > 0 {
		last = log[len(log)-1]
	}
	return last, len(log)
}

func rankAtLeast(a, b []int64) bool {
	at, al := rank(a)
	bt, bl := rank(b)
	if at != bt {
		return at > bt
	}
	return al >= bl
}

// Cluster is the code under test: Raft nodes in one process, and the messages
// between them. Sent messages are kept, so any can be delivered late, out of
// order, more than once, or never.
type Cluster struct {
	nodes map[string]*node
	msgs  []msg
}

func newCluster(names []string) *Cluster {
	c := &Cluster{nodes: map[string]*node{}}
	for _, name := range names {
		n := &node{role: follower, votes: map[string]bool{}, matched: map[string]int64{}}
		for _, other := range names {
			n.matched[other] = 0
		}
		c.nodes[name] = n
	}
	return c
}

func (c *Cluster) quorum() int { return len(c.nodes)/2 + 1 }

func (c *Cluster) node(name string) (*node, error) {
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
	if n.role == leader {
		return fmt.Errorf("%s leads; a leader does not time out", name)
	}
	n.term++
	n.role = candidate
	n.votedFor = name
	n.votes = map[string]bool{name: true}
	return nil
}

func (c *Cluster) requestVote(cand, voter string) error {
	n, err := c.node(cand)
	if err != nil {
		return err
	}
	if cand == voter || n.role != candidate {
		return fmt.Errorf("%s is not campaigning", cand)
	}
	m := newMsg(kindRequestVote, cand, voter, n.term)
	m.log = slices.Clone(n.log)
	c.msgs = append(c.msgs, m)
	return nil
}

func (c *Cluster) becomeLeader(name string) error {
	quorum := c.quorum()
	n, err := c.node(name)
	if err != nil {
		return err
	}
	if n.role != candidate || len(n.votes) < quorum {
		return fmt.Errorf("%s has no majority", name)
	}
	n.role = leader
	for k := range n.matched {
		n.matched[k] = 0
	}
	return nil
}

func (c *Cluster) clientRequest(name string) error {
	n, err := c.node(name)
	if err != nil {
		return err
	}
	if n.role != leader {
		return fmt.Errorf("%s is not the leader", name)
	}
	n.log = append(n.log, n.term)
	return nil
}

func (c *Cluster) sendAppend(lead, fol string) error {
	l, err := c.node(lead)
	if err != nil {
		return err
	}
	if lead == fol || l.role != leader {
		return fmt.Errorf("%s is not the leader", lead)
	}
	m := newMsg(kindAppend, lead, fol, l.term)
	m.log = slices.Clone(l.log)
	m.commit = l.commit
	c.msgs = append(c.msgs, m)
	return nil
}

// deliver message i, which must be of k, and send any reply.
func (c *Cluster) deliver(i int64, k kind) error {
	if i < 0 || i >= int64(len(c.msgs)) || c.msgs[i].kind != k {
		return fmt.Errorf("no %s message %d", k, i)
	}
	m := c.msgs[i]
	n, err := c.node(m.dst)
	if err != nil {
		return err
	}
	if m.term > n.term {
		n.term = m.term
		n.role = follower
		n.votedFor = ""
	}
	current := m.term == n.term
	var reply *msg
	switch k {
	case kindRequestVote:
		free := n.votedFor == "" || n.votedFor == m.src
		ok := current && free && rankAtLeast(m.log, n.log)
		if ok {
			n.votedFor = m.src
		}
		r := newMsg(kindVote, m.dst, m.src, n.term)
		r.ok = ok
		reply = &r
	case kindVote:
		if m.ok && current && n.role == candidate {
			n.votes[m.src] = true
		}
	case kindAppend:
		index := int64(len(m.log))
		if current {
			n.role = follower
			// A late append from this leader must not shorten the log.
			if !slices.Equal(n.log[:min(len(n.log), len(m.log))], m.log) || len(n.log) < len(m.log) {
				n.log = slices.Clone(m.log)
			}
			n.commit = max(n.commit, m.commit)
		}
		r := newMsg(kindAck, m.dst, m.src, n.term)
		r.ok, r.index = current, index
		reply = &r
	case kindAck:
		if m.ok && current && n.role == leader {
			n.matched[m.src] = max(n.matched[m.src], m.index)
		}
	}
	if reply != nil {
		c.msgs = append(c.msgs, *reply)
	}
	return nil
}

func (c *Cluster) commit(lead string, index int64) error {
	quorum := c.quorum()
	l, err := c.node(lead)
	if err != nil {
		return err
	}
	ownTerm := index-1 >= 0 && index-1 < int64(len(l.log)) && l.log[index-1] == l.term
	stored := 0
	for name, m := range l.matched {
		if name == lead || m >= index {
			stored++
		}
	}
	if l.role != leader || index <= l.commit || !ownTerm || stored < quorum {
		return fmt.Errorf("%s cannot commit entry %d", lead, index)
	}
	l.commit = index
	return nil
}

// snapshot is the model's `state`: { nodes: str -> Node, msgs: List[Msg] }.
// It is built eagerly, so later actions cannot change it.
type snapshot struct{ state refinements.RuntimeValue }

func logValue(log []int64) refinements.List {
	out := make(refinements.List, len(log))
	for i, v := range log {
		out[i] = refinements.Int(v)
	}
	return out
}

func (c *Cluster) snapshot() snapshot {
	var entries []refinements.MapEntry
	for name, n := range c.nodes {
		var matched []refinements.MapEntry
		for k, v := range n.matched {
			matched = append(matched, refinements.MapEntry{Key: refinements.Text(k), Value: refinements.Int(v)})
		}
		votes := make([]string, 0, len(n.votes))
		for v := range n.votes {
			votes = append(votes, v)
		}
		sort.Strings(votes)
		entries = append(entries, refinements.MapEntry{
			Key: refinements.Text(name),
			Value: refinements.Record{
				"term":     refinements.Int(n.term),
				"role":     refinements.Text(n.role),
				"votedFor": refinements.Text(n.votedFor),
				"votes":    refinements.TextSet(votes...),
				"log":      logValue(n.log),
				"commit":   refinements.Int(n.commit),
				"matched":  refinements.NewMap(matched...),
			},
		})
	}
	msgs := make(refinements.List, len(c.msgs))
	for i, m := range c.msgs {
		msgs[i] = refinements.Record{
			"kind":   refinements.Text(m.kind),
			"src":    refinements.Text(m.src),
			"dst":    refinements.Text(m.dst),
			"term":   refinements.Int(m.term),
			"log":    logValue(m.log),
			"commit": refinements.Int(m.commit),
			"ok":     refinements.Bool(m.ok),
			"index":  refinements.Int(m.index),
		}
	}
	return snapshot{state: refinements.Record{
		"nodes": refinements.NewMap(entries...),
		"msgs":  msgs,
	}}
}

func (s snapshot) ResolveName(name string) (refinements.RuntimeValue, error) {
	if name != "state" {
		return nil, fmt.Errorf("unknown model name %s", name)
	}
	return s.state, nil
}

func (snapshot) ResolveCall(string, []refinements.RuntimeValue) (refinements.RuntimeValue, bool, error) {
	return nil, false, nil
}

func text(v refinements.RuntimeValue) (string, error) {
	if t, ok := v.(refinements.Text); ok {
		return string(t), nil
	}
	return "", fmt.Errorf("expected a node name: %s", v)
}

func integer(v refinements.RuntimeValue) (int64, error) {
	if i, ok := v.(refinements.Int); ok {
		return int64(i), nil
	}
	return 0, fmt.Errorf("expected an integer: %s", v)
}

func texts(n int, arguments []refinements.RuntimeValue) ([]string, error) {
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

func oneInt(arguments []refinements.RuntimeValue) (int64, error) {
	if len(arguments) != 1 {
		return 0, fmt.Errorf("expected 1 arguments: %v", arguments)
	}
	return integer(arguments[0])
}

// adapter connects Cluster to the generated Implementation interface.
type adapter struct{ *Cluster }

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
	return &adapter{newCluster(names)}, nil
}

func (a *adapter) Snapshot() refinements.Evidence { return a.Cluster.snapshot() }

func (a *adapter) Timeout(args []refinements.RuntimeValue) error {
	s, err := texts(1, args)
	if err != nil {
		return err
	}
	return a.timeout(s[0])
}

func (a *adapter) RequestVote(args []refinements.RuntimeValue) error {
	s, err := texts(2, args)
	if err != nil {
		return err
	}
	return a.requestVote(s[0], s[1])
}

func (a *adapter) BecomeLeader(args []refinements.RuntimeValue) error {
	s, err := texts(1, args)
	if err != nil {
		return err
	}
	return a.becomeLeader(s[0])
}

func (a *adapter) ClientRequest(args []refinements.RuntimeValue) error {
	s, err := texts(1, args)
	if err != nil {
		return err
	}
	return a.clientRequest(s[0])
}

func (a *adapter) SendAppend(args []refinements.RuntimeValue) error {
	s, err := texts(2, args)
	if err != nil {
		return err
	}
	return a.sendAppend(s[0], s[1])
}

func (a *adapter) receive(k kind, args []refinements.RuntimeValue) error {
	i, err := oneInt(args)
	if err != nil {
		return err
	}
	return a.deliver(i, k)
}

func (a *adapter) ReceiveRequestVote(args []refinements.RuntimeValue) error {
	return a.receive(kindRequestVote, args)
}
func (a *adapter) ReceiveVote(args []refinements.RuntimeValue) error {
	return a.receive(kindVote, args)
}
func (a *adapter) ReceiveAppend(args []refinements.RuntimeValue) error {
	return a.receive(kindAppend, args)
}
func (a *adapter) ReceiveAck(args []refinements.RuntimeValue) error {
	return a.receive(kindAck, args)
}

func (a *adapter) Commit(args []refinements.RuntimeValue) error {
	if len(args) != 2 {
		return fmt.Errorf("expected 2 arguments: %v", args)
	}
	l, err := text(args[0])
	if err != nil {
		return err
	}
	i, err := integer(args[1])
	if err != nil {
		return err
	}
	return a.commit(l, i)
}
