# Engineering workflows, bundles and harness integrations

Status: planned under P11 in the [delivery index](README.md).
Product decision recorded 2026-10-05: PSM should help users adopt and evaluate
the workflows of skilled software engineers, from one skill through a complete
agent harness. Users must be able to add or remove the whole setup or its
independently usable components. Sandcastle is the first concrete integration
candidate. This records the agreed direction; integration remains unimplemented.

## Outcome and vocabulary

Users can import a workflow, understand what it changes, try it on a project,
measure whether it helps, customise it and remove it. PSM supports both adapting
useful practices into its existing agent workflow and executing an external
harness when that brings a demonstrated benefit.

| Component | Meaning | Example |
| --- | --- | --- |
| Skill | Instructions an agent can select or invoke. | Test-driven development. |
| Capability | A tool, service, document or API available to the agent. | Browser testing or an MCP server. |
| Workflow | Ordered or branching steps with inputs, checks and handoffs. | Plan → implement → test → review. |
| Harness | Executable software coordinating agents and their working environment. | Sandcastle. |
| Bundle | A versioned collection of components and their dependency declarations. | An engineer's published working setup. |

A workflow does not have to include an external harness. A harness may support
several workflows. Repository files used to develop a harness are not
automatically reusable or distributable components of its product.

## Existing foundation and architecture extension

The [attachment system](../attach-plan.md) already wires individual skills,
documents, APIs and MCP servers into projects with pinned copies and ownership
records. Build bundle management on that catalog and ledger. Reuse the existing
agent sessions, access policies and [runner boundary](../../src/runner/backend.ts)
for execution, rather than introducing another independent permission system.

The attachment specification's file-wiring-only architecture remains the baseline
for ordinary attachments. P11 extends it with explicit workflow and harness
execution adapters. Executable workflows, lifecycle hooks and dependencies have
their own reviewed execution contract; an instruction attachment alone cannot
start a harness or widen its access.

## Delivery within P11

| Milestone | Scope | Prerequisites / acceptance |
| --- | --- | --- |
| **P11a — local bundles** | Import, pin, select, enable/disable, remove and update components. | Existing attachment ledger and P02 core. Prove shared-component removal, user-edit preservation and blocked dependencies. |
| **P11b — workflow execution and evaluation** | Workflow steps, comparison evidence and the first Sandcastle adapter. | P11a plus relevant P05 agent/execution tools. Prove progress, cancellation, retained work, permission enforcement and matched task evaluation. P03 applies only to hosted execution. |
| **P11c — marketplace** | Hosted catalog, provenance/review policy, discovery and reviewed updates. | P11a and the chosen registry operator/review keys. Prove pinned updates, staleness and offline operation. |
| **P11d — conversational scaffolding** | A new-project conversation chooses a scaffold and components, then presents a concrete plan. | P11a and a defined conversation/output contract; builds on [P19](p19-project-creation.md), which already covers compare → research → proposal → reviewed creation. Prove generated project and selected attachments with normal ownership/permission checks. |

P10's rules/readiness metadata is reused as available; completing all governance
or P09 maintenance is not required to import or evaluate a local workflow. Each
milestone's acceptance is separate, and the P11 umbrella closes after all four.

1. **Inspect and classify imports.** Accept a repository URL, local source or
   catalog entry. Resolve a release or commit, inspect its license and supported
   interfaces, and list importable components. Show provenance, version,
   dependencies, required tools, permissions and supported engines/runners.
   Keep unknown content visible as unsupported until it has a wiring or execution
   contract. Inspection does not run upstream installers or hooks.
2. **Manage bundles and components.** Define a versioned bundle manifest that
   references component IDs, pinned artifacts, required/optional dependencies,
   engine requirements and workflow steps. Support adding a whole bundle or a
   selection, project/task activation, disabling, removal, reviewed updates and
   a separately identified user-customised variant. Pin executions to a resolved
   configuration so later catalog changes cannot alter an active run.
