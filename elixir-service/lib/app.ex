defmodule App do
  use Phoenix.Router
  import Ecto.Query
  alias App.Repo

  require Logger

  def start do
    Logger.info("Starting Elixir service")
  end

  def get_users(query_string) do
    from(u in "users",
      where: fragment("name LIKE ?", ^"%#{query_string}%"),
      select: u
    )
    |> Repo.all()
  end
end
