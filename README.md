# CV Online Presenter Content

This public repository contains generic Markdown page templates and clearly labeled synthetic examples for the [`cv-online-presenter`](https://github.com/fredrik-hellmangroup/cv-online-presenter) app. It contains no real profile facts or contact details.

The app links to a specific commit of this repository as the `content` Git submodule. That Git commit is the content revision used for a build and can be restored together with the app commit.

## Requirements and validation

- Node.js 24 and npm

```powershell
npm ci
npm run validate
```

The independent content CI runs on pull requests and pushes to `main`. It validates Markdown front matter, supported locales, publication status, required fields, internal links, URL schemes, npm advisories, and likely secrets.

## Editing content

Copy a page template, set its `status` to `draft` while editing, and add a locale only when a complete translation is approved. Keep personal facts, contact details, links, and images out of the template until their owner approves them. Synthetic examples are draft-only and must remain clearly labeled.

MIT licensed. See [LICENSE](./LICENSE).
