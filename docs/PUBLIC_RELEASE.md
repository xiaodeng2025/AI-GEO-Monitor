# Public release preparation

This repository is prepared as source material for a new public GitHub repository. The public repository should be created from audited current files and should begin with a clean history; the existing development and research history is not part of the public release.

Recommended public repository conventions:

- default branch: `main`;
- first frozen release tag: `phase-b-four-platform-extension-frozen`;
- project license: MPL-2.0, as provided in the root `LICENSE` file;
- keep only audited source, tests, freeze conclusions, and research notes that contain no local paths, account state, private content, or exported artifacts.

The current checkout has no GitHub remote and has not been pushed. Creating a repository, configuring a remote, creating a tag, and pushing are separate release actions and are intentionally outside this preparation step.

Research evidence should be preserved. Material that contains browser profiles, Cookies, local databases, real conversations, raw Snapshots, private screenshots, debug dumps, or machine-specific state belongs in private archival storage rather than the public repository.
