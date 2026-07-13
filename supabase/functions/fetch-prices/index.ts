// supabase/functions/fetch-prices/index.ts
// Récupère le prix BTC actuel sur Binance + Coinbase (API publiques, pas de clé nécessaire)
// et l'enregistre dans price_history. À appeler périodiquement via Supabase Cron ou Make
// (ex: toutes les 5 minutes).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const rows: Record<string, unknown>[] = [];

    // --- Binance (public, pas de clé) ---
    try {
      const binanceRes = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
      const binanceData = await binanceRes.json();
      rows.push({
        exchange: 'binance',
        symbol: 'BTCUSDT',
        price: parseFloat(binanceData.price),
      });
    } catch (e) {
      console.error('Erreur Binance:', e);
    }

    // --- Coinbase (public, pas de clé) ---
    try {
      const coinbaseRes = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
      const coinbaseData = await coinbaseRes.json();
      rows.push({
        exchange: 'coinbase',
        symbol: 'BTC-USD',
        price: parseFloat(coinbaseData.data.amount),
      });
    } catch (e) {
      console.error('Erreur Coinbase:', e);
    }

    if (rows.length === 0) {
      return new Response(JSON.stringify({ error: 'Aucune donnée récupérée' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { error } = await supabase.from('price_history').insert(rows);
    if (error) throw error;

    return new Response(JSON.stringify({ inserted: rows.length, rows }), {
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
