import { CLIENT, row } from './section.ts';

export default row({
  order: 200,
  kind: 'observed',
  api: 'httpsCallable(functions, name, { limitedUseAppCheckTokens: true })',
  behavior:
    'With limitedUseAppCheckTokens: true each call sends a fresh limited-use App Check token, so a consuming callable reports alreadyConsumed: false on every call. Without it the cached token is sent again and the second call reports true. With no App Check initialized no X-Firebase-AppCheck header is sent.',
  evidence: `upstream: \`ContextProvider.getAppCheckToken\` calls \`getLimitedUseToken\` or \`getToken\`, and \`makeAuthHeaders\` omits the header when the token is null (${CLIENT}). Production behavior needs \`functions-callable-client-limited-use\`.`,
});
