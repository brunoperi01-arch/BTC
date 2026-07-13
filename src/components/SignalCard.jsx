import { useState } from 'react';

const ACTION_STYLES = {
  BUY: { bg: 'bg-emerald-950', border: 'border-emerald-600', text: 'text-emerald-400', label: 'ACHAT' },
  SELL: { bg: 'bg-red-950', border: 'border-red-600', text: 'text-red-400', label: 'VENTE' },
};

export default function SignalCard({ signal, onValidate, onReject }) {
  const [loading, setLoading] = useState(false);
  const style = ACTION_STYLES[signal.action] ?? ACTION_STYLES.BUY;
  const expiresIn = Math.max(0, Math.round((new Date(signal.expires_at) - new Date()) / 60000));

  const handleValidate = async () => {
    setLoading(true);
    try {
      await onValidate(signal);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`rounded-lg border ${style.border} ${style.bg} p-4 space-y-3`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-bold tracking-wide ${style.text}`}>{style.label}</span>
          <span className="text-xs text-neutral-400 uppercase">{signal.exchange}</span>
        </div>
        <span className="text-xs text-neutral-500">expire dans {expiresIn} min</span>
      </div>

      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-2xl font-semibold text-neutral-100">
            ${signal.suggested_amount?.toFixed(2)}
          </div>
          <div className="text-xs text-neutral-500">
            au prix ~${signal.indicators?.price?.toLocaleString('fr-FR', { maximumFractionDigits: 0 })}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-neutral-500">confiance</div>
          <div className={`text-sm font-medium ${style.text}`}>
            {Math.round(signal.confidence * 100)}%
          </div>
        </div>
      </div>

      <ul className="text-xs text-neutral-400 space-y-1">
        {signal.reasons?.map((r, idx) => (
          <li key={idx}>• {r}</li>
        ))}
      </ul>

      <div className="flex gap-2 pt-1">
        <button
          onClick={handleValidate}
          disabled={loading}
          className={`flex-1 rounded-md py-2 text-sm font-medium text-white ${
            signal.action === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'
          } disabled:opacity-50 transition-colors`}
        >
          {loading ? 'Exécution…' : `Valider ${style.label.toLowerCase()}`}
        </button>
        <button
          onClick={() => onReject(signal)}
          disabled={loading}
          className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-400 hover:bg-neutral-800 transition-colors"
        >
          Rejeter
        </button>
      </div>
    </div>
  );
}
