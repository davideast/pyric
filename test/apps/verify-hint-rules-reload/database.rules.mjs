import { allow, defineRtdbRules, deny } from 'pyric/rules';

export default defineRtdbRules({
  paths: {
    '/items': { read: allow(), write: deny() },
  },
});
