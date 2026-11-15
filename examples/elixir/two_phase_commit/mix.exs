defmodule TwoPhaseCommit.MixProject do
  use Mix.Project

  def project do
    [
      app: :two_phase_commit,
      version: "0.1.0",
      elixir: "~> 1.17",
      deps: [{:quint_refinements, path: "../../../bindings/elixir"}]
    ]
  end

  def application, do: [extra_applications: []]
end
