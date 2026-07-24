import { NextResponse } from 'next/server';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const DEFAULT_PROJECT_ID = 'demo-nextjs-app';

function getAdminApp() {
  const activeApps = getApps();
  if (activeApps.length > 0) {
    return activeApps[0];
  }
  return initializeApp({ projectId: DEFAULT_PROJECT_ID });
}

function resolveRuntimeEnvironment(): string {
  if (process.env.PYRIC_SANDBOX !== undefined) {
    return 'pyric-sandbox';
  }
  return 'production';
}

export async function GET(): Promise<NextResponse> {
  const app = getAdminApp();
  const db = getFirestore(app);
  
  try {
    const postsSnapshot = await db.collection('posts').get();
    const documentCount = postsSnapshot.size;
    const runtimeTarget = resolveRuntimeEnvironment();

    return NextResponse.json({
      status: 'ok',
      environment: runtimeTarget,
      count: documentCount,
    });
  } catch (error) {
    const errCode = (error as { code?: string }).code;
    const errMessage = errCode !== undefined ? errCode : String(error);
    return NextResponse.json(
      { status: 'error', details: errMessage },
      { status: 500 },
    );
  }
}
