import { useEffect, useState, useCallback } from 'react';
import { supabase, DEMO_MODE } from './lib/supabase';
import { MOCK_PRICE_DATA, MOCK_SIGNALS, MOCK_EXECUTIONS, MOCK_SETTINGS } from './lib/mockData';
import PriceChart from './components/PriceChart';
import IndicatorPanel from './components/IndicatorPanel';
import SignalCard from './components/SignalCard';

const EXCHANGES = ['binance', 'coinbase'];

export default function App() {
  const [priceData, setPriceData] = useState({ binance: [], coinbase: [] });
  const [signals, setSignals] = useState([]);
  const [executions, setExecutions] = useState([]);
  const [toast, setToast] = useState(null);
  const [settings, setSettings] = useState(null);

  const loadSettings = useCallback(async () => {
    if (DEMO_MODE) { setSettings(MOCK_SETTINGS); return; }
    const { data } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
    setSettings(data);
  }, []);

  const toggleAutoMode = async () => {
    const next = !settings.auto_mode_enabled;
    if (DEMO_MODE) { setSettings((s) => ({ ...s, auto_mode_enabled: next })); return; }
    await supabase.from('bot_settings').update({ auto_mode_enabled: next }).eq('id', 1);
    setSettings((s) => ({ ...s, auto_mode_enabled: next }));
  };

  const updateThreshold = async (value) => {
    setSettings((s) => ({ ...s, auto_mode_threshold: value }));
    if (DEMO_MODE) return;
    await supabase.from('bot_settings').update({ auto_mode_threshold: value }).eq('id', 1);
  };

  const loadPrices = useCallback(async () => {
    if (DEMO_MODE) { setPriceData(MOCK_PRICE_DATA); return; }
    for (const exchange of EXCHANGES) {
      const { data } = await supabase
        .from('price_history')
        .select('price, recorded_at')
        .eq('exchange', exchange)
        .order('recorded_at', { ascending: true })
        .limit(100);
      setPriceData((prev) => ({ ...prev, [exchange]: data ?? [] }));
    }
  }, []);

  const loadSignals = useCallback(async () => {
    if (DEMO_MODE) { setSignals(MOCK_SIGNALS); return; }
    const { data } = await supabase
      .from('signals')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    setSignals(data ?? []);
  }, []);

  const loadExecutions = useCallback(async () => {
    if (DEMO_MODE) { setExecutions(MOCK_EXECUTIONS); return; }
    const { data } = await supabase
      .from('executions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);
    setExecutions(data ?? []);
  }, []);

  useEffect(() => {
    loadPrices();
    loadSignals();
    loadExecutions();
    loadSettings();

    if (DEMO_MODE) return; // pas de polling ni de realtime en démo, données statiques

    // Rafraîchissement automatique toutes les 60s
    const interval = setInterval(() => {
      loadPrices();
      loadSignals();
    }, 60000);

    // Realtime sur les nouveaux signaux
    const channel = supabase
      .channel('signals-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'signals' }, () => {
        loadSignals();
      })
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [loadPrices, loadSignals, loadExecutions, loadSettings]);

  const handleValidate = async (signal) => {
    if (DEMO_MODE) {
      setToast({ type: 'success', message: `[Démo] Ordre ${signal.action} simulé sur ${signal.exchange} — aucune exécution réelle` });
      setSignals((prev) => prev.filter((s) => s.id !== signal.id));
      setTimeout(() => setToast(null), 5000);
      return;
    }
    const { data, error } = await supabase.functions.invoke('execute-order', {
      body: { signal_id: signal.id },
    });
    if (error) {
      setToast({ type: 'error', message: `Échec d'exécution : ${error.message}` });
    } else {
      setToast({ type: 'success', message: `Ordre ${signal.action} exécuté sur ${signal.exchange}` });
    }
    loadSignals();
    loadExecutions();
    setTimeout(() => setToast(null), 5000);
  };

  const handleReject = async (signal) => {
    if (DEMO_MODE) { setSignals((prev) => prev.filter((s) => s.id !== signal.id)); return; }
    await supabase.from('signals').update({ status: 'rejected' }).eq('id', signal.id);
    loadSignals();
  };

  const lastIndicators = (exchange) => {
    const s = signals.find((sig) => sig.exchange === exchange);
    return s?.indicators;
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-4 md:p-8 space-y-6">
      {DEMO_MODE && (
        <div className="rounded-md bg-sky-950 border border-sky-700 text-sky-400 text-sm px-3 py-2">
          Mode démo — données fictives, aucune connexion Supabase, aucun ordre réel n'est exécuté.
        </div>
      )}
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">BTC Trading — Semi-Auto</h1>
          <p className="text-sm text-neutral-500">Binance + Coinbase · validation manuelle avant exécution</p>
        </div>
        <div className="text-xs rounded-full border border-amber-700 bg-amber-950 text-amber-400 px-3 py-1">
          Vérifie le mode testnet/prod dans les secrets Supabase
        </div>
      </header>

      {settings?.circuit_breaker_triggered && (
        <div className="rounded-md bg-red-950 border border-red-700 text-red-400 text-sm px-3 py-2">
          Coupe-circuit déclenché — perte journalière au-delà du seuil, mode auto désactivé automatiquement.
          Réactive-le manuellement dans bot_settings une fois la situation vérifiée.
        </div>
      )}

      {settings && (
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={toggleAutoMode}
              role="switch"
              aria-checked={settings.auto_mode_enabled}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                settings.auto_mode_enabled ? 'bg-emerald-600' : 'bg-neutral-700'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  settings.auto_mode_enabled ? 'translate-x-5' : ''
                }`}
              />
            </button>
            <div>
              <div className="text-sm font-medium text-neutral-200">
                Mode auto {settings.auto_mode_enabled ? 'activé' : 'désactivé'}
              </div>
              <div className="text-xs text-neutral-500">
                Exécute sans validation si confiance ≥ {Math.round(settings.auto_mode_threshold * 100)}%,
                max {settings.max_auto_trades_per_day} trades auto/24h
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-500">Seuil</span>
            <input
              type="range"
              min="0.5"
              max="1"
              step="0.05"
              value={settings.auto_mode_threshold}
              onChange={(e) => updateThreshold(parseFloat(e.target.value))}
              className="w-32"
            />
            <span className="text-xs text-neutral-300 w-10">{Math.round(settings.auto_mode_threshold * 100)}%</span>
          </div>
        </div>
      )}

      {toast && (
        <div className={`rounded-md p-3 text-sm ${toast.type === 'error' ? 'bg-red-950 text-red-400 border border-red-700' : 'bg-emerald-950 text-emerald-400 border border-emerald-700'}`}>
          {toast.message}
        </div>
      )}

      <section className="grid md:grid-cols-2 gap-4">
        {EXCHANGES.map((exchange) => (
          <div key={exchange} className="space-y-3">
            <PriceChart data={priceData[exchange]} exchange={exchange} />
            <IndicatorPanel indicators={lastIndicators(exchange)} />
          </div>
        ))}
      </section>

      <section>
        <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wide mb-3">
          Propositions d'ordre en attente ({signals.length})
        </h2>
        {signals.length === 0 ? (
          <p className="text-sm text-neutral-600">Aucune proposition active — le moteur de signaux tourne en arrière-plan.</p>
        ) : (
          <div className="grid md:grid-cols-2 gap-4">
            {signals.map((signal) => (
              <SignalCard key={signal.id} signal={signal} onValidate={handleValidate} onReject={handleReject} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wide mb-3">Historique récent</h2>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900 divide-y divide-neutral-800">
          {executions.length === 0 && (
            <div className="p-4 text-sm text-neutral-600">Aucun ordre exécuté pour l'instant.</div>
          )}
          {executions.map((exec) => (
            <div key={exec.id} className="p-3 flex items-center justify-between text-sm">
              <div className="flex items-center gap-3">
                <span className={exec.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}>{exec.side}</span>
                <span className="text-neutral-500">{exec.exchange}</span>
                <span>${exec.amount}</span>
                {exec.auto_executed && (
                  <span className="text-[10px] uppercase rounded border border-sky-700 text-sky-400 px-1.5 py-0.5">auto</span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className={
                  exec.status === 'filled' ? 'text-emerald-500' : exec.status === 'failed' ? 'text-red-500' : 'text-neutral-500'
                }>
                  {exec.status}
                </span>
                <span className="text-neutral-600 text-xs">
                  {new Date(exec.created_at).toLocaleString('fr-FR')}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
