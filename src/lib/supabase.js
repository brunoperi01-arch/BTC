import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Mode démo : si les variables ne sont pas configurées, on n'essaie pas de se connecter
// (ça planterait tout le rendu). App.jsx bascule alors sur des données fictives.
export const DEMO_MODE = !supabaseUrl || !supabaseAnonKey;

export const supabase = DEMO_MODE
  ? null
  : createClient(supabaseUrl, supabaseAnonKey);

