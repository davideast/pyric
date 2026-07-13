export const PLAYGROUND_PROJECT_ID = 'digame-mas';
export const INFERENCE_FUNCTION_ID = 'inferenceApi';
export const INFERENCE_FUNCTION_REGION = 'us-central1';

export interface DeployStep {
  kind: 'deploy' | 'discover-endpoint';
  args: string[];
}

export function createDeployPlan(projectId: string): readonly DeployStep[] {
  const common = ['--config', 'firebase.json', '--project', projectId] as const;
  return [
    {
      kind: 'deploy',
      args: [
        'deploy',
        ...common,
        '--only',
        `functions:${INFERENCE_FUNCTION_ID}`,
        '--non-interactive',
      ],
    },
    {
      kind: 'discover-endpoint',
      args: ['functions:list', ...common, '--json', '--non-interactive'],
    },
    {
      kind: 'deploy',
      args: ['deploy', ...common, '--only', 'hosting', '--non-interactive'],
    },
  ];
}

export function functionEndpointUrl(output: unknown): string {
  if (typeof output !== 'object' || output === null) {
    throw new Error('firebase-tools returned invalid function metadata');
  }
  const response = output as { status?: unknown; result?: unknown };
  if (response.status !== 'success') {
    throw new Error('firebase-tools failed to list deployed functions');
  }
  const result = response.result;
  if (!Array.isArray(result)) {
    throw new Error('firebase-tools returned invalid function metadata');
  }
  const match = result.find((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const fn = candidate as { id?: unknown; region?: unknown };
    return fn.id === INFERENCE_FUNCTION_ID && fn.region === INFERENCE_FUNCTION_REGION;
  }) as { uri?: unknown } | undefined;
  if (typeof match?.uri !== 'string' || !match.uri.startsWith('https://')) {
    throw new Error(
      `firebase-tools did not return an HTTPS endpoint for ${INFERENCE_FUNCTION_ID}`,
    );
  }
  return match.uri;
}
