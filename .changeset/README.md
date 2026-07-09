# Changesets

Add a changeset to each pull request that changes user-visible behavior:

```bash
pnpm changeset
```

Choose `honeybot`, select the semantic-version bump, and write a concise changelog entry. Commit the generated Markdown file with the change. Documentation, tests, refactors, and other changes that do not affect users do not need a changeset.

After changesets reach `main`, the release workflow creates or updates a release pull request. Merging that pull request updates `package.json` and `CHANGELOG.md`; the existing container workflow then publishes images using the new package version.
