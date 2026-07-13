// supabase/functions/execute-order/index.ts
// Exécute un ordre RÉEL sur Binance ou Coinbase, UNIQUEMENT après validation manuelle
// depuis le dashboard (le front envoie { signal_id }, jamais de clé, jamais de montant libre).
//
// Sécurité :
// - Clés API lues depuis les secrets Supabase (jamais transmises par le client)
// - Vérifie que le signal existe, est encore 'pending' et non expiré avant d'exécuter
// - USE_TESTNET=true par défaut tant que tu n'as pas explicitement basculé en prod
// - Les clés API doivent être scopées "Enable Reading" + "Enable Spot Trading" UNIQUEMENT
//   → ne JAMAIS activer "Enable Withdrawals" sur les clés utilisées ici.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const USE_TESTNET = (Deno.env.get('USE_TESTNET') ?? 'true') === 'true';

const BINANCE_API_KEY = Deno.env.get('BINANCE_API_KEY') ?? '';
const BINANCE_API_SECRET = Deno.env.get('BINANCE_API_SECRET') ?? '';
const COINBASE_API_KEY = Deno.env.get('COINBASE_API_KEY') ?? '';
const COINBASE_API_SECRET = Deno.env.get('COINBASE_API_SECRET') ?? '';

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function executeBinanceOrder(side: 'BUY' | 'SELL', symbol: string, usdAmount: number) {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    throw new Error('Clés Binance non configurées (secrets BINANCE_API_KEY / BINANCE_API_SECRET manquants)');
  }
  const base = USE_TESTNET ? 'https://testnet.binance.vision' : 'https://api.binance.com';
  const timestamp = Date.now();
  // quoteOrderQty = montant en USDT, Binance calcule la quantité BTC lui-même
  const params = new URLSearchParams({
    symbol,
    side,
    type: 'MARKET',
    quoteOrderQty: usdAmount.toFixed(2),
    timestamp: timestamp.toString(),
  });
  const signature = await hmacSha256Hex(BINANCE_API_SECRET, params.toString());
  params.append('signature', signature);

  const res = await fetch(`${base}/api/v3/order?${params.toString()}`, {
    method: 'POST',
    headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Binance error: ${JSON.stringify(data)}`);
  return data;
}

async function executeCoinbaseOrder(side: 'BUY' | 'SELL', productId: string, usdAmount: number) {
  if (!COINBASE_API_KEY || !COINBASE_API_SECRET) {
    throw new Error('Clés Coinbase non configurées (secrets COINBASE_API_KEY / COINBASE_API_SECRET manquants)');
  }
  // Coinbase Advanced Trade API — nécessite une clé API "Cloud API Key" (JWT) en production.
  // Implémentation simplifiée : à adapter selon le format de clé exact fourni par Coinbase
  // (voir README section Coinbase pour le détail de la génération du JWT).
  throw new Error(
    "Exécution Coinbase non finalisée — Coinbase Advanced Trade API nécessite une signature JWT " +
    "(clé Cloud API), différente du HMAC classique. Voir README.md section 'Finaliser Coinbase' " +
    "avant d'activer ce chemin en production."
  );
}

async function computeRealizedPnl(
  supabase: ReturnType<typeof createClient>,
  exchange: string,
  side: 'BUY' | 'SELL',
  btcAmount: number,
  execPrice: number,
): Promise<number | null> {
  if (side === 'BUY') return null; // le P&L ne se réalise qu'à la vente

  // Coût moyen pondéré des achats passés (FIFO simplifié en moyenne pondérée globale)
  const { data: buys } = await supabase
    .from('executions')
    .select('btc_amount, price')
    .eq('exchange', exchange)
    .eq('side', 'BUY')
    .eq('status', 'filled')
    .not('btc_amount', 'is', null);

  if (!buys || buys.length === 0) return null; // pas d'historique d'achat, impossible de calculer un coût de revient

  const totalBtc = buys.reduce((sum: number, b: { btc_amount: number }) => sum + b.btc_amount, 0);
  const totalCost = buys.reduce((sum: number, b: { btc_amount: number; price: number }) => sum + b.btc_amount * b.price, 0);
  const avgCostBasis = totalBtc > 0 ? totalCost / totalBtc : execPrice;

  return Math.round((execPrice - avgCostBasis) * btcAmount * 100) / 100;
}

Deno.serve(async (req) => {
  try {
    const { signal_id, auto = false } = await req.json();
    if (!signal_id) {
      return new Response(JSON.stringify({ error: 'signal_id requis' }), { status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: signal, error: fetchError } = await supabase
      .from('signals')
      .select('*')
      .eq('id', signal_id)
      .single();

    if (fetchError || !signal) {
      return new Response(JSON.stringify({ error: 'Signal introuvable' }), { status: 404 });
    }
    if (signal.status !== 'pending') {
      return new Response(JSON.stringify({ error: `Signal déjà traité (status: ${signal.status})` }), { status: 409 });
    }
    if (new Date(signal.expires_at) < new Date()) {
      await supabase.from('signals').update({ status: 'expired' }).eq('id', signal_id);
      return new Response(JSON.stringify({ error: 'Signal expiré, régénère un signal frais' }), { status: 410 });
    }

    let executionResult;
    let orderId: string | null = null;
    let execStatus: 'filled' | 'failed' = 'filled';
    let errorMessage: string | null = null;
    let execPrice: number | null = null;
    let btcAmount: number | null = null;

    try {
      if (signal.exchange === 'binance') {
        executionResult = await executeBinanceOrder(signal.action, signal.symbol, signal.suggested_amount);
        orderId = String(executionResult.orderId);
        btcAmount = parseFloat(executionResult.executedQty);
        const quoteQty = parseFloat(executionResult.cummulativeQuoteQty ?? '0');
        execPrice = btcAmount > 0 ? quoteQty / btcAmount : null;
      } else {
        executionResult = await executeCoinbaseOrder(signal.action, signal.symbol, signal.suggested_amount);
        orderId = executionResult.order_id;
      }
    } catch (execErr) {
      execStatus = 'failed';
      errorMessage = String(execErr);
    }

    const realizedPnl = execStatus === 'filled' && btcAmount && execPrice
      ? await computeRealizedPnl(supabase, signal.exchange, signal.action, btcAmount, execPrice)
      : null;

    const { data: execution, error: insertError } = await supabase
      .from('executions')
      .insert({
        signal_id: signal.id,
        exchange: signal.exchange,
        symbol: signal.symbol,
        side: signal.action,
        amount: signal.suggested_amount,
        price: execPrice,
        btc_amount: btcAmount,
        realized_pnl_usd: realizedPnl,
        exchange_order_id: orderId,
        status: execStatus,
        error_message: errorMessage,
        auto_executed: auto,
      })
      .select()
      .single();
    if (insertError) throw insertError;

    await supabase
      .from('signals')
      .update({ status: execStatus === 'filled' ? 'validated' : 'rejected' })
      .eq('id', signal_id);

    return new Response(JSON.stringify({ execution, raw: executionResult ?? null }), {
      status: execStatus === 'filled' ? 200 : 502,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
