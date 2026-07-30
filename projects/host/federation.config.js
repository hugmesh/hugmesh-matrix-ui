// Dev-only HOST shell config. This `projects/host` app exists purely so the
// Matrix remote is browsable standalone during development; in production the
// hugmesh.systems host federates `./routes` directly. It exposes NOTHING
// (it's a consumer, not a provider) — only the shared-deps surface + skip list,
// both centralised in the repo-root ./federation-base.js so the federation
// contract lands in ONE place across this host and the Matrix remote.
const { hugmeshHost } = require('../../federation-base');

module.exports = hugmeshHost({ name: 'hugmesh-host' });
