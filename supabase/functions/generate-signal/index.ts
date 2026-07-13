// supabase/functions/generate-signal/index.ts
// Lit l'historique de prix, calcule RSI/MACD/SMA, génère une proposition d'ordre
// (status='pending') que Bruno devra valider manuellement dans le dashboard.
// À appeler périodiquement (ex: toutes les 15-30 min) via Supabase Cron ou Make.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Montant max par ordre proposé, en USD — sécurité pour éviter qu'un signal ne propose
// un montant démesuré. Configurable via secret Supabase.
const MAX_ORDER_USD = parseFloat(Deno.env.get('MAX_ORDER_USD') ?? '100');

function sma(prices: number[], period: number): (number | null)[] {
  return prices.map((_, i) => {
    if (i < period - 1) return null;
    const slice = prices.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

function ema(prices: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (prev === null) {
      prev = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
      out.push(prev);
      continue;
    }
    prev = prices[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(prices: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(prices.length).fill(null);
  if (prices.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0, loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macd(prices: number[]) {
  const fast = ema(prices, 12);
  const slow = ema(prices, 26);
  const macdLine = prices.map((_, i) => (fast[i] !== null && slow[i] !== null ? (fast[i]! - slow[i]!) : null));
  const firstValid = macdLine.findIndex((v) => v !== null);
  const validMacd = macdLine.slice(firstValid) as number[];
  const signalOnValid = ema(validMacd, 9);
  const signalLine: (number | null)[] = new Array(firstValid).fill(null).concat(signalOnValid);
  const histogram = macdLine.map((v, i) => (v !== null && signalLine[i] !== null ? v - signalLine[i]! : null));
  return { macdLine, signalLine, histogram };
}

function buildSignal(prices: number[]) {
  const smaShort = sma(prices, 20);
  const smaLong = sma(prices, 50);
  const rsiArr = rsi(prices, 14);
  const { macdLine, signalLine, histogram } = macd(prices);
  const i = prices.length - 1;
  const reasons: string[] = [];
  const votes: string[] = [];

  if (smaShort[i] !== null && smaLong[i] !== null) {
    if (smaShort[i]! > smaLong[i]!) { votes.push('BUY'); reasons.push('SMA20 > SMA50 (tendance haussière)'); }
    else { votes.push('SELL'); reasons.push('SMA20 < SMA50 (tendance baissière)'); }
  }
  if (rsiArr[i] !== null) {
    if (rsiArr[i]! < 30) { votes.push('BUY'); reasons.push(`RSI ${rsiArr[i]!.toFixed(1)} (survente)`); }
    else if (rsiArr[i]! > 70) { votes.push('SELL'); reasons.push(`RSI ${rsiArr[i]!.toFixed(1)} (surachat)`); }
    else votes.push('HOLD');
  }
  if (macdLine[i] !== null && signalLine[i] !== null) {
    if (macdLine[i]! > signalLine[i]! && histogram[i]! > 0) { votes.push('BUY'); reasons.push('MACD > signal'); }
    else if (macdLine[i]! < signalLine[i]! && histogram[i]! < 0) { votes.push('SELL'); reasons.push('MACD < signal'); }
    else votes.push('HOLD');
  }

  const buyVotes = votes.filter((v) => v === 'BUY').length;
  const sellVotes = votes.filter((v) => v === 'SELL').length;
  const total = votes.length || 1;
  let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let confidence = 0;
  if (buyVotes > sellVotes) { action = 'BUY'; confidence = buyVotes / total; }
  else if (sellVotes > buyVotes) { action = 'SELL'; confidence = sellVotes / total; }

  return {
    action,
    confidence,
    reasons,
    indicators: {
      price: prices[i],
      smaShort: smaShort[i],
      smaLong: smaLong[i],
      rsi: rsiArr[i],
      macd: macdLine[i],
      macdSignal: signalLine[i],
      macdHistogram: histogram[i],
    },
  };
}

async function maybeAutoExecute(
  supabase: ReturnType<typeof createClient>,
  signal: { id: string; confidence: number },
) {
  const { data: settings } = await supabase
    .from('bot_settings')
    .select('*')
    .eq('id', 1)
    .single();

  if (!settings || !settings.auto_mode_enabled) return { autoExecuted: false };
  if (signal.confidence < settings.auto_mode_threshold) return { autoExecuted: false };

  // Plafond quotidien : compte les exécutions auto des dernières 24h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('executions')
    .select('id', { count: 'exact', head: true })
    .eq('auto_executed', true)
    .gte('created_at', since);

  if ((count ?? 0) >= settings.max_auto_trades_per_day) {
    return { autoExecuted: false, reason: 'daily_cap_reached' };
  }

  // Appelle execute-order, qui contient toute la logique de signature/exécution réelle
  const res = await fetch(`${SUPABASE_URL}/functions/v1/execute-order`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ signal_id: signal.id, auto: true }),
  });
  const result = await res.json();
  return { autoExecuted: res.ok, result };
}

Deno.serve(async (req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const results = [];

    for (const exchange of ['binance', 'coinbase']) {
      const { data, error } = await supabase
        .from('price_history')
        .select('price, recorded_at')
        .eq('exchange', exchange)
        .order('recorded_at', { ascending: true })
        .limit(200);

      if (error || !data || data.length < 55) {
        results.push({ exchange, skipped: true, reason: 'Historique insuffisant (min 55 points)' });
        continue;
      }

      const prices = data.map((d: { price: number }) => d.price);
      const signal = buildSignal(prices);

      // Ne crée un signal en base que si action != HOLD (évite le bruit)
      if (signal.action === 'HOLD') {
        results.push({ exchange, action: 'HOLD', skipped: true });
        continue;
      }

      const suggestedAmount = Math.round(MAX_ORDER_USD * signal.confidence * 100) / 100;

      const { data: inserted, error: insertError } = await supabase
        .from('signals')
        .insert({
          exchange,
          symbol: exchange === 'binance' ? 'BTCUSDT' : 'BTC-USD',
          action: signal.action,
          confidence: signal.confidence,
          reasons: signal.reasons,
          indicators: signal.indicators,
          suggested_amount: suggestedAmount,
        })
        .select()
        .single();

      if (insertError) throw insertError;

      const autoResult = await maybeAutoExecute(supabase, inserted);
      results.push({ ...inserted, auto: autoResult });
    }

    return new Response(JSON.stringify({ signals: results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
