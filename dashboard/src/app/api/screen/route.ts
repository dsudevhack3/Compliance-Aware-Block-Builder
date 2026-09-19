import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const engineUrl = process.env.ENGINE_URL
      ? process.env.ENGINE_URL.endsWith('/screen')
        ? process.env.ENGINE_URL
        : `${process.env.ENGINE_URL.replace(/\/$/, '')}/screen`
      : 'http://127.0.0.1:3001/screen';

    const engineApiKey = process.env.ENGINE_API_KEY || 'dev-engine-secret-2026';

    const engineResp = await fetch(engineUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-engine-api-key': engineApiKey,
      },
      body: JSON.stringify(body),
    });

    const data = await engineResp.json();
    return NextResponse.json(data, { status: engineResp.status });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown proxy error';
    return NextResponse.json(
      { error: `Failed to proxy screening request to engine: ${errorMsg}` },
      { status: 500 }
    );
  }
}
