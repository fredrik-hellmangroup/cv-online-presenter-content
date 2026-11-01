# CV Online Presenter Content

Owner-approved CV facts for the [`cv-online-presenter`](https://github.com/fredrik-hellmangroup/cv-online-presenter) app. This repository is **private**. The canonical CV is `content/sources/master-cv.md` (approved under OQ-04). Do not add contact details, images or external profile links without separate approval. The synthetic example stays clearly labeled and draft-only.

The app does not pin this repository. Each merge to `main` that changes `content/pages/**` or `content/site.json` is deployed as a named content release (`<UTC date>-<sha>`) to IIS by the `Deploy content` workflow and activated at runtime. The public app repository holds only a synthetic template of the same layout.

## Edit-to-website flow

```mermaid
flowchart LR
    A["Edit source or source-map.json<br/>in a PR"] --> B["CI validates<br/>structure, links, audit, secrets"]
    B --> C["Merge to main"]
    C --> D["Generator opens PR<br/>automation/generated-content"]
    D --> E["Review generated diff"]
    E --> F["Merge labeled PR"]
    F --> G["Deploy content: validate, Web Deploy,<br/>preview, activate"]
    G --> H(["Live site"])
```

Release folders are immutable. Rollback activates an earlier release id.

## Local commands

Requires Node.js 24 and npm.

```powershell
npm ci
npm run validate
```

Before pushing generator changes, also run `npm run generate:validate-source`, `npm test` and `npm run generate:check`.

## Source ownership and generated pages

Edit the canonical source or `content/source-map.json`. Never hand-edit generated pages; change the source and regenerate. The generator writes a fixed allowlist of seven pages: `cv.md`, `home.md`, `services.md`, `projects.md`, and the Asira, Nordhem and Stockholmsmässan project pages. It never reads or generates `profile.md` or the contact/demo page. See [PROVENANCE.md](./PROVENANCE.md) for the section mapping and hashes.

Generation is fail-closed and journaled:

- `--write` and `--check` take an exclusive `.cv-generation.lock`. Do not run generation concurrently with another process that changes this workspace.
- Writes are journaled and atomic. A failed write rolls back, and the next `--write` recovers any interrupted transaction.
- Manual edits to generated output make `--check` and `--write` fail rather than be overwritten.

## Closed generated PRs

A stale generated-content PR (output now matches `main`) is commented on, closed, and its stable branch deleted automatically. Automation never reopens it. To resume a closed, unmerged PR, an authorized maintainer reviews it and dispatches `Generate public CV content PR` from `main` with `reopen_closed=true`. Without that input the PR stays closed.

## GitHub setup

Add the `generated-content` label before enabling automation.

| Environment | Secrets | GitHub App permissions | Restriction |
| --- | --- | --- | --- |
| `content-writer` | `CONTENT_WRITER_APP_ID`, `CONTENT_WRITER_APP_PRIVATE_KEY` | `contents: write`, `pull_requests: write`, installed only on this repository | `main` only; generator job only |
| `production-content` | Secrets `DEPLOY_PASSWORD`, `CONTENT_ACTIVATION_TOKEN`; variables `MSDEPLOY_SERVER_URL`, `MSDEPLOY_SITE_NAME`, `MSDEPLOY_CERTIFICATE_SHA256`, `DEPLOY_USERNAME`, `MSDEPLOY_CONTENT_RELEASES_PATH`, `CONTENT_ACTIVATION_URL`, `APP_REPO_REF` | None (Web Deploy credentials and activation token only) | `main` only; `Deploy content` workflow |

Principles:

- Keep `GITHUB_TOKEN` read-only. Grant write access only through the App token above.
- Do not use `pull_request_target`, and never expose writer or deploy credentials to pull-request jobs.
- Protect `main` with required checks. The content-writer App writes only the stable generated branch and never pushes to `main`.
- This repository is **private**. It holds the personal CV, so keep it private and never copy its content into the public app repository.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Source or map validation fails | Fix the source headings or mapping metadata, then rerun the content PR checks. `--validate-source` checks only source and mapping. |
| Bootstrap hash mismatch | Stop. Verify the baseline pages and mapping. Do not replace hashes to force a write. |
| Generated-output conflict | Regenerate from the canonical source and mapping. Do not edit generated pages. `--write` refuses to overwrite manual edits. |
| Stale `.cv-generation.lock` | Confirm that no generation process is running, delete that exact file, then rerun. The generator never removes a lock automatically. |
| Pending transaction journal | Run `npm run generate:write`. It recovers the interrupted transaction before writing. |
| Generated PR is closed and unmerged | Inspect it. Dispatch with `reopen_closed=true` only if it should resume and output still differs from `main`. |
| `Deploy content` fails at upload | Check the Web Deploy user's write access to the releases folder, the certificate fingerprint and `MSDEPLOY_CONTENT_RELEASES_PATH`. |
| `Deploy content` fails at activate | Check `Content__ReleasesRoot`/`Content__ActivationToken` on the server, that the token matches `CONTENT_ACTIVATION_TOKEN`, and that the app pool can write `active-release.txt`. |

Rollback: run `Deploy content` manually from `main` with `activate_release_id` set to an earlier release id.


MIT licensed. See [LICENSE](./LICENSE).
