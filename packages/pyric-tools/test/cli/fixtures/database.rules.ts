import { allow, defineRtdbRules, deny } from 'pyric/rules';

export default defineRtdbRules({
  paths: {
    '/': { read: allow(), write: deny() },
  },
});
