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

function bollingerBands(prices: number[], period = 20, mult = 2) {
  const middle = sma(prices, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (middle[i] === null) { upper.push(null); lower.push(null); continue; }
    const slice = prices.slice(i - period + 1, i + 1);
    const variance = slice.reduce((sum, p) => sum + (p - middle[i]!) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);
    upper.push(middle[i]! + mult * stdDev);
    lower.push(middle[i]! - mult * stdDev);
  }
  return { middle, upper, lower };
}

function atr(highs: number[], lows: number[], closes: number[], period = 14): (number | null)[] {
  const trueRanges = closes.map((close, i) => {
    if (i === 0) return highs[i] - lows[i];
    return Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  });
  return ema(trueRanges, period);
}

function computeRiskLevels(price: number, atrValue: number | null, action: string, stopMult = 1.5, targetMult = 2.5) {
  if (!atrValue) return { stopLoss: null, takeProfit: null };
  if (action === 'BUY') {
    return { stopLoss: price - atrValue * stopMult, takeProfit: price + atrValue * targetMult };
  }
  return { stopLoss: price + atrValue * stopMult, takeProfit: price - atrValue * targetMult };
}


function buildSignal(prices: number[], highs: number[], lows: number[], volumes: number[]) {
  const smaShort = sma(prices, 20);
  const smaLong = sma(prices, 50);
  const rsiArr = rsi(prices, 14);
  const { macdLine, signalLine, histogram } = macd(prices);
  const bb = bollingerBands(prices, 20, 2);
  const atrArr = atr(highs, lows, prices, 14);
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
  if (bb.upper[i] !== null && bb.lower[i] !== null) {
    if (prices[i] <= bb.lower[i]!) { votes.push('BUY'); reasons.push('Prix sous la bande de Bollinger basse'); }
    else if (prices[i] >= bb.upper[i]!) { votes.push('SELL'); reasons.push('Prix au-dessus de la bande de Bollinger haute'); }
  }

  let volumeConfirms: boolean | null = null;
  if (volumes.length === prices.length && i >= 1) {
    const window = volumes.slice(Math.max(0, i - 20), i);
    const avgVolume = window.reduce((a, b) => a + b, 0) / (window.length || 1);
    volumeConfirms = volumes[i] > avgVolume * 1.2;
    reasons.push(volumeConfirms ? 'Volume supérieur à la moyenne (mouvement confirmé)' : 'Volume faible (signal moins fiable)');
  }

  const buyVotes = votes.filter((v) => v === 'BUY').length;
  const sellVotes = votes.filter((v) => v === 'SELL').length;
  const total = votes.length || 1;
  let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let confidence = 0;
  if (buyVotes > sellVotes) { action = 'BUY'; confidence = buyVotes / total; }
  else if (sellVotes > buyVotes) { action = 'SELL'; confidence = sellVotes / total; }

  if (volumeConfirms === false && action !== 'HOLD') confidence *= 0.8;
  if (volumeConfirms === true && action !== 'HOLD') confidence = Math.min(1, confidence * 1.1);

  const riskLevels = computeRiskLevels(prices[i], atrArr[i], action);

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
      bollingerUpper: bb.upper[i],
      bollingerLower: bb.lower[i],
      atr: atrArr[i],
      volumeConfirms,
    },
    riskLevels,
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
  if (settings.circuit_breaker_triggered) return { autoExecuted: false, reason: 'circuit_breaker_active' };
  if (signal.confidence < settings.auto_mode_threshold) return { autoExecuted: false };

  // Coupe-circuit : si la perte réalisée du jour dépasse le seuil, on désactive le
  // mode auto et on bloque toute nouvelle exécution automatique jusqu'à réactivation manuelle.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: todayExecutions } = await supabase
    .from('executions')
    .select('realized_pnl_usd')
    .gte('created_at', since)
    .not('realized_pnl_usd', 'is', null);

  const dailyPnl = (todayExecutions ?? []).reduce((sum: number, e: { realized_pnl_usd: number }) => sum + e.realized_pnl_usd, 0);
  if (dailyPnl <= -settings.max_daily_loss_usd) {
    await supabase
      .from('bot_settings')
      .update({ circuit_breaker_triggered: true, circuit_breaker_triggered_at: new Date().toISOString(), auto_mode_enabled: false })
      .eq('id', 1);
    return { autoExecuted: false, reason: 'circuit_breaker_triggered_now' };
  }

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
        .select('price, high, low, volume, recorded_at')
        .eq('exchange', exchange)
        .order('recorded_at', { ascending: true })
        .limit(200);

      if (error || !data || data.length < 55) {
        results.push({ exchange, skipped: true, reason: 'Historique insuffisant (min 55 points)' });
        continue;
      }

      const prices = data.map((d: { price: number }) => d.price);
      const highs = data.map((d: { high: number | null }) => d.high ?? d.price ?? 0);
      const lows = data.map((d: { low: number | null }) => d.low ?? d.price ?? 0);
      const volumes = data.map((d: { volume: number | null }) => d.volume ?? 0);
      const signal = buildSignal(prices, highs, lows, volumes);

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
          stop_loss: signal.riskLevels.stopLoss,
          take_profit: signal.riskLevels.takeProfit,
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
