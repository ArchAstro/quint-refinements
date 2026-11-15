defmodule QuintRefinements.TestSupport do
  @moduledoc """
  Expression builders for tests: they produce the decoded-JSON shape the
  evaluator interprets.
  """

  alias QuintRefinements.{Evidence, Value}

  def call(operator, arguments \\ []), do: %{"kind" => "call", "operator" => operator, "arguments" => arguments}
  def int_expr(value), do: %{"kind" => "int", "value" => value}
  def text_expr(value), do: %{"kind" => "str", "value" => value}
  def bool_expr(value), do: %{"kind" => "bool", "value" => value}
  def name_expr(value), do: %{"kind" => "name", "value" => value}
  def lambda(body, parameters), do: %{"kind" => "lambda", "parameters" => parameters, "body" => body}

  def assertion(expression, scope \\ :runtime, dependencies \\ []) do
    %{scope: scope, expression: expression, dependencies: dependencies}
  end

  @doc "Evidence that resolves nothing."
  def no_state, do: Evidence.new(fn _name -> nil end)

  @doc "Evidence whose state is an empty record."
  def empty_state, do: Evidence.state(Value.record())

  def corpus(name, file) do
    File.read!(Path.join([__DIR__, "../../../conformance/cases", name, file]))
  end

  def message(fun) do
    ExUnit.Assertions.assert_raise(QuintRefinements.Error, fun).message
  end

  def minimal_artifact do
    """
    {
      "schemaVersion": 2,
      "modelDigest": "sha256:test",
      "vocabulary": {
        "actions": ["submitInvocation", "selectForAttempt", "enqueueSelectedDelivery"],
        "capabilities": ["transport.basic"],
        "expressionOperators": [],
        "expressionNames": [],
        "runtimeObservationDependencies": [],
        "runtimeObservationDependencyDigest": "sha256:test"
      },
      "fixtures": { "m": {} },
      "scenarios": [{
        "source": "m.qnt",
        "module": "m",
        "fixtureNamespace": "m",
        "name": "run",
        "requiredCapabilities": ["transport.basic"],
        "steps": [
          {"index": 0, "kind": "init", "action": "init", "arguments": []},
          {"index": 1, "kind": "action", "action": "submitInvocation", "arguments": []},
          {"index": 2, "kind": "action", "action": "selectForAttempt", "arguments": []},
          {"index": 3, "kind": "action", "action": "enqueueSelectedDelivery", "arguments": []}
        ]
      }]
    }
    """
  end
end

ExUnit.start()
