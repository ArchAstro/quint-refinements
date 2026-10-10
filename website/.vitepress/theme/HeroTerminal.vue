<template>
  <div class="hero-terminal" aria-label="A terminal session: the quick start, then a caught bug">
    <div class="hero-terminal-bar">
      <span></span><span></span><span></span>
      <em>my-check</em>
    </div>
    <pre><code><span class="prompt">$</span> npx quint-refinements new my-check
<span class="dim">created my-check</span>
<span class="prompt">$</span> cd my-check &amp;&amp; cargo run
<span class="pass">✓</span> counter.incrementRun refined 1 obligations

<span class="dim"># edit model.qnt, then</span>
<span class="prompt">$</span> npx quint-refinements compile
<span class="prompt">$</span> cargo run
<span class="fail">✗</span> bank.withdrawRun:withdraw next:
  assign state diverged at <span class="path">state.balance</span>
  expected <span class="pass">Int(6)</span>, observed <span class="fail">Int(14)</span></code></pre>
  </div>
</template>