3. **Evaluate practices before recommending them.** Compare the project's normal
   workflow with a candidate on comparable tasks from the same source baseline.
   Record correctness against acceptance checks, review findings, time, reported
   usage/cost and user interventions. Include setup overhead and repeat meaningful
   comparisons; label unavailable metrics and uncertainty. Offer recommendations
   by task/project type with evidence. Popularity or one successful run does not
   establish an improvement.
4. **Prove a Sandcastle adapter.** Pin and inspect the upstream release before
   implementing against its documented API. Map a PSM task, selected agents,
   isolated worktree/sandbox and chosen steps into execution; stream progress,
   forward cancellation and collect branches, diffs, tests and session references.
   Prove plan/implement/test/review on a disposable repository first. Configure
   branch handling, mounts, network, credentials and hooks explicitly within PSM's
   access policy. Return changes for the normal review/merge/release path. Verify
   each supported engine and runner rather than inheriting a broad compatibility
   claim from upstream.
5. **Extend to other workflows and harnesses.** Publish reusable adapter contracts
   and evaluated templates. Integrate discovery and updates with P11's marketplace
   work once registry ownership and review policy are resolved. Local imports and
   the first adapter can proceed independently of a hosted marketplace.

## UI and component lifecycle

Add a **Workflows** area alongside the existing capability management. Import
shows a preview with **Add whole bundle** and **Choose components**. The bundle
detail lists skills, capabilities, steps and harness, each with its source,
version, dependencies and readiness. Project and task controls show the selected
workflow, engine, runner, required access and configuration changes.

During a run, show the current step, agent progress, checks, changes, usage when
reported and cancellation. Afterwards, show reviewable output and evaluation
results. Distinguish installed, enabled, ready, running, completed and failed;
installing a skill does not prove that the agent used it.

Removal and updates must have predictable ownership:

- Remove a bundle's references and generated files while retaining components
  still required by another bundle or attached directly by the user.
- Removing a required component previews which workflows become unavailable.
  Offer removal of dependents or leave them visibly blocked; never silently
  execute a different workflow. Optional components and steps can be disabled
  where the workflow declares that configuration valid.
- Preserve user edits and report conflicts through the existing ownership ledger.
  Disabling prevents new use; removal does not erase task output or audit history.
  An active run keeps its pinned configuration until completed or explicitly
  cancelled; uninstall must not remove runtime files still in use.
- Preview upstream updates and changed dependencies, permissions and files.
  Preserve customised variants and allow return to the previous configuration.
- Expose independently configurable harness features. Internal implementation
  functions are not individually removable merely because they exist in its source.

## Acceptance

- Import a bundle containing a skill, a capability and a workflow; select only
  supported parts and attach them to a project. Show unsupported parts clearly.
- Add two bundles sharing a skill, remove one, then remove the remaining bundle.
  A direct user attachment survives both removals. Hand-edited files are preserved.
- Remove a required testing capability and see its dependent workflow blocked;
  remove an optional step and run the resulting valid configuration.
- Execute the pinned Sandcastle prototype through PSM, observe live steps,
  cancel a run and retain recoverable work. Complete a separate run and review its
  changes and checks through PSM. Demonstrate that hooks, mounts and credentials
  cannot exceed the selected access policy and that branch output is not merged
  or deployed outside the normal authority checks.
- Compare a candidate workflow with the baseline on representative tasks and
  record benefits, regressions and missing metrics. A recommendation links to that
  evidence rather than presenting a universal "best engineer" workflow.

## Sandcastle reference

[Sandcastle's documentation](https://github.com/mattpocock/sandcastle) describes
programmatic sandboxed agent runs, worktree/branch management and sequences such
as implementation, verification and review. It is a candidate harness adapter;
PSM must separately assess any reusable skills or templates found in its source.
Recheck the pinned upstream API and execution defaults during implementation.
