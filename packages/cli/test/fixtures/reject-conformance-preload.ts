import { plugin } from 'bun';

plugin({
  name: 'reject-eager-conformance-query',
  setup(build) {
    build.onLoad({ filter: /conformance\/\.generated\/can-i-use\.ts$/ }, () => {
      throw new Error('eager conformance query import');
    });
  },
});
