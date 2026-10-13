# Provider discovery and maintenance

Model choices come from the installed provider in the selected project's working
directory, including its account and project settings. Opening or focusing the
model picker, switching provider, or clicking **Refresh models** performs a fresh
lookup. Each picker shows the last check or a discovery failure. Models are shown
in provider order, followed by effort choices from that specific model. Selecting
a different model resets effort to the provider default. A blank model delegates
both model and effort to the provider's configuration.

Codex uses the app server's paginated `model/list`, with `includeHidden: false`
to match its normal picker. Claude Code uses the Agent SDK's `supportedModels()`
against the installed `claude` executable, including its reported effort support.
Neither adapter sends an inference prompt. There are no hard-coded fallback
models or effort levels. Saved selections remain visible if discovery cannot
verify them; they are explicitly labelled unverified.

Provider UI and SDK releases can differ. Compare the live results with `/model`
in the same directory and account after upgrading a CLI or SDK. Codex selects a
model then reasoning effort. Claude exposes an effort slider in `/model` for
supported models and also supports `/effort`. Do not infer one provider's effort
levels from another provider or from a model's name.

## Maintenance check

Run `npm run providers:check -- /absolute/project/path` after provider updates and
as a weekly maintenance task in the user's logged-in environment. It reports
installed CLI versions, npm's latest published versions, update availability,
the complete discovered catalog, and discovery errors as JSON. It exits nonzero
for failed checks; an available update is advisory. Use `--offline` to skip npm
registry requests (provider discovery itself may still need provider networking).
Prerelease version comparisons report unknown. The check does not install updates.

Use each CLI's supported installation/update method, then rerun this check and
compare `/model`. Also review `npm outdated` for the Claude Agent SDK, update its
lockfile through the normal dependency workflow, and run `npm run typecheck` and
`npm test`. Do not change a user's selected model automatically when an update
appears. Run these checks per account and representative project settings; one
machine's catalog does not establish availability for everyone.

For managed Codex protocol upgrades, also follow the
[continuity acceptance case](roadmaps/managed-codex-continuity.md): check the
installed experimental schema, run broker/lifecycle tests, then verify a dummy
two-turn thread across app-server processes. Recheck permission overrides and
failure without replay, rather than treating successful model discovery as proof
that managed resume works.

## Adding a provider

Add an explicit entry to `MODEL_PROVIDERS` with its discovery adapter and official
npm package (extend the version source if the provider does not publish to npm).
Wire its engine, launch arguments, and controls into the existing AI integration.
Require a supported discovery protocol, bounded timeout and cleanup, complete
pagination, provider order and descriptions, model-specific effort metadata,
project/account settings, and a visible failure state. Never seed model or effort
allowlists. Add protocol fixtures for future model/effort names, missing metadata,
pagination and failures; compare against the provider's native selection command
before shipping. The maintenance check automatically includes registered adapters.

References checked 2026-09-07:

- [Codex app server model discovery](https://learn.chatgpt.com/docs/app-server#list-models-modellist)
- [Claude Code models and effort](https://code.claude.com/docs/en/model-config)

## Planned ai-mesh integration

The [ai-mesh provider plan](roadmaps/ai-mesh-provider.md) separates model selection
from execution location. It adds live mesh discovery and trusted routine/agent
execution while retaining authorized Claude/Codex sessions on the PSM agent
machine. This is planned, not implemented; no subscription credentials are
exported to mesh workers. See M04/M05 for separate provider acceptance gates.
