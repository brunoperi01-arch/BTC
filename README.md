# BTC Trading Bot — Semi-Auto (Binance + Coinbase)

Bot de trading BTC semi-automatique : moteur d'indicateurs techniques (RSI, MACD, SMA20/50)
qui propose des ordres, que tu valides manuellement avant exécution réelle sur Binance et/ou Coinbase.

**Aucune recommandation d'investissement n'est intégrée à cet outil.** Les signaux sont générés
par une logique de vote sur 3 indicateurs, transparente et documentée dans `src/lib/indicators.js` —
ce n'est pas un conseil financier, c'est un outil d'aide à la décision que tu contrôles entièrement.

---

## ⚠️ Avant de mettre de l'argent réel

1. **Démarre sur testnet.** `USE_TESTNET=true` par défaut dans `execute-order`. Teste tout le
   flux (génération de signal → validation → exécution) sur testnet Binance avant de basculer en prod.
   Compte testnet Binance : https://testnet.binance.vision/
2. **Clés API scopées au strict minimum** : coche uniquement *Enable Reading* et *Enable Spot Trading*.
   Ne coche **jamais** *Enable Withdrawals* sur les clés utilisées par ce bot.
3. **Restreins l'IP** sur la clé API Binance (Supabase Edge Functions ont des IP sortantes fixes en
   plan payant — sinon laisse en "unrestricted" mais surveille les logs).
4. **`MAX_ORDER_USD`** (secret) plafonne le montant proposé par signal — commence bas (ex: 20-50 USD)
   le temps de valider que la logique te convient.

---

## 1. Setup Supabase

```bash
# Créer le projet Supabase en région EU (eu-central-1 ou eu-west-1) — obligatoire RGPD
npx supabase init
npx supabase link --project-ref <ton-project-ref>

# Appliquer le schéma
npx supabase db push
# ou directement : coller supabase/schema.sql dans le SQL Editor du dashboard Supabase
```

### Secrets Edge Functions (JAMAIS dans le code, JAMAIS côté client)

```bash
npx supabase secrets set BINANCE_API_KEY=xxx
npx supabase secrets set BINANCE_API_SECRET=xxx
npx supabase secrets set USE_TESTNET=true
npx supabase secrets set MAX_ORDER_USD=50

# Coinbase — voir section "Finaliser Coinbase" ci-dessous avant de les utiliser en prod
npx supabase secrets set COINBASE_API_KEY=xxx
npx supabase secrets set COINBASE_API_SECRET=xxx
```

### Déployer les Edge Functions

```bash
npx supabase functions deploy fetch-prices
npx supabase functions deploy generate-signal
npx supabase functions deploy execute-order
```

### Planifier l'exécution périodique

Deux options :
- **Supabase Cron** (pg_cron, dans le SQL Editor) :
```sql
select cron.schedule('fetch-prices-5min', '*/5 * * * *',
  $$select net.http_post('https://<ref>.supabase.co/functions/v1/fetch-prices', headers:='{"Authorization": "Bearer <service_role_key>"}'::jsonb)$$);

select cron.schedule('generate-signal-15min', '*/15 * * * *',
  $$select net.http_post('https://<ref>.supabase.co/functions/v1/generate-signal', headers:='{"Authorization": "Bearer <service_role_key>"}'::jsonb)$$);
```
- **Make** (cohérent avec ton stack existant) : deux scénarios avec un module "HTTP Request"
  en POST vers les URLs des Edge Functions, déclenchés par un scheduler (5 min / 15 min).

---

## 2. Setup Frontend

```bash
npm install
cp .env.example .env
# Remplir VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY (valeurs publiques, sans risque)
npm run dev
```

