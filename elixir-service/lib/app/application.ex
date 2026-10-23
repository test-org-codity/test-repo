defmodule App.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      App.Repo,
      {Plug.Cowboy, scheme: :http, plug: App, options: [port: 4000]}
    ]

    opts = [strategy: :one_for_one, name: App.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
