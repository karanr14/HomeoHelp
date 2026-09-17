// api/config.js — public account configuration
// Only public Supabase project values are returned. Never expose a service-role key here.

module.exports = function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({
      error: "Supabase is not configured. Add SUPABASE_URL and SUPABASE_ANON_KEY to your environment variables."
    });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ supabaseUrl, supabaseAnonKey });
};
