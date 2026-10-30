# CV Online Presenter Content

This public repository contains owner-approved CV facts for the [`cv-online-presenter`](https://github.com/fredrik-hellmangroup/cv-online-presenter) app. It does not publish additional contact details or external profile links. The synthetic example remains clearly labeled and draft-only.

The app links to a specific commit of this repository as the `content` Git submodule. That Git commit is the content revision used for a build and can be restored together with the app commit.

## Requirements and validation

- Node.js 24 and npm

```powershell
npm ci
npm run validate
```

The independent content CI runs on pull requests and pushes to `main`. It validates Markdown front matter, supported locales, publication status, required fields, internal links, URL schemes, npm advisories, and likely secrets.

## Editing content

Set new pages to `draft` while editing, and add a locale only when a complete translation is approved. The owner approved facts in the current CV (decision OQ-04), but contact details, links and images require separate approval. Every published factual page records its source in front matter; the mapping and source digest are in [PROVENANCE.md](./PROVENANCE.md). Synthetic examples are draft-only and must remain clearly labeled.

MIT licensed. See [LICENSE](./LICENSE).
