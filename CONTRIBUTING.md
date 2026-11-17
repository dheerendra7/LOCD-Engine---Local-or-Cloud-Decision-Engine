# Contributing

Keep changes small, testable and explainable.

Before opening a PR:

    npm test
    npm run lint

Decision-engine changes should include regression tests for both eligible and rejected candidates. Avoid silently changing policy semantics; document behavioral changes.

Recommended commits:
- feat(engine): ...
- fix(policy): ...
- test(engine): ...
- docs(architecture): ...
