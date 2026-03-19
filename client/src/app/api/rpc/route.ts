import { NextRequest, NextResponse } from 'next/server';

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'http://localhost:8899';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { method, params } = body;

    const rpcBody: any = {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: params || [],
    };

    // Map our simplified methods to actual JSON-RPC methods
    if (method === 'getAccountInfo') {
      rpcBody.params = [params[0], { encoding: 'base64', commitment: 'confirmed' }];
    } else if (method === 'getBalance') {
      rpcBody.params = [params[0], { commitment: 'confirmed' }];
    } else if (method === 'getLatestBlockhash') {
      rpcBody.params = [{ commitment: 'confirmed' }];
    } else if (method === 'sendRawTransaction') {
      rpcBody.params = [params[0], { skipPreflight: true, preflightCommitment: 'confirmed' }];
    } else if (method === 'getMultipleAccountsInfo') {
      rpcBody.method = 'getMultipleAccounts';
      rpcBody.params = [params[0], { encoding: 'base64', commitment: 'confirmed' }];
    }

    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpcBody),
    });

    const data = await res.json();

    if (data.error) {
      return NextResponse.json({ error: data.error.message || 'RPC error' });
    }

    // Normalize response
    if (method === 'getAccountInfo') {
      const val = data.result?.value;
      if (!val) return NextResponse.json({ result: null });
      return NextResponse.json({
        result: {
          data: val.data[0], // base64 string
          executable: val.executable,
          lamports: val.lamports,
          owner: val.owner,
          rentEpoch: val.rentEpoch,
        },
      });
    } else if (method === 'getBalance') {
      return NextResponse.json({ result: data.result?.value ?? 0 });
    } else if (method === 'getLatestBlockhash') {
      return NextResponse.json({ result: data.result?.value });
    } else if (method === 'sendRawTransaction') {
      return NextResponse.json({ result: data.result });
    } else if (method === 'getMultipleAccountsInfo') {
      const vals = data.result?.value || [];
      return NextResponse.json({
        result: vals.map((v: any) =>
          v ? { data: v.data[0], executable: v.executable, lamports: v.lamports, owner: v.owner, rentEpoch: v.rentEpoch } : null
        ),
      });
    }

    return NextResponse.json({ result: data.result });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'RPC proxy error' }, { status: 500 });
  }
}
