# The mock tests

These tests are about the mock Technitium server, not about the dashboard.
They assert that the mock answers the way a real Technitium server answers,
so that a test in `backend/tests/` can trust what it is told.

| Test file | Covers |
| --- | --- |
| `technitium-mock.test.js` | `../helpers/technitium-mock.js` |
| `technitium-data-gen.test.js` | `../helpers/technitium-data-gen.js` |
| `technitium-cluster-mock.test.js` | `../helpers/technitium-cluster-mock.js` |

Run them on their own:

```sh
npm run test:mock
```

A test that says something about the dashboard belongs in `backend/tests/`,
even when it uses the mock to stand in for a Technitium server.
