# Development

## Navigation

- `src/workflows/default.ts`: named delivery steps and the Mastra repair loop.
- `src/delivery/steps.ts`: step behavior and state updates.
- `src/delivery/agent-context.ts`: role-specific context, including QA handoffs.
- `src/delivery/environment.ts`: run/round resource ownership and cleanup.
- `src/delivery/qa-handoff.ts`: pending verification, question resolution, and report merging.
- `src/delivery/qa-policy.ts`: acceptance report and evidence validation.
- `src/delivery/qa-references.ts`: immutable, round-scoped design image snapshots.
- `src/tools/qa-reference.ts`: constrained reference-image access.
- `test/sandbox-qa.test.ts`: handoff rules and sequential workflow regression coverage.
- `test/delivery.integration.test.ts`: actual agent/tool, process, and publication wiring with an offline provider. This proves transport and execution, not real-model instruction following.

## Acceptance QA

The delivery cycle runs checks, browser/mobile QA, sandbox QA when needed, one
optional targeted UI follow-up, final evidence validation, and independent review.
Only the final delivery gate selects approval, repair, or a blocked result.

Browser/mobile QA has no workspace, filesystem, or shell tools. Its context
includes approved requirements, Figma links and handoff summary/limitations,
reference image IDs, configured targets, and current evidence metadata. Canonical
Figma screen PNGs belong directly in `docs/design/`. Before running checks, the
controller snapshots at most 20 regular PNG files, each under 10 MB. Symlinked
directories/files are rejected. `qa_reference` accepts only a catalog ID and
returns the snapshotted image; it cannot read arbitrary paths or URLs. Reference
images never create candidate evidence.

A criterion can contain both an observed defect and untested behavior. Sandbox
QA receives criteria marked blocked **or** containing a blocking criterion-linked
question, including failed criteria. It tests only unresolved portions. A later
pass cannot erase an earlier failure, defect, global question, or scope change.

The controller assigns finding IDs per QA stage. A follow-up report may supply
`resolvedQuestions` entries with a supplied `questionId`, successful current
tester `evidenceIds`, and explanatory `notes`. This removes individual resolved
questions even if another part of the criterion remains blocked. A complete
non-blocked criterion report also supersedes its earlier questions. Original
reports and resolution evidence remain in round history for diagnosis.

If sandbox QA finds a concrete way to complete browser/native visual observation,
it can supply `uiFollowUp` with unresolved `criterionIds` and actionable `notes`.
The registered `ui-follow-up` step starts a fresh, run-owned QA session and sandbox;
it does not reopen a closed session. The constrained tester receives only the
requested criteria, current questions, sandbox notes, and approved reference
images. Each passing follow-up criterion needs fresh browser/device/screenshot
evidence tagged `follow-up`, not earlier UI captures or sandbox-only observations.
A substituted native runtime is not evidence of native appearance. Follow-up
cannot request another follow-up, change source, resolve scope changes, or waive
remaining prerequisites.

The controller checks that the candidate remains unchanged between QA stages and
before approval. All sessions and sandboxes are cleaned up on success, failure,
or cancellation. A failed candidate server remains an implementation defect,
not a reason to escalate indefinitely between testers. Final mixed blocked
reasons separate defects to repair from blocked verification or decisions.
