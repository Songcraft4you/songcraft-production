/**
 * Supabase Keep-Alive Ping
 * Verhindert automatisches Pausieren des Supabase Free-Tier Projekts
 * Wird alle 4 Tage automatisch ausgeführt
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ldnhxgbeyberokigerxl.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_u-kXysGRx4PYl9Abr2ZZmw_zg9W7...';

async function pingSupabase() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Supabase Keep-Alive Ping gestartet...`);

  try {
    // Einfacher Health-Check gegen die Supabase REST API
    const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok || response.status === 200 || response.status === 404) {
      console.log(`[${timestamp}] ✅ Supabase Ping erfolgreich! Status: ${response.status}`);
      return true;
    } else {
      console.log(`[${timestamp}] ⚠️ Supabase Ping Status: ${response.status}`);
      return false;
    }
  } catch (error) {
    console.error(`[${timestamp}] ❌ Supabase Ping Fehler:`, error.message);
    return false;
  }
}

module.exports = { pingSupabase };

// Direkt ausführen wenn als Script aufgerufen
if (require.main === module) {
  pingSupabase().then(success => {
    process.exit(success ? 0 : 1);
  });
}