Déploiement Vercel : connecter le repo GitHub, ajouter les deux variables d'environnement
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` dans les settings Vercel. Aucune clé exchange
ne doit jamais apparaître dans les variables d'environnement Vercel — elles restent 100% côté
Supabase Edge Functions.

Il te faudra aussi activer **Supabase Auth** (email/password suffit pour un usage solo) et
te connecter dans l'app, puisque les policies RLS n'autorisent que le rôle `authenticated`.

---

## 3. Finaliser Coinbase

L'exécution Coinbase (`execute-order/index.ts`, fonction `executeCoinbaseOrder`) est
**volontairement non finalisée** dans cette version : l'API Advanced Trade de Coinbase utilise
une signature JWT (Cloud API Key), différente du HMAC classique de Binance, et nécessite que tu
génères une paire de clés Cloud API depuis https://www.coinbase.com/settings/api. Dis-moi quand
tu as ces clés et je complète la fonction — je préfère ne pas deviner un format de signature
pour une route qui déplace de l'argent réel.

D'ici là, le dashboard affichera bien les signaux Coinbase (lecture seule, API publique), mais
toute tentative de validation d'un signal Coinbase renverra une erreur explicite.

---

---

## Structures de trading ajoutées

Le moteur de signal (`src/lib/indicators.js` + `generate-signal`) combine maintenant :

| Indicateur | Rôle | Type de vote |
|---|---|---|
| SMA20/50 | Tendance (golden/death cross) | Directionnel |
| RSI(14) | Momentum / survente-surachat | Directionnel |
| MACD | Momentum / croisement | Directionnel |
| Bollinger Bands(20,2) | Extrême statistique | Directionnel |
| Volume (vs moyenne 20 périodes) | Confirmation | Multiplie la confiance (×0.8 à ×1.1), ne vote pas seul |
| ATR(14) | Volatilité | Sert à calculer stop-loss/take-profit, pas un vote |

**⚠️ Stop-loss / take-profit affichés = indicatifs, pas placés sur l'exchange.**
`execute-order` envoie un ordre MARKET simple. Les niveaux `stop_loss`/`take_profit`
calculés via ATR (1.5x / 2.5x) sont stockés et affichés pour t'aider à décider, mais
**aucun ordre stop n'est automatiquement posé chez Binance/Coinbase**. Si tu veux une
vraie protection automatique, il faut ajouter un ordre OCO (`STOP_LOSS_LIMIT` +
`TAKE_PROFIT_LIMIT` groupés) juste après le fill — je peux l'ajouter si tu veux, mais
ça complexifie la gestion des annulations/timeouts.

### Coupe-circuit (circuit breaker)

`bot_settings.max_daily_loss_usd` (défaut 50 USD) : si le P&L réalisé cumulé des dernières
24h descend sous `-max_daily_loss_usd`, `generate-signal` désactive automatiquement
`auto_mode_enabled` et pose `circuit_breaker_triggered = true`. Le dashboard affiche
un bandeau rouge. **Il faut le réactiver manuellement** (mettre `circuit_breaker_triggered`
à `false` dans Supabase ou via le dashboard) — volontairement pas d'auto-réactivation.

Le P&L réalisé est calculé en moyenne pondérée globale des achats (pas un vrai FIFO par
lot) — suffisant pour un usage solo BTC-only, mais à savoir si tu compares à un outil
de comptabilité fiscale plus tard.

## 4. Ce qui manque encore pour une vraie mise en prod

- **Gestion du solde disponible** : le bot ne vérifie pas ton solde avant de proposer un ordre.
  À ajouter dans `generate-signal` (appel `GET /api/v3/account` sur Binance) si tu veux éviter
  les signaux impossibles à exécuter.
- **Stop-loss / take-profit** : non implémenté. La logique actuelle est uniquement
  "signal d'entrée/sortie", pas de gestion de position automatisée.
- **Logs d'audit** : la table `executions` garde une trace, mais pas d'alerting (ex: notification
  Make/Telegram en cas d'échec d'exécution) — facile à ajouter si tu veux.
- **Coinbase JWT** (voir ci-dessus).

## Structure du projet

```
src/
  lib/indicators.js       → calcul RSI/MACD/SMA (réutilisé aussi côté Edge Function)
  lib/supabase.js         → client Supabase (clé anon uniquement)
  components/             → PriceChart, IndicatorPanel, SignalCard
  App.jsx                 → dashboard principal, realtime sur les signaux

supabase/
  schema.sql               → tables + RLS (aucune clé API en base)
  functions/fetch-prices/   → ping prix Binance+Coinbase toutes les 5 min
  functions/generate-signal/→ calcule les indicateurs, propose un ordre toutes les 15 min
  functions/execute-order/  → exécute l'ordre validé (seule fonction qui touche aux clés exchange)
```
