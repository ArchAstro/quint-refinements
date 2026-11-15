defmodule QuintRefinements.MixProject do
  use Mix.Project

  @version "0.2.0"
  @source_url "https://github.com/ArchAstro/quint-refinements"

  def project do
    [
      app: :quint_refinements,
      version: @version,
      elixir: "~> 1.17",
      start_permanent: Mix.env() == :prod,
      deps: [],
      description: "Check an Elixir implementation against a Quint model",
      package: package(),
      source_url: @source_url,
      homepage_url: "https://archastro.github.io/quint-refinements/",
      docs: [main: "QuintRefinements", source_ref: "v#{@version}"]
    ]
  end

  def application do
    [extra_applications: []]
  end

  defp package do
    [
      licenses: ["MIT"],
      links: %{"GitHub" => @source_url, "Docs" => "https://archastro.github.io/quint-refinements/"},
      files: ~w(lib mix.exs README.md LICENSE .formatter.exs)
    ]
  end
end
