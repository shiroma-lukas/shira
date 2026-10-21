# Model providers

An agent's model choice names two things: the **harness** that edits files and runs commands,
and the **provider** that serves the tokens. Today there is one harness, Claude Code, and two
providers:

| Provider | `provider:` | Credential | Egress opened | Cost in the ledger |
|---|---|---|---|---|
| Anthropic | `anthropic` (default) | `ANTHROPIC_API_KEY` | `api.anthropic.com` | Claude Code's own figure |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `openrouter.ai` | Tokens × OpenRouter's listed price |

A sandbox only reaches the provider its agent uses, and only gets that provider's credential.

## Running an open model through OpenRouter

Claude Code speaks the Anthropic Messages API, which OpenRouter also serves for every model
it routes, so any OpenRouter model with tool use runs in the same harness. For example, GLM
5.3 Flash as the worker:

```yaml
# config/agents/worker.yaml
model:
  primary: { harness: claude-code, model: z-ai/glm-5.3-flash, provider: openrouter }
```

and in `.env`:

```sh
OPENROUTER_API_KEY=sk-or-...
```

The dispatcher points Claude Code at `https://openrouter.ai/api` with the key as a bearer token
and pins every Claude Code model role (including the small model it uses for background work)
to the agent's model, so a run never quietly falls back to a Claude model billed through
OpenRouter. It checks at startup that every configured provider has its key.

Model ids are OpenRouter's (`GET https://openrouter.ai/api/v1/models`). Claude Code is tuned for
Claude models: check that a model reliably calls tools and returns the structured reply before
giving it real work. A model that never returns the reply ends the run as an error, which is
retried and then fails the task.

## Cost and budgets

- **Anthropic.** Claude Code reports the run's cost, and `--max-budget-usd` stops a run at the
  task's remaining dollars.
- **OpenRouter.** Claude Code can't price other models (it guesses a Claude price, which is
  orders of magnitude off for small open models), so its figure is ignored. The dispatcher
  fetches OpenRouter's price list at startup (refreshing it once it is an hour old), and prices each run from
  its token counts. The figure is an estimate: OpenRouter's invoice can differ when it routes
  to an upstream provider with another price. `--max-budget-usd` is not passed; the dollar
  budget is checked between runs, and the time budget stops a run mid-way as for any harness.
- **Unknown cost.** When a model has no price (the list couldn't be fetched, or the model isn't
  on it), the run's cost is recorded as unknown (`NULL`), never as zero. Spend then shows as
  e.g. `$0.25 + unknown (2 unpriced runs)`, and unknown runs don't count toward dollar budgets,
  so set token and time budgets for agents on providers you can't price.
