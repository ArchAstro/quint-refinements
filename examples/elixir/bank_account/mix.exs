defmodule BankAccount.MixProject do
  use Mix.Project

  def project do
    [
      app: :bank_account,
      version: "0.1.0",
      elixir: "~> 1.17",
      deps: [{:quint_refinements, path: "../../../bindings/elixir"}]
    ]
  end

  def application, do: [extra_applications: []]
end
