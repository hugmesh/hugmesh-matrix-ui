// Federation config for the Matrix remote bundle.
//
// The shared-deps surface (shareAll singletons + strictVersion) and the RxJS
// skip list now live in the repo-root ./federation-base.js so the federation
// contract lands in ONE place across the host shell and every remote authored
// here — mirrors hugmesh.systems / hugmesh.games. A drift between host
// and remote (e.g. one bundle sharing a different RxJS subpath) can't quietly
// produce a "shared is not a function" runtime failure.
//
// `name` and the exposed `./routes` key are the federation contract the
// hugmesh.systems host consumes via
// loadRemoteModule({ remoteName: 'matrix', exposedModule: './routes' }) and
// MUST stay unchanged or the host stops mounting this remote at /social/matrix.
const { hugmeshRemote } = require('../../federation-base');

module.exports = hugmeshRemote({
  name: 'matrix',
  exposes: {
    './routes': './projects/matrix/src/app/matrix.routes.ts',
  },
});
