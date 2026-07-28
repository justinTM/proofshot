---
title: Portable review bundle storage evaluation
status: source-controlled evaluation
---

# Portable review bundle storage evaluation

This evaluation compares storage transports for compiled ProofShot review bundles. Storage is a distribution layer, never proof truth: semantic status comes from the validated, content-addressed manifest and its exact evidence bytes.

| Option | Immutable identity | Access control | Expiry and retention | Portability |
| --- | --- | --- | --- | --- |
| [GitLab CI job artifacts](https://docs.gitlab.com/ci/jobs/job_artifacts/) | Pipeline ID, job ID, source revision, and archive digest can identify a handoff; mutable job names and “latest successful” convenience URLs are not identities. The bundle digest remains authoritative. | `artifacts:access` and project/pipeline visibility bound downloads. Reviewers need artifact access; HTML preview for private/internal projects also depends on Pages access control. | `expire_in` and the instance default are native bounded-retention controls. “Keep” and the keep-latest-successful setting change effective retention and must be recorded explicitly. | Downloadable archive and browsable files are portable while retained. Expiring links are not durable proof truth. |
| [GitLab generic package registry](https://docs.gitlab.com/user/packages/generic_packages/) | Package name, unique version, file name, and GitLab-calculated SHA-256 provide a stable distribution identity only when duplicate package/file publishing is disabled. Duplicate name/version uploads are allowed by default. | Project package visibility and PAT/project/deploy/job-token scopes control reads and writes. Least-privilege reviewer access remains required. | Retention is policy-driven rather than naturally job-bounded; a package cleanup policy and explicit `retainUntil` metadata are required. | Direct file download supports portable archives and longer-lived cross-pipeline review. |
| [GitLab release assets](https://docs.gitlab.com/user/project/releases/release_fields/) | A release/tag and permanent asset path identify a publication pointer, not necessarily immutable bytes; the linked object digest remains required. | Project/release visibility controls access. Private release assets require authenticated access. | Usually long-lived and poorly matched to ephemeral review evidence. GitLab explicitly recommends package-backed assets over direct job-artifact links because job artifacts can expire or be deleted. | Good for intentionally published, versioned deliverables; excessive for routine task review. |

## Bounded recommendation

Use GitLab CI artifacts by default for short-lived, access-controlled review handoff, with exact pipeline/job identity, archive digest, ACL scope, and expiry recorded in the bundle. Use a versioned generic package only when the reviewed retention period must outlive CI artifact expiry or the bundle must be consumed across pipelines. Reserve release assets for intentionally published release evidence.

Before treating a generic package version as immutable, disable duplicate generic package/file publishing for the namespace and verify that setting at upload time. Before relying on CI expiry, record whether “keep latest successful artifacts” is enabled; otherwise an apparently short `expire_in` can be retained longer than the bundle declares.

This recommendation does not implement merge-request posting, hosting, deployment, or acceptance. It keeps compact-comment work linked to [GitHub PR #43](https://github.com/AmElmo/proofshot/pull/43) and upstream portability work linked to [issue #22](https://github.com/AmElmo/proofshot/issues/22) rather than duplicating either scope.
