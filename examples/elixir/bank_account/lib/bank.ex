defmodule Bank do
  @moduledoc "The code under test: a one-account bank."

  @enforce_keys [:balance]
  defstruct [:balance]

  @type t :: %__MODULE__{balance: integer()}

  @spec withdraw(t(), integer()) :: {:ok, t()} | {:error, :not_positive | :insufficient_funds}
  def withdraw(%__MODULE__{}, amount) when amount <= 0, do: {:error, :not_positive}

  def withdraw(%__MODULE__{balance: balance}, amount) when balance < amount,
    do: {:error, :insufficient_funds}

  def withdraw(%__MODULE__{balance: balance} = bank, amount),
    do: {:ok, %{bank | balance: balance - amount}}
end

defmodule Bank.Adapter do
  @moduledoc """
  Connects `Bank` to the generated `Implementation` behaviour. The generated
  callback takes Quint's arguments; the real function takes an integer.
  """

  @behaviour Bank.GeneratedRefinement.Implementation

  alias QuintRefinements.{Access, Evidence, Value}

  # Builds a Bank from the scenario's generated initial state.
  @impl true
  def from_initial_state(initial) do
    %Bank{balance: initial |> Access.field("balance") |> Access.as_int()}
  end

  # What the refinement checker may observe after each action.
  @impl true
  def snapshot(%Bank{balance: balance}),
    do: Evidence.state(Value.record(balance: Value.int(balance)))

  @impl true
  def withdraw(%Bank{} = bank, [amount]) do
    case Bank.withdraw(bank, Access.as_int(amount)) do
      {:ok, bank} -> bank
      {:error, reason} -> raise "withdraw failed: #{reason}"
    end
  end
end
